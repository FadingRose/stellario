package cluster

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ─── Constants ───────────────────────────────────────────────────────────────

// GlobalDir returns the global stellario library directory (~/.stellario/).
func GlobalDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".stellario"
	}
	return filepath.Join(home, ".stellario")
}

// ProjectsDir returns the projects subdirectory inside the global library.
func ProjectsDir() string {
	return filepath.Join(GlobalDir(), "projects")
}

// GlobalDir returns the global-scoped volumes directory.
func GlobalVolumesDir() string {
	return filepath.Join(GlobalDir(), "global")
}

// ProjectMapPath returns the path to .project-map.json (device-local).
func ProjectMapPath() string {
	return filepath.Join(GlobalDir(), ".project-map.json")
}

// DeviceIDPath returns the path to .device-id (device identity).
func DeviceIDPath() string {
	return filepath.Join(GlobalDir(), ".device-id")
}

// ProjectDir returns the memory directory for a specific project in the global library.
func ProjectDir(projectName string) string {
	return filepath.Join(ProjectsDir(), projectName)
}

// ─── Device Identity ─────────────────────────────────────────────────────────

// DeviceID holds the device's identity information.
type DeviceID struct {
	ID       string `json:"id"`
	Hostname string `json:"hostname"`
	Platform string `json:"platform"`
	Created  string `json:"created"`
}

// GetOrCreateDeviceID loads or generates the device identity.
func GetOrCreateDeviceID() (*DeviceID, error) {
	path := DeviceIDPath()

	// Try to load existing
	if data, err := os.ReadFile(path); err == nil {
		var dev DeviceID
		if err := unmarshalJSON(data, &dev); err == nil && dev.ID != "" {
			return &dev, nil
		}
	}

	// Generate new
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown"
	}

	// Generate device ID: platform-short-hostname
	platform := runtime.GOOS
	shortHost := hostname
	if parts := strings.Split(hostname, "."); len(parts) > 0 {
		shortHost = parts[0]
	}
	// Add a random suffix for uniqueness
	suffix := fmt.Sprintf("%x", time.Now().UnixNano()%0xFFFF)
	dev := DeviceID{
		ID:       fmt.Sprintf("%s-%s-%s", platform, shortHost, suffix),
		Hostname: hostname,
		Platform: platform,
		Created:  time.Now().UTC().Format(time.RFC3339),
	}

	// Ensure global dir exists
	if err := os.MkdirAll(GlobalDir(), 0755); err != nil {
		return nil, fmt.Errorf("create global dir: %w", err)
	}

	data, err := marshalJSON(dev)
	if err != nil {
		return nil, fmt.Errorf("marshal device id: %w", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return nil, fmt.Errorf("write device id: %w", err)
	}

	return &dev, nil
}

// ─── Project Map ─────────────────────────────────────────────────────────────

// ProjectMapEntry holds the device-local mapping for a project.
type ProjectMapEntry struct {
	Dir       string `json:"dir"`        // absolute path on this device
	Remote    string `json:"remote"`     // git remote URL (if available)
	FirstSeen string `json:"first_seen"` // ISO timestamp
}

// ProjectMap is the device-local registry of project paths.
type ProjectMap struct {
	Projects map[string]*ProjectMapEntry `json:"projects"`
}

// LoadProjectMap reads the .project-map.json file.
func LoadProjectMap() (*ProjectMap, error) {
	data, err := os.ReadFile(ProjectMapPath())
	if os.IsNotExist(err) {
		return &ProjectMap{Projects: map[string]*ProjectMapEntry{}}, nil
	}
	if err != nil {
		return nil, err
	}

	var pm ProjectMap
	if err := unmarshalJSON(data, &pm); err != nil {
		return nil, fmt.Errorf("parse project map: %w", err)
	}
	if pm.Projects == nil {
		pm.Projects = map[string]*ProjectMapEntry{}
	}
	return &pm, nil
}

// Save writes the project map to disk.
func (pm *ProjectMap) Save() error {
	if err := os.MkdirAll(GlobalDir(), 0755); err != nil {
		return err
	}
	data, err := marshalJSONIndent(pm)
	if err != nil {
		return err
	}
	return os.WriteFile(ProjectMapPath(), data, 0644)
}

// Register adds or updates a project in the map.
func (pm *ProjectMap) Register(name, dir, remote string) {
	pm.Projects[name] = &ProjectMapEntry{
		Dir:       dir,
		Remote:    remote,
		FirstSeen: time.Now().UTC().Format(time.RFC3339),
	}
}

