package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"stellario/engine/cluster"
)

// ─── Status ──────────────────────────────────────────────────────────────────

// RunStatus prints a comprehensive cluster overview: device info, all projects,
// their volumes, entry counts, and sync state.
func RunStatus() int {
	// Load device ID
	dev, err := cluster.GetOrCreateDeviceID()
	if err != nil {
		fmt.Printf("Error loading device ID: %v\n", err)
		return 1
	}

	// Load project map
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error loading project map: %v\n", err)
		return 1
	}

	// Global library existence
	globalDir := cluster.GlobalDir()
	globalExists := true
	if _, err := os.Stat(globalDir); os.IsNotExist(err) {
		globalExists = false
	}

	fmt.Println("Stellario Memory Cluster")
	fmt.Println("═══════════════════════════════════════════════════════")

	starName := ""
	if dev.Star != "" {
		starName = fmt.Sprintf(" ⋆%s", dev.Star)
	}
	fmt.Printf("Device: %s%s (%s, %s)\n", dev.ID, starName, dev.Platform, dev.Hostname)

	if !globalExists {
		fmt.Println()
		fmt.Println("Global library not initialized.")
		fmt.Println("Run 'stellario migrate --root <project-dir>' to get started.")
		return 0
	}

	fmt.Printf("Global: %s\n", globalDir)
	fmt.Println()

	// ── Global volumes ──
	globalVolDir := cluster.GlobalVolumesDir()
	globalVols := listVolumeInfo(globalVolDir)
	if len(globalVols) > 0 {
		fmt.Println("Global volumes:")
		for _, v := range globalVols {
			fmt.Printf("  %-20s %d entries\n", v.Name, v.EntryCount)
		}
		fmt.Println()
	}

	// ── Projects ──
	if len(pm.Projects) == 0 {
		fmt.Println("No projects registered.")
		fmt.Println()
		fmt.Println("Register and migrate projects:")
		fmt.Println("  stellario migrate --root <project-dir>")
		return 0
	}

	totalEntries := 0
	projectLines := []projectStatusLine{}

	for name, entry := range pm.Projects {
		projectDir := cluster.ProjectDir(name)
		vols := listVolumeInfo(projectDir)
		entryCount := 0
		for _, v := range vols {
			entryCount += v.EntryCount
		}
		totalEntries += entryCount

		// Check git status — in subtree model, parent repo tracks everything
		gitStatus := "no git"
		globalDir := cluster.GlobalDir()
		if _, err := os.Stat(filepath.Join(globalDir, ".git")); err == nil {
			// Parent repo exists — check if this project's prefix has uncommitted changes
			subtreePrefix := filepath.Join("projects", name)
			cmd := exec.Command("git", "status", "--porcelain", "--", subtreePrefix)
			cmd.Dir = globalDir
			if out, err := cmd.Output(); err == nil && len(strings.TrimSpace(string(out))) > 0 {
				gitStatus = "⚠ uncommitted"
			} else {
				gitStatus = "✓ clean"
			}
		}

		// Check last modified time
		lastWrite := "unknown"
		if mt := getLastModified(projectDir); !mt.IsZero() {
			lastWrite = formatRelativeTime(mt)
		}

		// Check config presence (lives in device subdir, or container)
		configStatus := "✓"
		if findProjectConfig(projectDir) == "" {
			configStatus = "⚠ no config"
		}

		// Verify project dir still exists at registered path
		dirExists := "✓"
		if _, err := os.Stat(entry.Dir); os.IsNotExist(err) {
			dirExists = "✗ missing"
		}

		projectLines = append(projectLines, projectStatusLine{
			Name:        name,
			Dir:         entry.Dir,
			Remote:      entry.Remote,
			EntryCount:  entryCount,
			VolumeCount: len(vols),
			GitStatus:   gitStatus,
			LastWrite:   lastWrite,
			Config:      configStatus,
			DirExists:   dirExists,
		})
	}

	// Print projects table
	fmt.Printf("Projects (%d):\n", len(projectLines))
	for _, p := range projectLines {
		remoteStr := ""
		if p.Remote != "" {
			remoteStr = fmt.Sprintf("  (%s)", shortRemote(p.Remote))
		}
		fmt.Printf("  %-20s %d entries%s\n", p.Name, p.EntryCount, remoteStr)
		fmt.Printf("    %-20s %d volumes  %s  %s  %s\n", "", p.VolumeCount, p.LastWrite, p.GitStatus, p.Config)
	}

	fmt.Println()
	fmt.Printf("Total: %d entries across %d projects\n", totalEntries, len(projectLines))

	// Warnings
	hasWarnings := false
	for _, p := range projectLines {
		if p.DirExists != "✓" {
			if !hasWarnings {
				fmt.Println()
				hasWarnings = true
			}
			fmt.Printf("⚠ Project %q directory missing: %s\n", p.Name, p.Dir)
		}
		if p.Config != "✓" {
			if !hasWarnings {
				fmt.Println()
				hasWarnings = true
			}
			fmt.Printf("⚠ Project %q has no config in global library\n", p.Name)
		}
	}

	fmt.Println()
	fmt.Println("Run 'stellario doctor' for diagnostics, 'stellario project list' for details.")
	return 0
}

type projectStatusLine struct {
	Name        string
	Dir         string
	Remote      string
	EntryCount  int
	VolumeCount int
	GitStatus   string
	LastWrite   string
	Config      string
	DirExists   string
}

// getLastModified finds the most recent mtime among .jsonl files in a directory
// and its immediate device-id subdirectories (device-relative layout).
func getLastModified(dir string) time.Time {
	var latest time.Time
	candidates := []string{filepath.Join(dir, "*.jsonl")}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				candidates = append(candidates, filepath.Join(dir, e.Name(), "*.jsonl"))
			}
		}
	}
	for _, pattern := range candidates {
		files, err := globFiles(pattern)
		if err != nil {
			continue
		}
		for _, f := range files {
			if strings.Contains(filepath.Base(f), "keywords-index") || strings.Contains(filepath.Base(f), ".index-pending") {
				continue
			}
			info, err := os.Stat(f)
			if err != nil {
				continue
			}
			if info.ModTime().After(latest) {
				latest = info.ModTime()
			}
		}
	}
	return latest
}

// formatRelativeTime formats a time as a human-readable relative duration.
func formatRelativeTime(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	default:
		return t.Format("2006-01-02")
	}
}
