package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"stellario/engine/cluster"
	"stellario/engine/store"
)

// ─── Doctor --compare ────────────────────────────────────────────────────────

// CompareResult holds the outcome of a JSONL vs SQLite comparison.
type CompareResult struct {
	Project     string
	JSONLCount  int
	SQLiteCount int
	Matches     int
	OnlyJSONL   []compareEntry
	OnlySQLite  []compareEntry
	Diffs       []compareDiff
}

type compareEntry struct {
	ID      string
	Volume  string
	Preview string
}

type compareDiff struct {
	ID       string
	Volume   string
	Field    string
	JSONLVal string
	SQLiteVal string
}

// RunDoctorCompare compares JSONL ground truth against SQLite.
// It syncs JSONL → SQLite first (non-destructive, uses existing sync),
// then checks that every entry matches.
//
// Usage:
//   stellario doctor --compare --root <project-dir>
//   stellario doctor --compare --project <name>  (uses global library)
func RunDoctorCompare(projectRoot string, projectName string) int {
	// Resolve source JSONL directory
	var jsonlDir string
	var projName string

	if projectName != "" {
		// Use global library — THIS device's subdir (device-relative)
		dir, err := cluster.LocalProjectDir(projectName)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			return 1
		}
		jsonlDir = dir
		projName = projectName
		if _, err := os.Stat(jsonlDir); os.IsNotExist(err) {
			fmt.Printf("Project %q not found in global library\n", projectName)
			return 1
		}
	} else {
		// Use project root
		projName = filepath.Base(projectRoot)
		jsonlDir = filepath.Join(projectRoot, ".opencode", ".stellario")
		if _, err := os.Stat(jsonlDir); os.IsNotExist(err) {
			jsonlDir = filepath.Join(projectRoot, ".stellario")
		}
		if _, err := os.Stat(jsonlDir); os.IsNotExist(err) {
			fmt.Printf("Memory directory not found for %s\n", projectRoot)
			return 1
		}
	}

	fmt.Printf("Comparing: %s\n", projName)
	fmt.Printf("  JSONL:  %s\n", jsonlDir)
	fmt.Println()

	// Step 1: Sync JSONL → SQLite
	fmt.Print("Syncing JSONL → SQLite... ")
	s, err := store.Open(store.DefaultDBPath())
	if err != nil {
		fmt.Printf("✗\nError opening database: %v\n", err)
		return 1
	}
	defer s.Close()

	report, err := s.SyncFromJSONL(projName, jsonlDir)
	if err != nil {
		fmt.Printf("✗\nSync error: %v\n", err)
		return 1
	}
	fmt.Printf("✓ %s\n", report.Summary())
	fmt.Println()

	// Step 2: Load JSONL entries (ground truth)
	jsonlEntries := loadJSONLEntriesForCompare(jsonlDir, projName)

	// Step 3: Load SQLite entries
	sqliteEntries, err := loadSQLiteEntriesForCompare(s, projName)
	if err != nil {
		fmt.Printf("Error loading SQLite entries: %v\n", err)
		return 1
	}

	// Step 4: Compare
	result := compareEntries(jsonlEntries, sqliteEntries, projName)

	// Step 5: Report
	printCompareResult(result)

	if len(result.OnlyJSONL) > 0 || len(result.OnlySQLite) > 0 || len(result.Diffs) > 0 {
		return 1
	}
	return 0
}

// RunDoctorCompareNoSync is like RunDoctorCompare but with a noSync option.
// When noSync is true, it skips the JSONL→SQLite sync step (for fanout verification).
func RunDoctorCompareNoSync(projectRoot string, projectName string, noSync bool) int {
	// Resolve source JSONL directory
	var jsonlDir string
	var projName string

	if projectName != "" {
		dir, err := cluster.LocalProjectDir(projectName)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			return 1
		}
		jsonlDir = dir
		projName = projectName
		if _, err := os.Stat(jsonlDir); os.IsNotExist(err) {
			fmt.Printf("Project %q not found in global library\n", projectName)
			return 1
		}
	} else {
		projName = filepath.Base(projectRoot)
		jsonlDir = filepath.Join(projectRoot, ".opencode", ".stellario")
		if _, err := os.Stat(jsonlDir); os.IsNotExist(err) {
			jsonlDir = filepath.Join(projectRoot, ".stellario")
		}
		if _, err := os.Stat(jsonlDir); os.IsNotExist(err) {
			fmt.Printf("Memory directory not found for %s\n", projectRoot)
			return 1
		}
	}

	fmt.Printf("Comparing: %s\n", projName)
	fmt.Printf("  JSONL:  %s\n", jsonlDir)
	fmt.Println()

	s, err := store.Open(store.DefaultDBPath())
	if err != nil {
		fmt.Printf("Error opening database: %v\n", err)
		return 1
	}
	defer s.Close()

	if !noSync {
		fmt.Print("Syncing JSONL → SQLite... ")
		report, err := s.SyncFromJSONL(projName, jsonlDir)
		if err != nil {
			fmt.Printf("✗\nSync error: %v\n", err)
			return 1
		}
		fmt.Printf("✓ %s\n", report.Summary())
		fmt.Println()
	} else {
		fmt.Println("(skipping sync — fanout verification mode)")
		fmt.Println()
	}

	// Load JSONL entries (ground truth)
	jsonlEntries := loadJSONLEntriesForCompare(jsonlDir, projName)

	// Load SQLite entries
	sqliteEntries, err := loadSQLiteEntriesForCompare(s, projName)
	if err != nil {
		fmt.Printf("Error loading SQLite entries: %v\n", err)
		return 1
	}

	// Compare
	result := compareEntries(jsonlEntries, sqliteEntries, projName)

	// Report
	printCompareResult(result)

	if len(result.OnlyJSONL) > 0 || len(result.OnlySQLite) > 0 || len(result.Diffs) > 0 {
		return 1
	}
	return 0
}

