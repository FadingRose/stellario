package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"stellario/engine/cluster"
)

// ─── Resolve ─────────────────────────────────────────────────────────────────

// SiblingDevice describes another device's memory directory within the same
// project container. TS uses this to auto-mount sibling volumes (readonly)
// so cross-device memory is visible.
type SiblingDevice struct {
	DeviceID string `json:"device_id"`
	Star     string `json:"star"` // star name from this device's local perspective
	Path     string `json:"path"` // absolute path to the sibling's device dir
}

// ResolveResult is the JSON output of the resolve command.
// TS uses this to know where the device-relative memory data lives.
type ResolveResult struct {
	Project    string         `json:"project"`
	Source     string         `json:"source"`      // how project was resolved: project-map, git-remote, basename
	MemDir     string         `json:"mem_dir"`     // absolute path to THIS device's memory data
	ConfigPath string         `json:"config_path"` // absolute path to stellario.yaml
	Exists     bool           `json:"exists"`      // whether THIS device's memory dir exists
	Star       string         `json:"star"`        // this device's star name
	Siblings   []SiblingDevice `json:"siblings"`   // other devices' dirs (for auto-mount)
}

// RunResolve resolves a project directory to its global library location.
// Returns JSON on stdout for TS to consume.
//
// Special case: if projectRoot is "_global", resolves to the global
// volumes directory (~/.stellario/global/{device-id}/). This is used by
// Stellario's own agent to read/write its personal memory (meta volume etc).
func RunResolve(projectRoot string) int {
	// Ensure device identity exists (and a star name is assigned)
	dev, err := cluster.GetOrCreateDeviceID()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: device identity: %v\n", err)
		return 1
	}
	starName := dev.Star

	// Special: _global → global volumes directory (device-relative)
	if projectRoot == "_global" {
		return resolveGlobal(dev, starName)
	}

	name, _, source, err := cluster.ResolveProject(projectRoot)
	if err != nil {
		// Fallback: basename
		abs, _ := filepath.Abs(projectRoot)
		name = filepath.Base(abs)
		source = "basename-error"
	}

	// Device-relative mem dir: projects/{name}/{device-id}/
	memDir, err := cluster.LocalProjectDir(name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}
	configPath := filepath.Join(memDir, "stellario.yaml")

	// Fall back to container-level config if device dir has none
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		containerConfig := filepath.Join(cluster.ProjectDir(name), "stellario.yaml")
		if _, err := os.Stat(containerConfig); err == nil {
			configPath = containerConfig
		}
	}

	exists := true
	if _, err := os.Stat(memDir); os.IsNotExist(err) {
		exists = false
	}

	siblings := resolveSiblings(name)

	result := ResolveResult{
		Project:    name,
		Source:     source,
		MemDir:     memDir,
		ConfigPath: configPath,
		Exists:     exists,
		Star:       starName,
		Siblings:   siblings,
	}

	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	fmt.Println(string(data))
	return 0
}

// resolveSiblings builds the auto-mount sibling list for a project.
func resolveSiblings(projectName string) []SiblingDevice {
	paths, err := cluster.ListSiblingDeviceDirs(projectName)
	if err != nil || len(paths) == 0 {
		return nil
	}
	var siblings []SiblingDevice
	for _, p := range paths {
		deviceID := filepath.Base(p)
		star := cluster.StarNameForDevice(deviceID) // assigns a local name if unseen
		siblings = append(siblings, SiblingDevice{
			DeviceID: deviceID,
			Star:     star,
			Path:     p,
		})
	}
	return siblings
}

// resolveGlobal resolves to this device's global volumes directory.
// Stellario's own memory lives here (meta volume with user profile etc).
func resolveGlobal(dev *cluster.DeviceID, starName string) int {
	memDir := cluster.DeviceGlobalDir(dev.ID)
	globalConfig := filepath.Join(memDir, "stellario.yaml")

	// Ensure the device global dir exists
	os.MkdirAll(memDir, 0755)

	// If no config exists, write a minimal one
	if _, err := os.Stat(globalConfig); os.IsNotExist(err) {
		// Fall back to container-level config if present
		containerConfig := filepath.Join(cluster.GlobalVolumesDir(), "stellario.yaml")
		if _, err := os.Stat(containerConfig); err == nil {
			globalConfig = containerConfig
		} else {
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
	}

	result := ResolveResult{
		Project:    "_global",
		Source:     "global",
		MemDir:     memDir,
		ConfigPath: globalConfig,
		Exists:     true,
		Star:       starName,
		Siblings:   nil, // global has no siblings (single shared meta perspective)
	}

	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
	return 0
}
