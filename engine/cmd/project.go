package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"stellario/engine/cluster"
)

// ─── Project Commands ────────────────────────────────────────────────────────

// RunProjectList lists all registered projects in the global library.
func RunProjectList() int {
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error loading project map: %v\n", err)
		return 1
	}

	if len(pm.Projects) == 0 {
		fmt.Println("No projects registered.")
		fmt.Println()
		fmt.Println("Register a project with:")
		fmt.Println("  stellario project register <directory>")
		return 0
	}

	fmt.Println("Registered Projects")
	fmt.Println("═══════════════════════════════════════════════════════")

	for name, entry := range pm.Projects {
		// Check if global library has data
		projectDir := cluster.ProjectDir(name)
		entryCount := countAllEntries(projectDir)

		remoteStr := ""
		if entry.Remote != "" {
			remoteStr = fmt.Sprintf("  (%s)", shortRemote(entry.Remote))
		}

		fmt.Printf("  %-20s %s%s\n", name, entry.Dir, remoteStr)
		fmt.Printf("    %-20s %d entries in global library\n", "", entryCount)
	}

	return 0
}

// RunProjectRegister registers a directory as a known project.
func RunProjectRegister(dir string) int {
	abs, err := filepath.Abs(dir)
	if err != nil {
		fmt.Printf("Error resolving path: %v\n", err)
		return 1
	}

	if _, err := filepath.Glob(filepath.Join(abs, "*")); err != nil {
		fmt.Printf("Directory not found: %s\n", abs)
		return 1
	}

	// Ensure global library is initialized
	_, err = cluster.InitGlobal()
	if err != nil {
		fmt.Printf("Error initializing global library: %v\n", err)
		return 1
	}

	// Resolve project identity
	name, remote, source, err := cluster.ResolveProject(abs)
	if err != nil {
		fmt.Printf("Error resolving project: %v\n", err)
		return 1
	}

	fmt.Printf("Detected project: %s\n", name)
	fmt.Printf("  Path: %s\n", abs)
	fmt.Printf("  Source: %s\n", source)
	if remote != "" {
		fmt.Printf("  Git remote: %s\n", remote)
	}

	// Check if already registered
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error loading project map: %v\n", err)
		return 1
	}

	if _, _, exists := pm.Lookup(abs); exists {
		fmt.Printf("\nAlready registered.\n")
		return 0
	}

	// Register
	pm.Register(name, abs, remote)
	if err := pm.Save(); err != nil {
		fmt.Printf("Error saving project map: %v\n", err)
		return 1
	}

	fmt.Printf("\n✓ Registered as \"%s\"\n", name)
	fmt.Printf("  To migrate memory data: stellario migrate --root %s\n", abs)

	return 0
}

// RunProjectForget removes a project from the device registry (preserves data).
func RunProjectForget(name string) int {
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	entry, exists := pm.Projects[name]
	if !exists {
		fmt.Printf("Project \"%s\" is not registered.\n", name)
		return 1
	}

	// Remove from map
	delete(pm.Projects, name)
	if err := pm.Save(); err != nil {
		fmt.Printf("Error saving: %v\n", err)
		return 1
	}

	fmt.Printf("Removed \"%s\" from device registry.\n", name)
	fmt.Printf("  Data preserved in global library: %s\n", cluster.ProjectDir(name))
	fmt.Printf("  Was at: %s\n", entry.Dir)

	return 0
}

