package cmd

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"stellario/engine/cluster"
	"stellario/engine/embedfs"
)

// ─── Setup ───────────────────────────────────────────────────────────────────

// RunSetup performs the initial bootstrap:
// 1. Initialize global library (~/.stellario/)
// 2. Assign star name
// 3. Write embedded TS runtime to ~/.local/share/stellario/
// 4. Write opencode agent prompt (tools defined but disabled by default)
// 5. Write glue files to opencode tools (disabled by default)
// 6. Symlink node_modules/stellario → TS runtime
// 7. Write spec/ diagnostic rules
func RunSetup() int {
	return RunSetupWithVersion("dev")
}

// RunSetupWithVersion is the real entry point, called from main with ldflags version.
func RunSetupWithVersion(version string) int {
	fmt.Println("Stellario Setup")
	fmt.Println("═══════════════════════════════════════════════════════")

	step := 0

	// Step 1: Global library
	step++
	fmt.Printf("\n[%d] Global library\n", step)
	gInit, err := cluster.InitGlobal()
	if err != nil {
		fmt.Printf("  ✗ Error: %v\n", err)
		return 1
	}
	if gInit.Created {
		fmt.Printf("  ✓ Initialized: %s\n", cluster.GlobalDir())
	} else {
		fmt.Printf("  ✓ Already exists: %s\n", cluster.GlobalDir())
	}

	// Pull remote changes before star assignment — ensures we see
	// stars already claimed by other devices.
	pullRemoteConstellation()

	// Step 2: Star name
	step++
	fmt.Printf("\n[%d] Device identity\n", step)
	dev, err := cluster.GetOrCreateDeviceID()
	if err != nil {
		fmt.Printf("  ✗ Error: %v\n", err)
		return 1
	}
	if dev.Star != "" {
		fmt.Printf("  ⋆ Star: %s (%s)\n", dev.Star, dev.ID)
		// Push constellation update so other devices see this star is taken
		pushConstellationUpdate()
	} else {
		fmt.Printf("  ⚠ No star assigned\n")
	}

	// Step 3: Write TS runtime
	step++
	fmt.Printf("\n[%d] TS runtime\n", step)
	tsDir, err := writeTSRuntime(version)
	if err != nil {
		fmt.Printf("  ✗ Error: %v\n", err)
		return 1
	}
	fmt.Printf("  ✓ Written to: %s\n", tsDir)

	// Step 4: Opencode integration
	step++
	fmt.Printf("\n[%d] Opencode integration\n", step)
	opencodeDir := getOpencodeDir()
	if opencodeDir == "" {
		fmt.Printf("  ⚠ Opencode config directory not found\n")
		fmt.Printf("    Skipped — run setup again after installing opencode\n")
	} else {
		// Write agent prompt
		agentPath, err := writeAgentPrompt(opencodeDir)
		if err != nil {
			fmt.Printf("  ✗ Agent prompt: %v\n", err)
		} else {
			fmt.Printf("  ✓ Agent: %s\n", agentPath)
		}

		// Write glue tools (disabled by default)
		toolsCount, err := writeGlueTools(opencodeDir, tsDir)
		if err != nil {
			fmt.Printf("  ✗ Glue tools: %v\n", err)
		} else {
			fmt.Printf("  ✓ Tools: %d files (disabled by default)\n", toolsCount)
		}

		// Symlink node_modules/stellario → TS runtime
		err = symlinkStellarModule(opencodeDir, tsDir)
		if err != nil {
			fmt.Printf("  ⚠ node_modules symlink: %v\n", err)
		} else {
			fmt.Printf("  ✓ Module: stellario → %s\n", tsDir)
		}
	}

	// Step 5: Spec files
	step++
	fmt.Printf("\n[%d] Diagnostic specs\n", step)
	specCount, err := writeSpecs()
	if err != nil {
		fmt.Printf("  ⚠ Specs: %v\n", err)
	} else {
		fmt.Printf("  ✓ %d spec files written\n", specCount)
	}

	// Done
	fmt.Println()
	fmt.Println("═══════════════════════════════════════════════════════")
	fmt.Println()
	fmt.Println("Setup complete!")
	fmt.Println()
	fmt.Println("Next steps:")
	if opencodeDir != "" {
		fmt.Println("  1. Open opencode")
		fmt.Println("  2. Switch to the Stellario agent")
		fmt.Println("  3. She'll guide you from there")
	} else {
		fmt.Println("  Install opencode, then run 'stellario setup' again")
	}
	fmt.Println()
	fmt.Println("To remove Stellario:")
	fmt.Println("  rm ~/.config/opencode/agent/stellario.md")
	fmt.Println("  rm -rf ~/.local/share/stellario/")
	fmt.Println("  (Your memory at ~/.stellario/ is preserved)")

	return 0
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// writeTSRuntime extracts the embedded TS source to the runtime location.
// Also generates a package.json with the correct exports map for module resolution.
func writeTSRuntime(version string) (string, error) {
	dataDir := getShareDir()
	tsDir := filepath.Join(dataDir, "ts-runtime")

	// Clean and recreate
	os.RemoveAll(tsDir)
	if err := os.MkdirAll(tsDir, 0755); err != nil {
		return "", fmt.Errorf("create ts-runtime dir: %w", err)
	}

	err := fs.WalkDir(embedfs.Files, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		// Skip the embed.go file itself
		if path == "embed.go" {
			return nil
		}

		data, err := embedfs.Files.ReadFile(path)
		if err != nil {
			return err
		}

		dest := filepath.Join(tsDir, path)
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return err
		}

		return os.WriteFile(dest, data, 0644)
	})
	if err != nil {
		return "", fmt.Errorf("write TS source: %w", err)
	}

	// Generate package.json with exports map.
	pkgJSON := `{
  "name": "stellario",
  "version": "` + version + `",
  "description": "Agent memory infrastructure",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./defs/memory": "./src/defs/memory-defs.ts",
    "./defs/telescope": "./src/defs/telescope-defs.ts",
    "./defs/workspace": "./src/defs/workspace-defs.ts",
    "./defs/coordination": "./src/defs/coordination-defs.ts",
    "./defs/lsp": "./src/defs/lsp-defs.ts",
    "./defs/ast-grep": "./src/defs/ast-grep-defs.ts",
    "./defs/volume-link": "./src/defs/volume-link-defs.ts",
    "./config": "./src/config.ts",
    "./store": "./src/store.ts",
    "./permissions": "./src/permissions.ts",
    "./types": "./src/types.ts",
    "./embedding": "./src/embedding.ts",
    "./coord/types": "./src/coord/types.ts",
    "./coord/lock": "./src/coord/lock.ts",
    "./coord/store": "./src/coord/store.ts",
    "./lsp/types": "./src/lsp/types.ts",
    "./lsp/client": "./src/lsp/client.ts",
    "./lsp/manager": "./src/lsp/manager.ts",
    "./index-worker": "./src/index-worker.ts",
    "./context": "./src/context.ts",
    "./auto-refs": "./src/auto-refs.ts",
    "./git": "./src/git.ts"
  }
}
`
	pkgPath := filepath.Join(tsDir, "package.json")
	if err := os.WriteFile(pkgPath, []byte(pkgJSON), 0644); err != nil {
		return "", fmt.Errorf("write package.json: %w", err)
	}

	return tsDir, nil
}

