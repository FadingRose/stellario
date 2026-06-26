// =============================================================================
// Stellario — Generic LSP Client
// =============================================================================
// JSON-RPC 2.0 over stdio client for Language Server Protocol.
// Language-agnostic — works with any LSP-compliant server.
// Singleton per server name, managed by LspManager.

import { spawn, type ChildProcess } from "child_process"
import { existsSync, readFileSync } from "fs"
import { resolve, relative } from "path"
import type {
  LspPosition,
  LspLocation,
  LspSymbolInfo,
  LspClientState,
  LspServerConfig,
} from "./types.js"

// ─── JSON-RPC Plumbing ───────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ─── LspClient ───────────────────────────────────────────────────────────────

export class LspClient {
  // Process
  private proc: ChildProcess | null = null
  private requestId = 0
  private buffer = ""
  private pending = new Map<number, PendingRequest>()

  // State (sync-readable for buildStatus)
  private _state: LspClientState = "idle"
  private _stateDetail: string = ""
  private _startTime = 0
  private _rootPath = ""

  // Config
  private config: LspServerConfig

  constructor(config: LspServerConfig) {
    this.config = config
  }

  // ── Sync State Accessors ──

  get state(): LspClientState { return this._state }
  get stateDetail(): string { return this._stateDetail }
  get elapsedMs(): number {
    return this._startTime > 0 ? Date.now() - this._startTime : 0
  }

  // ── Lifecycle ──

  /**
   * Start the LSP server process and perform initialization handshake.
   * Does NOT block — returns a promise that resolves when ready.
   * Callers should check `state` before making requests.
   */
  async start(rootPath: string): Promise<void> {
    if (this._state === "ready" || this._state === "starting") return

    this._rootPath = resolve(rootPath)
    this._state = "starting"
    this._stateDetail = "spawning"
    this._startTime = Date.now()

    const command = this.config.command
    if (!command || command.length === 0) {
      this._state = "error"
      this._stateDetail = "no command configured"
      return
    }

    try {
      await this.doStart()
    } catch (err: any) {
      this._state = "error"
      this._stateDetail = err.message || "unknown error"
    }
  }

