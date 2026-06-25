package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"stellario/engine/cluster"
)

// ─── Resolve ─────────────────────────────────────────────────────────────────

// ResolveResult is the JSON output of the resolve command.
// TS uses this to know where the global library data lives.
type ResolveResult struct {
	Project    string `json:"project"`
	Source     string `json:"source"`      // how project was resolved: project-map, git-remote, basename
	MemDir     string `json:"mem_dir"`     // absolute path to memory data (~/.stellario/projects/{name})
	ConfigPath string `json:"config_path"` // absolute path to stellario.yaml in global library
	Exists     bool   `json:"exists"`      // whether the global library data exists (migrated)
}

// RunResolve resolves a project directory to its global library location.
// Returns JSON on stdout for TS to consume.
func RunResolve(projectRoot string) int {
	name, _, source, err := cluster.ResolveProject(projectRoot)
	if err != nil {
		// Fallback: basename
		abs, _ := filepath.Abs(projectRoot)
		name = filepath.Base(abs)
		source = "basename-error"
	}

	projectDir := cluster.ProjectDir(name)
	configPath := filepath.Join(projectDir, "stellario.yaml")

	exists := true
	if _, err := os.Stat(projectDir); os.IsNotExist(err) {
		exists = false
	}

	result := ResolveResult{
		Project:    name,
		Source:     source,
		MemDir:     projectDir,
		ConfigPath: configPath,
		Exists:     exists,
	}

	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	fmt.Println(string(data))
	return 0
}