// writeAgentPrompt writes the Stellario agent .md to opencode's agent directory.
func writeAgentPrompt(opencodeDir string) (string, error) {
	agentDir := filepath.Join(opencodeDir, "agent")
	if err := os.MkdirAll(agentDir, 0755); err != nil {
		return "", err
	}

	agentPath := filepath.Join(agentDir, "stellario.md")

	// Read from embedded templates
	data, err := embedfs.Files.ReadFile("templates/stellario-agent.md")
	if err != nil {
		return "", fmt.Errorf("read agent template: %w", err)
	}

	return agentPath, os.WriteFile(agentPath, data, 0644)
}

// writeGlueTools writes the opencode tool glue files.
// These are written but the agent .md frontmatter controls which tools are enabled.
// Other agents won't see stellario tools unless they explicitly enable them.
func writeGlueTools(opencodeDir, tsDir string) (int, error) {
	toolsDir := filepath.Join(opencodeDir, "tools")
	if err := os.MkdirAll(toolsDir, 0755); err != nil {
		return 0, err
	}

	// Map: embedded glue file → output filename
	glueMap := map[string]string{
		"memory.ts":       "stellario-memory.ts",
		"telescope.ts":    "stellario-telescope.ts",
		"workspace.ts":    "stellario-workspace.ts",
		"volume-link.ts":  "stellario-volume-link.ts",
		"coordination.ts": "stellario-coordination.ts",
		"lsp.ts":          "stellario-lsp.ts",
		"ast-grep.ts":     "stellario-ast-grep.ts",
	}

	count := 0
	for src, dst := range glueMap {
		data, err := embedfs.Files.ReadFile("glue/" + src)
		if err != nil {
			continue // Skip missing files
		}

		dest := filepath.Join(toolsDir, dst)
		if err := os.WriteFile(dest, data, 0644); err != nil {
			return count, err
		}
		count++
	}

	// Also write the plugin injector
	pluginData, err := embedfs.Files.ReadFile("glue/plugin.ts")
	if err == nil {
		pluginDir := filepath.Join(opencodeDir, "plugin")
		os.MkdirAll(pluginDir, 0755)
		os.WriteFile(filepath.Join(pluginDir, "stellario-inject.ts"), pluginData, 0644)
	}

	return count, nil
}

