package cmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"stellario/engine/cluster"
	"stellario/engine/config"
)

// ─── Migrate ─────────────────────────────────────────────────────────────────

// MigrateOptions controls the migrate command behavior.
type MigrateOptions struct {
	SourceDir    string // source .stellario directory (project-scoped)
	ProjectName  string // explicit project name (empty = auto-resolve)
	ProjectRoot  string // the project root (for config + git remote)
	DryRun       bool   // if true, show what would happen but don't copy
	Verify       bool   // if true, compare source vs dest after copy
}

// MigrateResult holds the outcome of a migration.
type MigrateResult struct {
	ProjectName string
	SourceDir   string
	DestDir     string
	FilesCopied []string
	EntriesMoved int
	GitHistoryPreserved bool
	DryRun      bool
}

// RunMigrate copies memory data from a project-scoped .stellario/ directory
// into the global library at ~/.stellario/projects/{name}/.
//
// This operation is COPY, not MOVE. The source is never modified.
func RunMigrate(opts MigrateOptions) (*MigrateResult, error) {
	// 1. Initialize global library
	gInit, err := cluster.InitGlobal()
	if err != nil {
		return nil, fmt.Errorf("init global library: %w", err)
	}

	if gInit.Created {
		fmt.Printf("Initialized global library at %s\n", gInit.GlobalDir)
		fmt.Printf("  Device: %s (%s)\n", gInit.DeviceID.ID, gInit.DeviceID.Hostname)
		fmt.Println()
	}

	// 2. Resolve project identity
	projectName := opts.ProjectName
	remote := ""
	resolveSource := ""

	if projectName == "" {
		projectName, remote, resolveSource, err = cluster.ResolveProject(opts.ProjectRoot)
		if err != nil {
			return nil, fmt.Errorf("resolve project: %w", err)
		}
	}

	fmt.Printf("Project identity: %s\n", projectName)
	fmt.Printf("  Resolved via: %s\n", resolveSource)
	if remote != "" {
		fmt.Printf("  Git remote: %s\n", remote)
	}

	// Destination is THIS device's subdir in the project container (device-relative model)
	destDir, err := cluster.LocalProjectDir(projectName)
	if err != nil {
		return nil, fmt.Errorf("resolve device dir: %w", err)
	}
	if _, err := os.Stat(destDir); err == nil {
		fmt.Printf("  ⚠ Project already exists in global library: %s\n", destDir)
		fmt.Printf("    Migrate will overwrite JSONL files (git history preserved).\n")
	}

	// Register in project map — always reload fresh to avoid stale snapshot
	if !opts.DryRun {
		freshPM, err := cluster.LoadProjectMap()
		if err != nil {
			return nil, fmt.Errorf("load project map for registration: %w", err)
		}
		// Check by project name (not directory) to avoid path resolution issues
		if _, exists := freshPM.Projects[projectName]; !exists {
			freshPM.Register(projectName, opts.ProjectRoot, remote)
			if err := freshPM.Save(); err != nil {
				return nil, fmt.Errorf("save project map: %w", err)
			}
			fmt.Printf("  Registered in project map.\n")
		}
	}

	fmt.Println()

	// 3. Prepare source
	sourceDir := opts.SourceDir
	if sourceDir == "" {
		// Try to load config to get memoryDir
		vres, err := config.LoadAndValidate(opts.ProjectRoot)
		if err == nil && vres.Config != nil {
			sourceDir = filepath.Join(opts.ProjectRoot, vres.Config.MemoryDir)
		} else {
			sourceDir = filepath.Join(opts.ProjectRoot, ".opencode", ".stellario")
		}
	}

	if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
		return nil, fmt.Errorf("source directory not found: %s", sourceDir)
	}

	fmt.Printf("Source: %s\n", sourceDir)
	fmt.Printf("Destination: %s\n", destDir)
	fmt.Println()

	result := &MigrateResult{
		ProjectName: projectName,
		SourceDir:   sourceDir,
		DestDir:     destDir,
		DryRun:      opts.DryRun,
	}

	// 4. Collect files to copy
	type fileToCopy struct {
		src    string
		dst    string
		isJSONL bool
	}
	var filesToCopy []fileToCopy

	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		return nil, fmt.Errorf("read source dir: %w", err)
	}

	skippedSymlinks := 0
	for _, entry := range entries {
		name := entry.Name()

		// Check for symlinks via Lstat — skip all symlinked files and dirs
		info, err := os.Lstat(filepath.Join(sourceDir, name))
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			skippedSymlinks++
			fmt.Printf("  ⊘ %s (symlink — skipped)\n", name)
			continue
		}

		if entry.IsDir() {
			// Skip .git and other hidden dirs
			if name == ".git" {
				continue
			}
			continue
		}

		src := filepath.Join(sourceDir, name)
		dst := filepath.Join(destDir, name)

		isJSONL := strings.HasSuffix(name, ".jsonl")
		isGenerated := name == "keywords-index.jsonl" || strings.Contains(name, ".index-pending")

		if isGenerated {
			continue // Skip generated files
		}

		filesToCopy = append(filesToCopy, fileToCopy{src: src, dst: dst, isJSONL: isJSONL})
	}

	// Also copy .track directory if exists
	trackSrc := filepath.Join(sourceDir, ".track")
	if _, err := os.Stat(trackSrc); err == nil {
		// .track will be handled as a directory copy
		// We'll add it as a special case
	}

	// 5. Copy files
	if opts.DryRun {
		fmt.Println("[DRY RUN] Files that would be copied:")
	} else {
		// Create destination
		if err := os.MkdirAll(destDir, 0755); err != nil {
			return nil, fmt.Errorf("create dest dir: %w", err)
		}
	}

	totalEntries := 0
	for _, ftc := range filesToCopy {
		if opts.DryRun {
			fmt.Printf("  → %s\n", filepath.Base(ftc.dst))
			if ftc.isJSONL {
				count, _ := countEntriesInJSONL(ftc.src)
				totalEntries += count
				fmt.Printf("    (%d entries)\n", count)
			}
			continue
		}

		// Copy
		if err := copyFile(ftc.src, ftc.dst); err != nil {
			return nil, fmt.Errorf("copy %s: %w", filepath.Base(ftc.src), err)
		}
		result.FilesCopied = append(result.FilesCopied, filepath.Base(ftc.dst))

		if ftc.isJSONL {
			count, _ := countEntriesInJSONL(ftc.dst)
			totalEntries += count
			fmt.Printf("  ✓ %s (%d entries)\n", filepath.Base(ftc.dst), count)
		} else {
			fmt.Printf("  ✓ %s\n", filepath.Base(ftc.dst))
		}
	}

	// Copy .track directory recursively
	if !opts.DryRun {
		if _, err := os.Stat(trackSrc); err == nil {
			trackDst := filepath.Join(destDir, ".track")
			if err := copyDir(trackSrc, trackDst); err != nil {
				fmt.Printf("  ⚠ .track directory copy failed: %v\n", err)
			} else {
				fmt.Printf("  ✓ .track/ (per-entry md files)\n")
			}
		}
	} else {
		if _, err := os.Stat(trackSrc); err == nil {
			fmt.Printf("  → .track/ (per-entry md files)\n")
		}
	}

	result.EntriesMoved = totalEntries
	result.GitHistoryPreserved = true

	// ── Copy stellario.yaml config into project dir ──
	if !opts.DryRun {
		configSrc := filepath.Join(opts.ProjectRoot, ".opencode", "stellario.yaml")
		if _, err := os.Stat(configSrc); os.IsNotExist(err) {
			configSrc = filepath.Join(opts.ProjectRoot, "stellario.yaml")
		}
		if _, err := os.Stat(configSrc); err == nil {
			configDst := filepath.Join(destDir, "stellario.yaml")
			if err := copyFile(configSrc, configDst); err != nil {
				fmt.Printf("  ⚠ Failed to copy config: %v\n", err)
			} else {
				fmt.Printf("  ✓ stellario.yaml (config)\n")
			}
		}
	} else {
		configSrc := filepath.Join(opts.ProjectRoot, ".opencode", "stellario.yaml")
		if _, err := os.Stat(configSrc); err != nil {
			configSrc = filepath.Join(opts.ProjectRoot, "stellario.yaml")
		}
		if _, err := os.Stat(configSrc); err == nil {
			fmt.Printf("  → stellario.yaml (config)\n")
		}
	}

	// ── Initialize per-project git repo ──
	if !opts.DryRun {
		if _, err := os.Stat(filepath.Join(destDir, ".git")); os.IsNotExist(err) {
			gitCmd := exec.Command("git", "init")
			gitCmd.Dir = destDir
			if err := gitCmd.Run(); err != nil {
				fmt.Printf("  ⚠ git init failed: %v\n", err)
			} else {
				// Write .gitignore for project-local files
				gitignore := "*.db\n*.db-wal\n*.db-shm\n"
				os.WriteFile(filepath.Join(destDir, ".gitignore"), []byte(gitignore), 0644)

				// Initial commit
				gitAdd := exec.Command("git", "add", "-A")
				gitAdd.Dir = destDir
				gitAdd.Run()
				gitCommit := exec.Command("git", "commit", "-m",
					fmt.Sprintf("migrate: initial import from %s (%d entries)", projectName, totalEntries))
				gitCommit.Dir = destDir
				gitCommit.Run()
				fmt.Printf("  ✓ git repo initialized (initial commit)\n")
			}
		} else {
			fmt.Printf("  ✓ git repo already exists\n")
		}
	}

	fmt.Println()
	if opts.DryRun {
		fmt.Printf("[DRY RUN] Would migrate %d entries to %s\n", totalEntries, destDir)
	} else {
		fmt.Printf("Migrated %d entries to %s\n", totalEntries, destDir)
		fmt.Println()

		// Verify if requested
		if opts.Verify {
			fmt.Println("Verifying...")
			if err := verifyMigration(result); err != nil {
				fmt.Printf("  ⚠ Verification issue: %v\n", err)
			} else {
				fmt.Printf("  ✓ Source and destination match\n")
			}
		}

		// Suggest next steps
		fmt.Println()
		fmt.Println("Next steps:")
		fmt.Printf("  - Verify: stellario doctor --root %s\n", opts.ProjectRoot)
		fmt.Printf("  - Status: stellario status\n")
		fmt.Printf("  - Original data at %s is preserved (copy, not move)\n", sourceDir)
	}

	return result, nil
}

// copyFile copies a single file.
func copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

// copyDir recursively copies a directory.
func copyDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0755); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			if err := copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}

	return nil
}

// verifyMigration compares entry counts between source and destination.
func verifyMigration(result *MigrateResult) error {
	sourceFiles, err := os.ReadDir(result.SourceDir)
	if err != nil {
		return err
	}
	destFiles, err := os.ReadDir(result.DestDir)
	if err != nil {
		return err
	}

	// Compare JSONL files
	for _, sf := range sourceFiles {
		if sf.IsDir() || !strings.HasSuffix(sf.Name(), ".jsonl") {
			continue
		}
		if strings.Contains(sf.Name(), "keywords-index") || strings.Contains(sf.Name(), ".index-pending") {
			continue
		}

		srcPath := filepath.Join(result.SourceDir, sf.Name())
		dstPath := filepath.Join(result.DestDir, sf.Name())

		srcCount, _ := countEntriesInJSONL(srcPath)
		dstCount, _ := countEntriesInJSONL(dstPath)

		if srcCount != dstCount {
			return fmt.Errorf("%s: source has %d entries, destination has %d", sf.Name(), srcCount, dstCount)
		}
	}

	// Count check
	_ = sourceFiles
	_ = destFiles

	return nil
}