// entryKey is a composite key for comparison.
type entryKey struct {
	ID     string
	Volume string
}

type flatEntry struct {
	ID       string
	Volume   string
	Project  string
	Content  string
	Tags     []string
	Keywords []string
	Author   string
	Created  string
	Updated  string
}

func (e flatEntry) key() entryKey {
	return entryKey{ID: e.ID, Volume: e.Volume}
}

func loadJSONLEntriesForCompare(dir, project string) map[entryKey]flatEntry {
	result := map[entryKey]flatEntry{}

	files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return result
	}

	for _, file := range files {
		base := filepath.Base(file)
		if strings.Contains(base, "keywords-index") || strings.Contains(base, ".index-pending") {
			continue
		}

		entries := readAllEntries(file)
		volName := strings.TrimSuffix(base, ".jsonl")

		for _, e := range entries {
			vol := e.Volume
			if vol == "" {
				vol = volName
			}
			fe := flatEntry{
				ID:       e.ID,
				Volume:   vol,
				Project:  project,
				Content:  e.Content,
				Tags:     e.Tags,
				Keywords: e.Keywords,
				Author:   e.Author,
				Created:  e.Created,
				Updated:  e.Updated,
			}
			result[fe.key()] = fe
		}
	}

	return result
}

func loadSQLiteEntriesForCompare(s *store.Store, project string) (map[entryKey]flatEntry, error) {
	result := map[entryKey]flatEntry{}

	entries, _, err := s.LoadGraph(project)
	if err != nil {
		return result, err
	}

	for _, e := range entries {
		fe := flatEntry{
			ID:       e.ID,
			Volume:   e.Volume,
			Project:  e.Project,
			Content:  e.Content,
			Tags:     e.Tags,
			Keywords: e.Keywords,
			Author:   e.Author,
			Created:  e.CreatedAt.Format("2006-01-02"),
			Updated:  e.UpdatedAt.Format("2006-01-02"),
		}
		result[fe.key()] = fe
	}

	return result, nil
}

func compareEntries(jsonl, sqlite map[entryKey]flatEntry, project string) CompareResult {
	result := CompareResult{Project: project}

	// Find matches, only-JSONL, diffs
	for key, je := range jsonl {
		result.JSONLCount++

		se, exists := sqlite[key]
		if !exists {
			result.OnlyJSONL = append(result.OnlyJSONL, compareEntry{
				ID:      je.ID,
				Volume:  je.Volume,
				Preview: truncatePreview(je.Content, 60),
			})
			continue
		}

		result.Matches++

		// Check for content diffs
		if je.Content != se.Content {
			result.Diffs = append(result.Diffs, compareDiff{
				ID: je.ID, Volume: je.Volume, Field: "content",
				JSONLVal: truncatePreview(je.Content, 60),
				SQLiteVal: truncatePreview(se.Content, 60),
			})
		}

		if je.Author != se.Author {
			result.Diffs = append(result.Diffs, compareDiff{
				ID: je.ID, Volume: je.Volume, Field: "author",
				JSONLVal: je.Author,
				SQLiteVal: se.Author,
			})
		}
	}

	// Find only-SQLite
	for key, se := range sqlite {
		result.SQLiteCount++
		if _, exists := jsonl[key]; !exists {
			result.OnlySQLite = append(result.OnlySQLite, compareEntry{
				ID:      se.ID,
				Volume:  se.Volume,
				Preview: truncatePreview(se.Content, 60),
			})
		}
	}

	return result
}

func printCompareResult(r CompareResult) {
	fmt.Printf("─── Comparison Result ──────────────────────────\n")
	fmt.Printf("  JSONL entries:   %d\n", r.JSONLCount)
	fmt.Printf("  SQLite entries:  %d\n", r.SQLiteCount)
	fmt.Printf("  Matched:         %d\n", r.Matches)

	allGood := len(r.OnlyJSONL) == 0 && len(r.OnlySQLite) == 0 && len(r.Diffs) == 0

	if allGood {
		fmt.Println()
		fmt.Println("  ✓ JSONL and SQLite are in sync")
		return
	}

	if len(r.OnlyJSONL) > 0 {
		fmt.Println()
		fmt.Printf("  ⚠ %d entries only in JSONL (not in SQLite):\n", len(r.OnlyJSONL))
		for _, e := range r.OnlyJSONL {
			fmt.Printf("    %s:%s  %s\n", e.Volume, e.ID, e.Preview)
		}
	}

	if len(r.OnlySQLite) > 0 {
		fmt.Println()
		fmt.Printf("  ⚠ %d entries only in SQLite (not in JSONL):\n", len(r.OnlySQLite))
		for _, e := range r.OnlySQLite {
			fmt.Printf("    %s:%s  %s\n", e.Volume, e.ID, e.Preview)
		}
	}

	if len(r.Diffs) > 0 {
		fmt.Println()
		fmt.Printf("  ✗ %d entries with content differences:\n", len(r.Diffs))
		for _, d := range r.Diffs {
			fmt.Printf("    %s:%s  field: %s\n", d.Volume, d.ID, d.Field)
			fmt.Printf("      JSONL:  %s\n", d.JSONLVal)
			fmt.Printf("      SQLite: %s\n", d.SQLiteVal)
		}
	}

	fmt.Println()
	total := len(r.OnlyJSONL) + len(r.OnlySQLite) + len(r.Diffs)
	fmt.Printf("  %d discrepancy(s) found.\n", total)
}
