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
	Star       string `json:"star"`        // device star name for ID suffix (e.g. "Sirius")
}

// RunResolve resolves a project directory to its global library location.
// Returns JSON on stdout for TS to consume.
//
// Special case: if projectRoot is "_global", resolves to the global
// volumes directory (~/.stellario/global/). This is used by Stellario's
// own agent to read/write its personal memory (meta volume etc).
func RunResolve(projectRoot string) int {
	// Special: _global → global volumes directory
	if projectRoot == "_global" {
		return resolveGlobal()
	}

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

	// Get star name for ID suffix
	starName := ""
	dev, err := cluster.GetOrCreateDeviceID()
	if err == nil {
		starName = dev.Star
	}

	result := ResolveResult{
		Project:    name,
		Source:     source,
		MemDir:     projectDir,
		ConfigPath: configPath,
		Exists:     exists,
		Star:       starName,
	}

	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	fmt.Println(string(data))
	return 0
}

// resolveGlobal resolves to the global volumes directory.
// Stellario's own memory lives here (meta volume with user profile etc).
func resolveGlobal() int {
	globalDir := cluster.GlobalVolumesDir()
	globalConfig := filepath.Join(globalDir, "stellario.yaml")

	// Ensure the global volumes directory exists
	os.MkdirAll(globalDir, 0755)

	// If no config exists, write a minimal one
	if _, err := os.Stat(globalConfig); os.IsNotExist(err) {
		minimalConfig := `# Stellario Global Config
# This defines volumes for Stellario's own memory (not project-scoped).

volumes:
  meta:
    profile: mutable
    boundaries:
      write: [stellario]
      read: [stellario]

agents:
  stellario:
    display: "Stellario"
    role: primary
`
		os.WriteFile(globalConfig, []byte(minimalConfig), 0644)
	}

	starName := ""
	dev, err := cluster.GetOrCreateDeviceID()
	if err == nil {
		starName = dev.Star
	}

	result := ResolveResult{
		Project:    "_global",
		Source:     "global",
		MemDir:     globalDir,
		ConfigPath: globalConfig,
		Exists:     true,
		Star:       starName,
	}

	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
	return 0
}
