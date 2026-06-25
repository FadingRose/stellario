package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"stellario/engine/config"
)

// ─── Doctor ──────────────────────────────────────────────────────────────────

type checkResult struct {
	ok      bool
	symbol  string // ✓ ⚠ ✗
	detail  string
	hint    string // optional fix suggestion
}

type checkSection struct {
	name    string
	results []checkResult
}

// RunDoctor performs comprehensive diagnostics on a stellario project.
// It is READ-ONLY — never modifies any files.
func RunDoctor(projectRoot string) int {
	fmt.Println("Checking stellario installation...")
	fmt.Println()

	var sections []checkSection

	// ── 1. Config discovery + validation ──
	configSection := checkSection{name: "Configuration"}

	configPath := findConfig(projectRoot)
	if configPath == "" {
		configSection.results = append(configSection.results, checkResult{
			ok:     false,
			symbol: "✗",
			detail: fmt.Sprintf("No stellario.yaml found in %s", projectRoot),
			hint:   "Run 'stellario init' to create one",
		})
		sections = append(sections, configSection)
		printSections(sections)
		return 1
	}

	configSection.results = append(configSection.results, checkResult{
		ok:     true,
		symbol: "✓",
		detail: fmt.Sprintf("Config: %s", configPath),
	})

	// Load and validate config
	vres, err := config.LoadAndValidatePath(configPath)
	if err != nil {
		configSection.results = append(configSection.results, checkResult{
			ok:     false,
			symbol: "✗",
			detail: fmt.Sprintf("Config load error: %v", err),
		})
		sections = append(sections, configSection)
		printSections(sections)
		return 1
	}

	if len(vres.Errors) == 0 {
		configSection.results = append(configSection.results, checkResult{
			ok:     true,
			symbol: "✓",
			detail: "Config validation: no errors",
		})
	} else {
		for _, e := range vres.Errors {
			configSection.results = append(configSection.results, checkResult{
				ok:     false,
				symbol: "✗",
				detail: e.Error(),
				hint:   suggestConfigFix(e),
			})
		}
	}

	if len(vres.Warnings) > 0 {
		for _, w := range vres.Warnings {
			configSection.results = append(configSection.results, checkResult{
				ok:     true,
				symbol: "⚠",
				detail: w.Error(),
			})
		}
	}

	sections = append(sections, configSection)

	// If config has errors, skip Memory and Git checks — they depend on valid config
	cfg := vres.Config
	if len(vres.Errors) > 0 {
		printSections(sections)
		totalErrors := len(vres.Errors)
		fmt.Println()
		fmt.Printf("%d issue(s) found. Fix config errors before checking memory.\n", totalErrors)
		return 1
	}

	// Config is valid — add summary and continue to Memory/Git checks
	configSection.results = append(configSection.results, checkResult{
		ok:     true,
		symbol: "✓",
		detail: fmt.Sprintf("Volumes: %d defined, Agents: %d defined", len(cfg.Volumes), len(cfg.Agents)),
	})
	// Update the section already in sections (it was appended above)
	sections[len(sections)-1] = configSection

	// ── 2. Memory directory + JSONL integrity ──
	memSection := checkMemoryIntegrity(projectRoot, cfg)
	sections = append(sections, memSection)

	// ── 3. Git repo ──
	gitSection := checkGitRepo(projectRoot, cfg)
	sections = append(sections, gitSection)

	// ── Print all sections ──
	printSections(sections)

	// ── Summary ──
	totalErrors := 0
	totalWarnings := 0
	for _, s := range sections {
		for _, r := range s.results {
			if r.symbol == "✗" {
				totalErrors++
			} else if r.symbol == "⚠" {
				totalWarnings++
			}
		}
	}

	fmt.Println()
	if totalErrors == 0 && totalWarnings == 0 {
		fmt.Println("All checks passed. No issues found.")
	} else {
		fmt.Printf("%d issue(s), %d warning(s) found.\n", totalErrors, totalWarnings)
	}

	if totalErrors > 0 {
		return 1
	}
	return 0
}

