package cmd

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"stellario/engine/cluster"
)

// ─── Memory Sync (subtree-based) ─────────────────────────────────────────────

// SyncOptions controls the sync command.
type SyncOptions struct {
	ProjectName string // specific project (empty = all)
	Push        bool
	Pull        bool
	StatusOnly  bool
}

// RunSync manages git synchronization for projects in the global library.
// Each project is a subtree in the parent repo, with its own optional remote.
func RunSync(opts SyncOptions) int {
	// Default: show status only
	if !opts.Push && !opts.Pull && !opts.StatusOnly {
		opts.StatusOnly = true
	}

	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	if len(pm.Projects) == 0 {
		fmt.Println("No projects registered.")
		return 0
	}

	exitCode := 0

	// ── Parent repo status ──
	globalDir := cluster.GlobalDir()
	parentRemote := getRemoteUrl(globalDir)

	fmt.Println("Stellario Memory Sync")
	fmt.Println("═══════════════════════════════════════════════════════")

	if parentRemote == "" {
		fmt.Printf("Parent repo: no remote configured\n")
	} else {
		fmt.Printf("Parent repo: %s\n", parentRemote)
	}

	// Check parent uncommitted changes
	if hasUncommittedChanges(globalDir) {
		fmt.Printf("  ⚠ Uncommitted changes in global library\n")
	} else {
		fmt.Printf("  ✓ Working tree clean\n")
	}

	fmt.Println()

	// ── Per-project subtree status ──
	projectNames := make([]string, 0, len(pm.Projects))
	for name := range pm.Projects {
		projectNames = append(projectNames, name)
	}

	if opts.ProjectName != "" {
		// Filter to single project
		found := false
		for _, n := range projectNames {
			if n == opts.ProjectName {
				found = true
				break
			}
		}
		if !found {
			fmt.Printf("Project %q not registered.\n", opts.ProjectName)
			return 1
		}
		projectNames = []string{opts.ProjectName}
	}

	for _, name := range projectNames {
		entry := pm.Projects[name]
		fmt.Printf("─── %s ──────────────────────────\n", name)

		projectRemote := entry.Remote
		if projectRemote == "" || projectRemote == "(remote-only)" {
			fmt.Printf("  ⚠ No subtree remote configured\n")
			fmt.Printf("    Set with: stellario project remote %s <url>\n", name)
			continue
		}

		fmt.Printf("  Subtree remote: %s\n", shortRemote(projectRemote))

		subtreePrefix := filepath.Join("projects", name)
		branch := "main" // default; could be detected

		if opts.StatusOnly {
			// Show what would happen
			ahead, behind := subtreeAheadBehind(globalDir, subtreePrefix, projectRemote, branch)
			if ahead > 0 {
				fmt.Printf("  ⚠ %d local commits ahead (ready to push)\n", ahead)
			}
			if behind > 0 {
				fmt.Printf("  ⚠ %d remote commits behind (ready to pull)\n", behind)
			}
			if ahead == 0 && behind == 0 {
				fmt.Printf("  ✓ In sync with remote\n")
			}
		}

		if opts.Push {
			fmt.Printf("  Pushing...\n")
			if err := subtreePush(globalDir, subtreePrefix, projectRemote, branch); err != nil {
				fmt.Printf("  ✗ %v\n", err)
				exitCode = 1
			} else {
				fmt.Printf("  ✓ Pushed\n")
			}
		}

		if opts.Pull {
			fmt.Printf("  Pulling...\n")
			if err := subtreePull(globalDir, subtreePrefix, projectRemote, branch); err != nil {
				fmt.Printf("  ✗ %v\n", err)
				exitCode = 1
			} else {
				fmt.Printf("  ✓ Pulled\n")
			}
		}

		fmt.Println()
	}

	return exitCode
}

// ─── Subtree git operations ──────────────────────────────────────────────────

func subtreePush(repoDir, prefix, remote, branch string) error {
	cmd := exec.Command("git", "subtree", "push",
		"--prefix="+prefix,
		remote, branch,
	)
	cmd.Dir = repoDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(output)))
	}
	return nil
}

func subtreePull(repoDir, prefix, remote, branch string) error {
	cmd := exec.Command("git", "subtree", "pull",
		"--prefix="+prefix,
		remote, branch,
		"--squash",
	)
	cmd.Dir = repoDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(output)))
	}
	return nil
}

// subtreeAheadBehind checks sync state by comparing local subtree with remote.
// This is approximate — uses split to get subtree commits and compares with remote.
func subtreeAheadBehind(repoDir, prefix, remote, branch string) (int, int) {
	// Check if remote is reachable
	cmd := exec.Command("git", "ls-remote", remote, branch)
	cmd.Dir = repoDir
	if output, err := cmd.Output(); err != nil || len(strings.TrimSpace(string(output))) == 0 {
		return -1, -1 // remote unreachable
	}

	// Simple heuristic: check if there are uncommitted changes affecting this prefix
	// A full ahead/behind would require subtree split + compare, which is expensive.
	// For now, report based on whether the prefix has staged/unstaged changes.
	cmd = exec.Command("git", "status", "--porcelain", "--", prefix)
	cmd.Dir = repoDir
	output, err := cmd.Output()
	if err == nil && len(strings.TrimSpace(string(output))) > 0 {
		return 1, 0 // has local changes = ahead
	}

	return 0, 0
}

// getRemoteUrl returns the origin remote URL for a repo.
func getRemoteUrl(repoDir string) string {
	cmd := exec.Command("git", "remote", "get-url", "origin")
	cmd.Dir = repoDir
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}
