package cmd

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
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
	} else {
		fmt.Printf("  ⚠ No star assigned\n")
	}

	// Step 3: Write TS runtime
	step++
	fmt.Printf("\n[%d] TS runtime\n", step)
	tsDir, err := writeTSRuntime()
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
func writeTSRuntime() (string, error) {
	dataDir := getShareDir()
	tsDir := filepath.Join(dataDir, "ts-runtime")

	// Clean and recreate
	os.RemoveAll(tsDir)
	if err := os.MkdirAll(tsDir, 0755); err != nil {
		return "", fmt.Errorf("create ts-runtime dir: %w", err)
	}

	count := 0
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

	_ = count
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

// symlinkStellarModule creates node_modules/stellario → ts-runtime symlink.
func symlinkStellarModule(opencodeDir, tsDir string) error {
	modulesDir := filepath.Join(opencodeDir, "node_modules")
	stellarioLink := filepath.Join(modulesDir, "stellario")

	// Remove existing (symlink or real dir)
	os.Remove(stellarioLink)
	os.RemoveAll(stellarioLink)

	if err := os.MkdirAll(modulesDir, 0755); err != nil {
		return err
	}

	return os.Symlink(tsDir, stellarioLink)
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