// symlinkStellarModule installs stellario's TS runtime directly into opencode's
// node_modules/stellario/. This is NOT a symlink — files are copied so that
// Node's upward module resolution naturally finds zod/yaml in the parent
// node_modules (opencode's dependencies).
func symlinkStellarModule(opencodeDir, tsDir string) error {
	targetDir := filepath.Join(opencodeDir, "node_modules", "stellario")

	// Remove existing (symlink or real dir)
	os.Remove(targetDir)
	os.RemoveAll(targetDir)

	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return err
	}

	// Copy all files from tsDir to targetDir
	return filepath.Walk(tsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		rel, err := filepath.Rel(tsDir, path)
		if err != nil {
			return err
		}

		dest := filepath.Join(targetDir, rel)

		if info.IsDir() {
			return os.MkdirAll(dest, 0755)
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0644)
	})
}

// writeSpecs writes the diagnostic spec files to ~/.stellario/spec/.
func writeSpecs() (int, error) {
	specDir := filepath.Join(cluster.GlobalDir(), "spec")
	if err := os.MkdirAll(specDir, 0755); err != nil {
		return 0, err
	}

	// For now, write a placeholder. Actual spec content will be added later.
	specs := map[string]string{
		"README.md": "# Stellario Specs\n\nDiagnostic rules for memory health checks.\nStellario reads these to know what \"correct\" looks like.\n",
	}

	count := 0
	for name, content := range specs {
		path := filepath.Join(specDir, name)
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return count, err
		}
		count++
	}

	return count, nil
}

// getOpencodeDir returns the opencode config directory.
func getOpencodeDir() string {
	// Check XDG config home first
	xdg := os.Getenv("XDG_CONFIG_HOME")
	if xdg != "" {
		dir := filepath.Join(xdg, "opencode")
		if _, err := os.Stat(dir); err == nil {
			return dir
		}
	}

	// Fallback to ~/.config/opencode
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(home, ".config", "opencode")
	if _, err := os.Stat(dir); err != nil {
		return ""
	}
	return dir
}

// getShareDir returns the data directory for stellario runtime files.
func getShareDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".stellario-runtime"
	}

	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		// XDG data home or ~/.local/share
		xdg := os.Getenv("XDG_DATA_HOME")
		if xdg != "" {
			return filepath.Join(xdg, "stellario")
		}
		return filepath.Join(home, ".local", "share", "stellario")
	}

	// Windows fallback
	return filepath.Join(home, ".stellario-runtime")
}

// Ensure embedfs is used (prevents unused import if build tags exclude it)
var _ embed.FS
var _ = embedfs.Files

// pullRemoteConstellation does a git pull on the global library before
// star assignment. This ensures the constellation registry is up-to-date
// with stars claimed by other devices.
//
// Silently skips if no remote configured or network unavailable.
func pullRemoteConstellation() {
	globalDir := cluster.GlobalDir()

	// Check if remote exists
	cmd := exec.Command("git", "remote", "get-url", "origin")
	cmd.Dir = globalDir
	if err := cmd.Run(); err != nil {
		return // no remote — first device, nothing to pull
	}

	// Check if there are any commits (empty repo can't pull)
	cmd = exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = globalDir
	if err := cmd.Run(); err != nil {
		return // no commits yet
	}

	// Pull with rebase
	cmd = exec.Command("git", "pull", "--rebase", "origin", "HEAD")
	cmd.Dir = globalDir
	cmd.Stdout = nil
	cmd.Stderr = nil
	_ = cmd.Run() // silent — failures are expected (no remote, network down)
}

// pushConstellationUpdate commits and pushes the constellation registry
// after a new star is assigned. This claims the star so other devices
// won't take it.
//
// Silently skips if no remote configured or network unavailable.
func pushConstellationUpdate() {
	globalDir := cluster.GlobalDir()

	// Stage constellation
	cmd := exec.Command("git", "add", ".constellation.json")
	cmd.Dir = globalDir
	cmd.Run()

	// Commit (may be no-op if unchanged)
	cmd = exec.Command("git", "commit", "-m", "constellation: star assignment update")
	cmd.Dir = globalDir
	cmd.Run()

	// Push
	cmd = exec.Command("git", "push", "origin", "HEAD")
	cmd.Dir = globalDir
	cmd.Stdout = nil
	cmd.Stderr = nil
	_ = cmd.Run() // silent
}