  private async doStart(): Promise<void> {
    const command = this.config.command

    return new Promise<void>((resolve, reject) => {
      const indexingConfig = this.config.indexing || {}
      const strategy = indexingConfig.strategy || "timeout"
      const timeout = indexingConfig.timeout || 30000

      // Guard against settle-after-reject: overallTimeout may fire while
      // waitForIndexing's internal setTimeout is still pending, causing the
      // then-callback to overwrite state to "ready" after shutdown.
      let settled = false
      const doResolve = () => { if (!settled) { settled = true; resolve() } }
      const doReject = (err: Error) => { if (!settled) { settled = true; reject(err) } }

      const overallTimeout = setTimeout(() => {
        doReject(new Error("LSP initialization timeout"))
        this.shutdown()
      }, timeout + 5000)  // grace period beyond indexing wait

      // ── Spawn ──
      this._stateDetail = `spawning: ${command.join(" ")}`

      this.proc = spawn(command[0], command.slice(1), {
        cwd: this._rootPath,
        stdio: ["pipe", "pipe", "pipe"],
      })

      if (!this.proc.stdin || !this.proc.stdout || !this.proc.stderr) {
        clearTimeout(overallTimeout)
        doReject(new Error("Failed to create stdio pipes"))
        return
      }

      this.proc.stdout.on("data", (data: Buffer) => {
        this.buffer += data.toString()
        this.processBuffer()
      })

      this.proc.stderr.on("data", () => {
        // Silently ignore debug output
      })

      this.proc.on("close", () => {
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timeout)
          entry.reject(new Error("LSP process closed unexpectedly"))
        }
        this.pending.clear()
        this.proc = null
        if (this._state === "starting") {
          this._state = "crashed"
          this._stateDetail = "process closed during startup"
          clearTimeout(overallTimeout)
          doReject(new Error("LSP process closed during startup"))
        } else if (this._state === "ready") {
          this._state = "crashed"
          this._stateDetail = "process closed"
        }
      })

      this.proc.on("error", (err) => {
        clearTimeout(overallTimeout)
        this._state = "error"
        this._stateDetail = `process error: ${err.message}`
        doReject(err)
      })

      // ── Initialize ──
      this._stateDetail = "initializing"

      this.sendRequest("initialize", {
        processId: null,
        rootUri: `file://${this._rootPath}`,
        capabilities: {
          textDocument: {
            references: { dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            callHierarchy: { dynamicRegistration: false },
          },
          workspace: {
            symbol: { dynamicRegistration: false },
          },
        },
        workspaceFolders: null,
      }).then(async () => {
        if (settled) return  // already rejected (e.g. overallTimeout)
        this.sendNotification("initialized", {})
        this._stateDetail = "indexing"

        // ── Wait for indexing ──
        await this.waitForIndexing(strategy, timeout)

        this._state = "ready"
        this._stateDetail = ""
        clearTimeout(overallTimeout)
        doResolve()
      }).catch((err) => {
        clearTimeout(overallTimeout)
        doReject(err)
      })
    })
  }

  private async waitForIndexing(strategy: string, timeout: number): Promise<void> {
    const config = this.config.indexing || {}

    switch (strategy) {
      case "poll-symbol": {
        const query = config.pollQuery || "main"
        const interval = config.pollInterval || 2000
        const deadline = Date.now() + timeout

        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, interval))
          try {
            const result = await this.sendRequest("workspace/symbol", { query }, 5000)
            if (result && Array.isArray(result) && result.length > 0) {
              return // indexed
            }
          } catch {
            // Timeout — keep trying
          }
        }
        // Timeout expired — proceed anyway
        break
      }

      case "timeout": {
        // Just wait a fixed time after initialized notification
        const waitTime = Math.min(config.timeout || 10000, timeout)
        await new Promise(r => setTimeout(r, waitTime))
        break
      }

      case "none":
      default:
        // No waiting — ready immediately after initialized
        break
    }
  }

  // ── JSON-RPC ──

  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) break

      const header = this.buffer.slice(0, headerEnd)
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i)
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }

      const contentLength = parseInt(contentLengthMatch[1], 10)
      const messageStart = headerEnd + 4
      const messageEnd = messageStart + contentLength

      if (this.buffer.length < messageEnd) break

      const message = this.buffer.slice(messageStart, messageEnd)
      this.buffer = this.buffer.slice(messageEnd)

      try {
        const msg = JSON.parse(message)
        this.handleMessage(msg)
      } catch {
        // Invalid JSON — skip
      }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pending.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(msg.error.message || "LSP error"))
        } else {
          pending.resolve(msg.result)
        }
      }
    }
    // Notifications are ignored
  }

  private sendMessage(content: object): void {
    if (!this.proc?.stdin) {
      throw new Error("LSP process not running")
    }
    const json = JSON.stringify(content)
    const message = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
    this.proc.stdin.write(message)
  }

  private sendRequest(method: string, params: any, timeoutMs: number = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request ${method} timed out (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timeout })

      this.sendMessage({
        jsonrpc: "2.0",
        id,
        method,
        params,
      })
    })
  }

  private sendNotification(method: string, params: any): void {
    this.sendMessage({
      jsonrpc: "2.0",
      method,
      params,
    })
  }

  // ── Public Request Interface ──

  /**
   * Send an LSP request. Throws if client is not ready.
   */
  async request(method: string, params: any, timeoutMs: number = 30000): Promise<any> {
    if (this._state === "starting") {
      throw new Error(`LSP indexing... (${this.formatElapsed()})`)
    }
    if (this._state !== "ready" || !this.proc) {
      // Proc can be null while state is still "ready" if the exit/close
      // event hasn't fired yet. Self-heal to crashed.
      if (!this.proc && this._state === "ready") {
        this._state = "crashed"
        this._stateDetail = "process exited (detected on request)"
      }
      throw new Error(`LSP not available (state: ${this._state})`)
    }
    return this.sendRequest(method, params, timeoutMs)
  }

  // ── Shutdown ──

  async shutdown(): Promise<void> {
    if (!this.proc) return

    try {
      await this.sendRequest("shutdown", {}, 5000)
      this.sendNotification("exit", {})
    } catch {
      // Ignore shutdown errors
    }

    setTimeout(() => {
      if (this.proc) {
        this.proc.kill()
        this.proc = null
      }
    }, 100)

    this.proc = null
    this._state = "idle"
    this._stateDetail = ""
  }

  // ── LSP Operations ──

  async findReferences(uri: string, line: number, character: number): Promise<LspLocation[]> {
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    })
    if (!result || !Array.isArray(result)) return []
    return result
  }

  async gotoDefinition(uri: string, line: number, character: number): Promise<LspLocation[]> {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    })
    if (!result) return []
    if (Array.isArray(result)) return result
    return [result]
  }

  async workspaceSymbol(query: string): Promise<LspSymbolInfo[]> {
    const result = await this.request("workspace/symbol", { query })
    if (!result || !Array.isArray(result)) return []
    return result
  }

  async prepareCallHierarchy(uri: string, line: number, character: number): Promise<any[]> {
    const result = await this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri },
      position: { line, character },
    })
    if (!result) return []
    return Array.isArray(result) ? result : [result]
  }

  async incomingCalls(item: any): Promise<any[]> {
    const result = await this.request("callHierarchy/incomingCalls", { item })
    return result || []
  }

  async outgoingCalls(item: any): Promise<any[]> {
    const result = await this.request("callHierarchy/outgoingCalls", { item })
    return result || []
  }

  // ── Helpers ──

  private formatElapsed(): string {
    const sec = Math.floor(this.elapsedMs / 1000)
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
  }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Convert file:// URI to absolute file path.
 * Handles macOS/Linux only (no Windows support).
 */
export function uriToFilePath(uri: string): string {
  if (uri.startsWith("file:///")) {
    return decodeURIComponent(uri.slice(7))
  }
  if (uri.startsWith("file://")) {
    const after = uri.slice(7)
    const slashIdx = after.indexOf("/")
    return slashIdx !== -1
      ? decodeURIComponent(after.slice(slashIdx))
      : decodeURIComponent(after)
  }
  return uri
}

/**
 * Read a single line from a file for context display.
 */
export function readFileContext(filePath: string, line: number): string {
  try {
    const content = readFileSync(filePath, "utf-8")
    const lines = content.split("\n")
    if (line >= 0 && line < lines.length) {
      return lines[line].trim()
    }
  } catch {
    // Ignore file read errors
  }
  return ""
}