// RunProjectInfo shows detailed info about a project.
func RunProjectInfo(name string) int {
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	entry, exists := pm.Projects[name]
	if !exists {
		fmt.Printf("Project \"%s\" is not registered.\n", name)
		fmt.Printf("Register with: stellario project register <dir>\n")
		return 1
	}

	projectDir := cluster.ProjectDir(name)

	fmt.Printf("Project: %s\n", name)
	fmt.Println("═══════════════════════════════════════════════════════")
	fmt.Printf("  Directory:    %s\n", entry.Dir)
	if entry.Remote != "" {
		fmt.Printf("  Git remote:   %s\n", entry.Remote)
	}
	fmt.Printf("  First seen:   %s\n", entry.FirstSeen)
	fmt.Printf("  Global data:  %s\n", projectDir)
	fmt.Println()

	// Show volumes and entry counts
	volumes := listVolumeInfo(projectDir)
	if len(volumes) == 0 {
		fmt.Printf("  No memory data migrated yet.\n")
		fmt.Printf("  Run: stellario migrate --root %s\n", entry.Dir)
	} else {
		fmt.Printf("  Volumes:\n")
		totalEntries := 0
		for _, v := range volumes {
			fmt.Printf("    %-20s %d entries\n", v.Name, v.EntryCount)
			totalEntries += v.EntryCount
		}
		fmt.Printf("    %-20s %d entries total\n", "─── total ───", totalEntries)
	}

	// Check git status
	gitDir := filepath.Join(projectDir, ".git")
	if _, err := statFile(gitDir); err == nil {
		fmt.Printf("\n  Git: initialized\n")
		ahead := gitCommitsAhead(projectDir)
		if ahead > 0 {
			fmt.Printf("  ⚠ %d commits unpushed\n", ahead)
		} else {
			fmt.Printf("  ✓ up to date\n")
		}
	} else {
		fmt.Printf("\n  Git: not initialized in project dir\n")
	}

	return 0
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type volumeInfo struct {
	Name       string
	EntryCount int
}

// listVolumeInfo enumerates volumes and entry counts in a directory.
// In the device-relative model, data lives one level down in device-id
// subdirs. This recurses into immediate subdirectories and aggregates
// counts by volume name, so passing a project container yields totals
// across all devices. Passing a single device dir still works (no subdirs).
func listVolumeInfo(projectDir string) []volumeInfo {
	agg := map[string]int{}
	order := []string{}

	scanVolumeFiles := func(files []string) {
		for _, file := range files {
			base := filepath.Base(file)
			if base == "volumes.jsonl" ||
				strings.Contains(base, "keywords-index") || strings.Contains(base, ".index-pending") {
				continue
			}
			name := strings.TrimSuffix(base, ".jsonl")
			count, _ := countEntriesInJSONL(file)
			if _, ok := agg[name]; !ok {
				order = append(order, name)
			}
			agg[name] += count
		}
	}

	// Top-level .jsonl files (single-device dir or legacy flat layout)
	if files, err := globFiles(filepath.Join(projectDir, "*.jsonl")); err == nil {
		scanVolumeFiles(files)
	}

	// Recurse one level into device-id subdirs (device-relative layout)
	if entries, err := os.ReadDir(projectDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			sub := filepath.Join(projectDir, e.Name())
			if files, err := globFiles(filepath.Join(sub, "*.jsonl")); err == nil {
				scanVolumeFiles(files)
			}
		}
	}

	var volumes []volumeInfo
	for _, name := range order {
		volumes = append(volumes, volumeInfo{Name: name, EntryCount: agg[name]})
	}
	return volumes
}

func countAllEntries(projectDir string) int {
	total := 0
	for _, v := range listVolumeInfo(projectDir) {
		total += v.EntryCount
	}
	return total
}

func shortRemote(remote string) string {
	// github.com:user/repo → user/repo
	if idx := strings.Index(remote, ":"); idx >= 0 && strings.Contains(remote[:idx], "github") {
		return remote[idx+1:]
	}
	// https://github.com/user/repo → user/repo
	remote = strings.TrimPrefix(remote, "https://")
	remote = strings.TrimPrefix(remote, "http://")
	if idx := strings.Index(remote, "/"); idx >= 0 {
		rest := remote[idx+1:]
		return rest
	}
	return remote
}

func gitCommitsAhead(dir string) int {
	cmd := exec.Command("git", "rev-list", "--count", "HEAD", "^origin/master")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		// Try main instead of master
		cmd = exec.Command("git", "rev-list", "--count", "HEAD", "^origin/main")
		cmd.Dir = dir
		out, err = cmd.Output()
		if err != nil {
			return -1
		}
	}
	var count int
	fmt.Sscanf(string(out), "%d", &count)
	return count
}