// findConfig locates stellario.yaml in .opencode/ or project root.
func findConfig(projectRoot string) string {
	candidates := []string{
		filepath.Join(projectRoot, ".opencode", "stellario.yaml"),
		filepath.Join(projectRoot, "stellario.yaml"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// checkMemoryIntegrity verifies JSONL files are parseable and counts entries.
func checkMemoryIntegrity(projectRoot string, cfg *config.StellarioConfig) checkSection {
	section := checkSection{name: "Memory"}

	memDir := filepath.Join(projectRoot, cfg.MemoryDir)
	if _, err := os.Stat(memDir); os.IsNotExist(err) {
		section.results = append(section.results, checkResult{
			ok:     false,
			symbol: "✗",
			detail: fmt.Sprintf("Memory directory not found: %s", memDir),
			hint:   "Memory will be created on first write",
		})
		return section
	}

	section.results = append(section.results, checkResult{
		ok:     true,
		symbol: "✓",
		detail: fmt.Sprintf("Memory directory: %s", memDir),
	})

	// Check each volume's JSONL
	files, err := filepath.Glob(filepath.Join(memDir, "*.jsonl"))
	if err != nil {
		section.results = append(section.results, checkResult{
			ok:     false,
			symbol: "✗",
			detail: fmt.Sprintf("Cannot scan memory files: %v", err),
		})
		return section
	}

	for _, file := range files {
		base := filepath.Base(file)
		// Skip generated files
		if base == "keywords-index.jsonl" || strings.Contains(base, ".track") {
			continue
		}

		volName := strings.TrimSuffix(base, ".jsonl")
		count, parseErrors := countEntriesInJSONL(file)

		if len(parseErrors) > 0 {
			section.results = append(section.results, checkResult{
				ok:     false,
				symbol: "✗",
				detail: fmt.Sprintf("%s: %d entries, %d parse errors", volName, count, len(parseErrors)),
				hint:   parseErrors[0],
			})
		} else {
			section.results = append(section.results, checkResult{
				ok:     true,
				symbol: "✓",
				detail: fmt.Sprintf("%s: %d entries, all valid", volName, count),
			})
		}
	}

	// Verify all configured volumes have data (warning if not)
	for volName := range cfg.Volumes {
		jsonlPath := filepath.Join(memDir, volName+".jsonl")
		if _, err := os.Stat(jsonlPath); os.IsNotExist(err) {
			section.results = append(section.results, checkResult{
				ok:     true,
				symbol: "⚠",
				detail: fmt.Sprintf("Volume %q has no data file yet (will be created on first write)", volName),
			})
		}
	}

	return section
}

// countEntriesInJSONL reads a JSONL file and counts valid entries.
func countEntriesInJSONL(path string) (int, []string) {
	f, err := os.Open(path)
	if err != nil {
		return 0, []string{fmt.Sprintf("cannot open: %v", err)}
	}
	defer f.Close()

	count := 0
	var parseErrors []string

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var entry map[string]interface{}
		if err := json.Unmarshal(line, &entry); err != nil {
			parseErrors = append(parseErrors, fmt.Sprintf("line %d: %v", lineNum, err))
			continue
		}
		count++
	}

	return count, parseErrors
}

// checkGitRepo verifies the memory directory has a git repo for version control.
func checkGitRepo(projectRoot string, cfg *config.StellarioConfig) checkSection {
	section := checkSection{name: "Git"}

	memDir := filepath.Join(projectRoot, cfg.MemoryDir)
	gitDir := filepath.Join(memDir, ".git")

	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		section.results = append(section.results, checkResult{
			ok:     true,
			symbol: "⚠",
			detail: "No git repo in memory directory",
			hint:   "Git repo will be initialized on first tracked write",
		})
		return section
	}

	section.results = append(section.results, checkResult{
		ok:     true,
		symbol: "✓",
		detail: "Git repo initialized",
	})

	// Check for uncommitted changes (simplified check)
	// We won't shell out to git here — just verify the repo exists
	// Full git status check will be added in sync phase

	return section
}

// suggestConfigFix provides actionable hints for common config errors.
func suggestConfigFix(e config.ValidationError) string {
	msg := e.Message

	if strings.Contains(msg, `at most one volume can have profile "workspace"`) {
		return "Remove 'profile: workspace' from user-defined volume, or rename it. System volume 'layer' already uses workspace profile."
	}

	if strings.Contains(msg, "idPrefix conflict") {
		return "Add explicit 'idPrefix:' to one of the conflicting volumes to make prefixes unique."
	}

	if strings.Contains(msg, `"boundaries" is required`) {
		return "Add 'boundaries: { read: [...], write: [...] }' to this volume definition."
	}

	return ""
}

// printSections outputs all check results in agent-friendly format.
func printSections(sections []checkSection) {
	for _, s := range sections {
		fmt.Printf("─── %s ──────────────────────────\n", s.name)
		for _, r := range s.results {
			fmt.Printf("  %s %s\n", r.symbol, r.detail)
			if r.hint != "" {
				fmt.Printf("    → %s\n", r.hint)
			}
		}
		fmt.Println()
	}
}
