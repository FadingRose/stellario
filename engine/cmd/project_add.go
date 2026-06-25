package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"stellario/engine/cluster"
)

// ─── Project Add (subtree-based) ─────────────────────────────────────────────

// RunProjectAdd adds a project from a remote git repo as a subtree.
func RunProjectAdd(remoteURL string) int {
	// Derive project name from remote
	projectName := cluster.DeriveProjectNameFromRemote(remoteURL)
	if projectName == "" {
		fmt.Printf("Could not derive project name from URL: %s\n", remoteURL)
		fmt.Printf("Specify with --name flag\n")
		return 1
	}

	// Ensure global library is initialized
	_, err := cluster.InitGlobal()
	if err != nil {
		fmt.Printf("Error initializing global library: %w\n", err)
		return 1
	}

	// Check if project already exists
	projectDir := cluster.ProjectDir(projectName)
	if _, err := os.Stat(projectDir); err == nil {
		fmt.Printf("Project %q already exists in global library: %s\n", projectName, projectDir)
		return 1
	}

	fmt.Printf("Adding project: %s\n", projectName)
	fmt.Printf("  Remote: %s\n", remoteURL)
	fmt.Printf("  Target: %s\n", projectDir)
	fmt.Println()

	// git subtree add — brings in the remote's content + history
	subtreePrefix := filepath.Join("projects", projectName)

	// Determine branch to pull (try main, then master)
	branch := detectRemoteBranch(remoteURL)
	if branch == "" {
		branch = "main"
	}

	cmd := exec.Command("git", "subtree", "add",
		"--prefix="+subtreePrefix,
		remoteURL, branch,
		"--squash", // squash history to keep parent repo clean
	)
	cmd.Dir = cluster.GlobalDir()
	output, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Printf("Error adding subtree: %v\n", strings.TrimSpace(string(output)))
		fmt.Println()
		fmt.Println("If the remote uses 'master' instead of 'main':")
		fmt.Printf("  stellario project add %s --branch master\n", remoteURL)
		return 1
	}

	// Register in project map (dir will be set when project is also cloned locally)
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("⚠ Could not load project map: %v\n", err)
	} else {
		pm.Register(projectName, "(remote-only)", remoteURL)
		if err := pm.Save(); err != nil {
			fmt.Printf("⚠ Could not save project map: %v\n", err)
		}
	}

	// Count imported entries
	entries := countAllEntries(projectDir)

	fmt.Println()
	fmt.Printf("✓ Added %q from %s\n", projectName, remoteURL)
	fmt.Printf("  %d entries imported\n", entries)
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Printf("  - If you have the project locally, register its path:\n")
	fmt.Printf("    stellario project register /path/to/%s\n", projectName)
	fmt.Printf("  - Status: stellario status\n")

	return 0
}

// detectRemoteBranch tries to determine if the remote uses main or master.
func detectRemoteBranch(remoteURL string) string {
	// Try ls-remote to check available branches
	cmd := exec.Command("git", "ls-remote", "--symref", remoteURL, "HEAD")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "main" // default
	}

	outputStr := string(output)
	if strings.Contains(outputStr, "refs/heads/main") {
		return "main"
	}
	if strings.Contains(outputStr, "refs/heads/master") {
		return "master"
	}
	return "main"
}

// RunProjectAddLocal is the migrate path for projects without a remote.
// It imports a local project's data into the parent repo at projects/{name}/.
// (This replaces the old per-project git init behavior.)
func RunProjectAddLocal(projectRoot, projectName string) int {
	// This is essentially the old migrate, but writes into parent repo
	// instead of creating a new .git
	return runMigrateSubtree(projectRoot, projectName)
}

// runMigrateSubtree imports local project data into the parent global repo.
// Unlike old migrate (which created per-project .git), this stages files
// directly in the parent repo and commits them as a single import.
func runMigrateSubtree(projectRoot, projectName string) int {
	// Ensure global library
	_, err := cluster.InitGlobal()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	projectDir := cluster.ProjectDir(projectName)

	// Resolve source .stellario directory
	sourceDir := filepath.Join(projectRoot, ".opencode", ".stellario")
	if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
		sourceDir = filepath.Join(projectRoot, ".stellario")
	}
	if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
		fmt.Printf("Source not found: %s\n", sourceDir)
		return 1
	}

	fmt.Printf("Importing: %s\n", projectName)
	fmt.Printf("  Source: %s\n", sourceDir)
	fmt.Printf("  Target: %s\n", projectDir)
	fmt.Println()

	// Create target dir
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		fmt.Printf("Error creating target: %v\n", err)
		return 1
	}

	// Copy files (same logic as migrate)
	totalEntries := copyStellarioData(sourceDir, projectDir)

	// Also copy config
	configSrc := filepath.Join(projectRoot, ".opencode", "stellario.yaml")
	if _, err := os.Stat(configSrc); err != nil {
		configSrc = filepath.Join(projectRoot, "stellario.yaml")
	}
	if _, err := os.Stat(configSrc); err == nil {
		copyFile(configSrc, filepath.Join(projectDir, "stellario.yaml"))
		fmt.Printf("  ✓ stellario.yaml\n")
	}

	// Stage and commit in parent repo
	globalDir := cluster.GlobalDir()
	subtreePrefix := filepath.Join("projects", projectName)

	exec.Command("git", "add", subtreePrefix).Run()

	commitMsg := fmt.Sprintf("import: project %s (%d entries)", projectName, totalEntries)
	cmd := exec.Command("git", "commit", "-m", commitMsg)
	cmd.Dir = globalDir
	cmd.Run()

	fmt.Println()
	fmt.Printf("✓ Imported %d entries for %q\n", totalEntries, projectName)
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  - Push to remote: stellario memory-sync --push")
	fmt.Println("  - Status: stellario status")

	return 0
}

// copyStellarioData copies all relevant files from source to dest, returns entry count.
func copyStellarioData(sourceDir, destDir string) int {
	totalEntries := 0

	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		return 0
	}

	for _, entry := range entries {
		name := entry.Name()
		src := filepath.Join(sourceDir, name)
		dst := filepath.Join(destDir, name)

		// Skip .git
		if entry.IsDir() && name == ".git" {
			continue
		}

		// Skip generated files
		if name == "keywords-index.jsonl" || strings.Contains(name, ".index-pending") {
			continue
		}

		if entry.IsDir() {
			if err := copyDir(src, dst); err == nil {
				fmt.Printf("  ✓ %s/ (directory)\n", name)
			}
			continue
		}

		if err := copyFile(src, dst); err != nil {
			continue
		}

		if strings.HasSuffix(name, ".jsonl") {
			count, _ := countEntriesInJSONL(dst)
			totalEntries += count
			fmt.Printf("  ✓ %s (%d entries)\n", name, count)
		} else {
			fmt.Printf("  ✓ %s\n", name)
		}
	}

	return totalEntries
}
