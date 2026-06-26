package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"stellario/engine/cluster"
	"stellario/engine/config"
)

// ─── Config Commands ─────────────────────────────────────────────────────────

// RunConfigShow prints the merged effective config for a project.
// If no --project specified, shows the config from cwd.
func RunConfigShow(projectRoot string) int {
	vres, err := config.LoadAndValidate(projectRoot)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	cfg := vres.Config
	fmt.Printf("Config: %s\n", projectRoot)
	fmt.Printf("  memoryDir: %s\n", cfg.MemoryDir)
	fmt.Println()
	fmt.Println("Volumes:")
	for name, vol := range cfg.Volumes {
		isSystem := config.IsSystemVolume(name)
		systemTag := ""
		if isSystem {
			systemTag = " (system)"
		}
		fmt.Printf("  %-20s %s%s\n", name, vol.Profile, systemTag)
		fmt.Printf("    read:  %v\n", vol.Boundaries.Read)
		fmt.Printf("    write: %v\n", vol.Boundaries.Write)
		if vol.IDPrefix != "" {
			fmt.Printf("    idPrefix: %s\n", vol.IDPrefix)
		}
	}
	fmt.Println()
	fmt.Println("Agents:")
	for name, agent := range cfg.Agents {
		role := agent.Role
		if role == "" {
			role = "subagent"
		}
		fmt.Printf("  %-20s display: %s, role: %s\n", name, agent.Display, role)
	}

	if cfg.Embedding != nil {
		fmt.Println()
		fmt.Println("Embedding:")
		fmt.Printf("  enabled: %v\n", cfg.Embedding.Enabled)
		if cfg.Embedding.Model != "" {
			fmt.Printf("  model: %s\n", cfg.Embedding.Model)
		}
	}

	return 0
}

// RunConfigValidate validates config and reports issues.
func RunConfigValidate(projectRoot string) int {
	vres, err := config.LoadAndValidate(projectRoot)
	if err != nil {
		fmt.Printf("✗ %v\n", err)
		return 1
	}

	if len(vres.Errors) == 0 && len(vres.Warnings) == 0 {
		fmt.Printf("✓ Config is valid (%d volumes, %d agents)\n",
			len(vres.Config.Volumes), len(vres.Config.Agents))
		return 0
	}

	for _, e := range vres.Errors {
		fmt.Printf("✗ %s\n", e.Error())
		if hint := suggestConfigFix(e); hint != "" {
			fmt.Printf("  → %s\n", hint)
		}
	}
	for _, w := range vres.Warnings {
		fmt.Printf("⚠ %s\n", w.Error())
	}

	if len(vres.Errors) > 0 {
		return 1
	}
	return 0
}

// RunConfigEdit opens the config in the user's editor.
func RunConfigEdit(projectRoot string) int {
	configPath := findConfig(projectRoot)
	if configPath == "" {
		fmt.Printf("No stellario.yaml found in %s\n", projectRoot)
		return 1
	}

	editor := os.Getenv("EDITOR")
	if editor == "" {
		editor = "vi"
	}

	cmd := exec.Command(editor, configPath)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Printf("Error opening editor: %v\n", err)
		return 1
	}

	fmt.Println("Validating after edit...")
	return RunConfigValidate(projectRoot)
}

// RunConfigShowGlobal shows the global library config state.
func RunConfigShowGlobal() int {
	globalDir := cluster.GlobalDir()

	fmt.Println("Global Library Config")
	fmt.Println("═══════════════════════════════════════════════════════")
	fmt.Printf("Global dir: %s\n", globalDir)
	fmt.Println()

	// Check each project's config
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	if len(pm.Projects) == 0 {
		fmt.Println("No projects registered.")
		return 0
	}

	for name := range pm.Projects {
		projectDir := cluster.ProjectDir(name)
		configPath := findProjectConfig(projectDir)

		fmt.Printf("Project: %s\n", name)
		if _, err := os.Stat(configPath); err == nil {
			vres, err := config.LoadAndValidatePath(configPath)
			if err != nil {
				fmt.Printf("  ✗ Config error: %v\n", err)
			} else if len(vres.Errors) > 0 {
				for _, e := range vres.Errors {
					fmt.Printf("  ✗ %s\n", e.Error())
				}
			} else {
				fmt.Printf("  ✓ Config valid (%d volumes, %d agents)\n",
					len(vres.Config.Volumes), len(vres.Config.Agents))
			}
		} else {
			fmt.Printf("  ⚠ No config in global library\n")
		}
		fmt.Println()
	}

	return 0
}