// Lookup finds a project by its directory path on this device.
func (pm *ProjectMap) Lookup(dir string) (name string, entry *ProjectMapEntry, found bool) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir
	}
	for name, entry := range pm.Projects {
		if filepath.Clean(entry.Dir) == filepath.Clean(abs) {
			return name, entry, true
		}
	}
	return "", nil, false
}

// ─── Project Identity Resolution ─────────────────────────────────────────────

// ResolveProject determines the project identity for a given directory.
// Priority:
//   1. project-map.json (already registered)
//   2. git remote URL (github.com:user/valhalla → "valhalla")
//   3. .stellario-project file (explicit declaration)
//   4. basename of directory (fallback)
func ResolveProject(dir string) (name string, remote string, source string, err error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", "", "", err
	}

	// 1. Check project map
	pm, err := LoadProjectMap()
	if err == nil {
		if n, entry, found := pm.Lookup(abs); found {
			return n, entry.Remote, "project-map", nil
		}
	}

	// 2. Try git remote
	remote = getGitRemote(abs)
	if remote != "" {
		name = DeriveProjectNameFromRemote(remote)
		if name != "" {
			return name, remote, "git-remote", nil
		}
	}

	// 3. Try .stellario-project file
	declFile := filepath.Join(abs, ".stellario-project")
	if data, err := os.ReadFile(declFile); err == nil {
		var decl struct {
			Name string `json:"name"`
		}
		if unmarshalJSON(data, &decl) == nil && decl.Name != "" {
			return decl.Name, remote, "project-file", nil
		}
	}

	// 4. Fallback: basename
	return filepath.Base(abs), remote, "basename", nil
}

// getGitRemote extracts the origin remote URL from a git repo.
func getGitRemote(dir string) string {
	cmd := exec.Command("git", "remote", "get-url", "origin")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// (deriveProjectNameFromRemote is now public as DeriveProjectNameFromRemote above)

// DeriveProjectNameFromRemote extracts a project name from a git remote URL.
// Examples:
//   git@github.com:user/valhalla.git    → "valhalla"
//   https://github.com/user/valhalla     → "valhalla"
//   git@github.com:FadingRose/stellario  → "stellario"
func DeriveProjectNameFromRemote(remote string) string {
	if remote == "" {
		return ""
	}

	// Strip trailing .git
	remote = strings.TrimSuffix(remote, ".git")

	// Extract last path segment
	var last string
	if idx := strings.LastIndex(remote, "/"); idx >= 0 {
		last = remote[idx+1:]
	} else if idx := strings.LastIndex(remote, ":"); idx >= 0 {
		last = remote[idx+1:]
	} else {
		last = remote
	}

	if last == "" {
		return ""
	}

	return last
}

// ─── Global Library Initialization ───────────────────────────────────────────

// InitResult holds the result of initializing the global library.
type InitResult struct {
	GlobalDir      string
	DeviceID       *DeviceID
	ProjectMap     *ProjectMap
	GitInitialized bool
	Created        bool
}

// InitGlobal ensures the global library exists with proper structure.
// Idempotent — safe to call multiple times.
func InitGlobal() (*InitResult, error) {
	result := &InitResult{GlobalDir: GlobalDir()}
	gd := GlobalDir()

	// Check if already exists
	exists := false
	if _, err := os.Stat(gd); err == nil {
		exists = true
	}

	// Create directory structure
	dirs := []string{
		gd,
		GlobalVolumesDir(),
		ProjectsDir(),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return nil, fmt.Errorf("create %s: %w", d, err)
		}
	}
	result.Created = !exists

	// Device ID
	dev, err := GetOrCreateDeviceID()
	if err != nil {
		return nil, err
	}
	result.DeviceID = dev

	// Project map
	pm, err := LoadProjectMap()
	if err != nil {
		return nil, err
	}
	result.ProjectMap = pm

	// Git repo
	gitDir := filepath.Join(gd, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		cmd := exec.Command("git", "init")
		cmd.Dir = gd
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("git init: %w", err)
		}
		result.GitInitialized = true

		// Write .gitignore for device-local files
		gitignore := ".project-map.json\n.device-id\n*.db\n*.db-wal\n*.db-shm\n"
		os.WriteFile(filepath.Join(gd, ".gitignore"), []byte(gitignore), 0644)
	}

	return result, nil
}

// ─── JSON helpers (avoid importing encoding/json everywhere) ─────────────────

func marshalJSON(v interface{}) ([]byte, error) {
	return jsonMarshal(v)
}

func marshalJSONIndent(v interface{}) ([]byte, error) {
	return jsonMarshalIndent(v)
}

func unmarshalJSON(data []byte, v interface{}) error {
	return jsonUnmarshal(data, v)
}
