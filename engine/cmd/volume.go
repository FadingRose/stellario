package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"stellario/engine/cluster"
	"stellario/engine/config"
)

// ─── Volume Commands ─────────────────────────────────────────────────────────

// RunVolumeList lists volumes with entry counts.
//   stellario volume list                          → all projects
//   stellario volume list --project valhalla       → single project
//   stellario volume list --global                 → global volumes only
func RunVolumeList(args []string) int {
	projectFlag := getStrFlag(args, "--project")
	globalFlag := hasFlag(args, "--global")

	if globalFlag {
		return listGlobalVolumes()
	}

	if projectFlag != "" {
		return listSingleProjectVolumes(projectFlag)
	}

	return listAllProjectVolumes()
}

// RunVolumeStats shows detailed statistics for a volume.
//   stellario volume stats <name> --project valhalla
func RunVolumeStats(args []string) int {
	if len(args) == 0 {
		fmt.Println("Usage: stellario volume stats <name> [--project <name>]")
		return 1
	}

	volumeName := args[0]
	projectName := getStrFlag(args, "--project")

	if projectName == "" {
		fmt.Println("Error: --project is required for volume stats")
		fmt.Println("Usage: stellario volume stats <name> --project <name>")
		return 1
	}

	projectDir := cluster.ProjectDir(projectName)
	jsonlPath := findVolumeFile(projectDir, volumeName)

	if jsonlPath == "" {
		fmt.Printf("Volume %q not found in project %q\n", volumeName, projectName)
		return 1
	}

	entries := readAllEntries(jsonlPath)
	if len(entries) == 0 {
		fmt.Printf("Volume %q in %q is empty\n", volumeName, projectName)
		return 0
	}

	// Load config to get profile (config lives in device dir, or container)
	var profile string
	configPath := findProjectConfig(projectDir)
	if vres, err := config.LoadAndValidatePath(configPath); err == nil && vres.Config != nil {
		if vol, ok := vres.Config.Volumes[volumeName]; ok {
			profile = string(vol.Profile)
		}
	}

	// Compute stats
	totalContent := 0
	tagCounts := map[string]int{}
	authorCounts := map[string]int{}
	dateRange := struct{ first, last string }{"", ""}
	for _, e := range entries {
		totalContent += len(e.Content)
		for _, t := range e.Tags {
			tagCounts[t]++
		}
		authorCounts[e.Author]++
		if dateRange.first == "" || e.Created < dateRange.first {
			dateRange.first = e.Created
		}
		if e.Updated > dateRange.last {
			dateRange.last = e.Updated
		}
	}

	fmt.Printf("Volume: %s (project: %s)\n", volumeName, projectName)
	fmt.Println("═══════════════════════════════════════════════════════")
	fmt.Printf("  Profile:      %s\n", profile)
	fmt.Printf("  Entries:      %d\n", len(entries))
	fmt.Printf("  Total size:   %s (%d chars)\n", humanBytes(totalContent), totalContent)
	fmt.Printf("  Date range:   %s → %s\n", dateRange.first, dateRange.last)
	fmt.Println()

	// Top tags
	if len(tagCounts) > 0 {
		fmt.Println("  Tags:")
		sortedTags := sortCounts(tagCounts)
		for i, tc := range sortedTags {
			if i >= 10 {
				fmt.Printf("    ... and %d more\n", len(sortedTags)-10)
				break
			}
			fmt.Printf("    %-30s %d\n", tc.key, tc.count)
		}
		fmt.Println()
	}

	// Authors
	if len(authorCounts) > 0 {
		fmt.Println("  Authors:")
		for _, ac := range sortCounts(authorCounts) {
			fmt.Printf("    %-20s %d entries\n", ac.key, ac.count)
		}
	}

	return 0
}

// RunVolumeGrep searches entry content across volumes.
//   stellario volume grep <pattern> --project valhalla
//   stellario volume grep <pattern> --project valhalla --volume active
//   stellario volume grep <pattern>                  → all projects
func RunVolumeGrep(args []string) int {
	if len(args) == 0 {
		fmt.Println("Usage: stellario volume grep <pattern> [--project <name>] [--volume <name>]")
		return 1
	}

	pattern := strings.ToLower(args[0])
	projectFlag := getStrFlag(args, "--project")
	volumeFlag := getStrFlag(args, "--volume")

	if projectFlag != "" {
		return grepInProject(projectFlag, volumeFlag, pattern)
	}

	// All projects
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	totalMatches := 0
	for projectName := range pm.Projects {
		matches := grepInProject(projectName, volumeFlag, pattern)
		totalMatches += matches
	}

	fmt.Println()
	fmt.Printf("Total: %d matches\n", totalMatches)
	return 0
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func listGlobalVolumes() int {
	globalVolDir := cluster.GlobalVolumesDir()
	volumes := listProjectVolumesDetailed(globalVolDir)

	if len(volumes) == 0 {
		fmt.Println("No global volumes found.")
		return 0
	}

	fmt.Println("Global Volumes")
	fmt.Println("═══════════════════════════════════════════════════════")
	printVolumeTable(volumes)
	return 0
}

func listSingleProjectVolumes(projectName string) int {
	projectDir := cluster.ProjectDir(projectName)
	if _, err := os.Stat(projectDir); os.IsNotExist(err) {
		fmt.Printf("Project %q not found in global library.\n", projectName)
		return 1
	}

	// Load config for profiles
	var cfg *config.StellarioConfig
	configPath := findProjectConfig(projectDir)
	if vres, err := config.LoadAndValidatePath(configPath); err == nil && vres.Config != nil {
		cfg = vres.Config
	}

	volumes := listProjectVolumesDetailed(projectDir)

	if len(volumes) == 0 {
		fmt.Printf("No volumes found in project %q.\n", projectName)
		return 0
	}

	fmt.Printf("Volumes: %s\n", projectName)
	fmt.Println("═══════════════════════════════════════════════════════")

	for i := range volumes {
		if cfg != nil {
			if vol, ok := cfg.Volumes[volumes[i].Name]; ok {
				volumes[i].Profile = string(vol.Profile)
				isSystem := config.IsSystemVolume(volumes[i].Name)
				if isSystem {
					volumes[i].System = true
				}
			}
		}
	}

	printVolumeTable(volumes)
	return 0
}

func listAllProjectVolumes() int {
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	if len(pm.Projects) == 0 {
		fmt.Println("No projects registered.")
		return 0
	}

	// Sort project names for stable output
	names := make([]string, 0, len(pm.Projects))
	for n := range pm.Projects {
		names = append(names, n)
	}
	sort.Strings(names)

	for _, name := range names {
		fmt.Printf("─── %s ──────────────────────────\n", name)
		listSingleProjectVolumes(name)
		fmt.Println()
	}

	return 0
}

type volumeStat struct {
	Name      string
	Profile   string
	System    bool
	Entries   int
	SizeBytes int
	LastMod   time.Time
}

// globAllVolumeFiles returns all data .jsonl files under a container, recursing
// one level into device-id subdirs (device-relative layout) as well as the
// container itself (legacy flat layout). Generated index files are excluded.
func globAllVolumeFiles(container string) []string {
	var files []string
	seen := map[string]bool{}
	add := func(fs []string) {
		for _, f := range fs {
			base := filepath.Base(f)
			if base == "volumes.jsonl" ||
				strings.Contains(base, "keywords-index") || strings.Contains(base, ".index-pending") {
				continue
			}
			if !seen[f] {
				seen[f] = true
				files = append(files, f)
			}
		}
	}
	if fs, err := filepath.Glob(filepath.Join(container, "*.jsonl")); err == nil {
		add(fs)
	}
	if entries, err := os.ReadDir(container); err == nil {
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			if fs, err := filepath.Glob(filepath.Join(container, e.Name(), "*.jsonl")); err == nil {
				add(fs)
			}
		}
	}
	return files
}

// findVolumeFile locates a single volume's .jsonl under a container, checking
// device subdirs first, then the container itself. Returns "" if not found.
func findVolumeFile(container, volumeName string) string {
	if entries, err := os.ReadDir(container); err == nil {
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			cand := filepath.Join(container, e.Name(), volumeName+".jsonl")
			if _, err := os.Stat(cand); err == nil {
				return cand
			}
		}
	}
	cand := filepath.Join(container, volumeName+".jsonl")
	if _, err := os.Stat(cand); err == nil {
		return cand
	}
	return ""
}

// findProjectConfig locates stellario.yaml for a project container, checking
// device subdirs first (device-relative layout), then the container itself.
func findProjectConfig(container string) string {
	if entries, err := os.ReadDir(container); err == nil {
		// prefer the local device's dir if identifiable, else first device dir
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			cand := filepath.Join(container, e.Name(), "stellario.yaml")
			if _, err := os.Stat(cand); err == nil {
				return cand
			}
		}
	}
	cand := filepath.Join(container, "stellario.yaml")
	if _, err := os.Stat(cand); err == nil {
		return cand
	}
	return ""
}

func listProjectVolumesDetailed(dir string) []volumeStat {
	var volumes []volumeStat

	files := globAllVolumeFiles(dir)

	for _, file := range files {
		base := filepath.Base(file)
		name := strings.TrimSuffix(base, ".jsonl")
		entries := readAllEntries(file)

		info, _ := os.Stat(file)

		volumes = append(volumes, volumeStat{
			Name:      name,
			Entries:   len(entries),
			SizeBytes: int(info.Size()),
			LastMod:   info.ModTime(),
		})
	}

	sort.Slice(volumes, func(i, j int) bool {
		return volumes[i].Name < volumes[j].Name
	})

	return volumes
}

func printVolumeTable(volumes []volumeStat) {
	fmt.Printf("  %-20s %-10s %8s  %10s  %s\n", "VOLUME", "PROFILE", "ENTRIES", "SIZE", "LAST MOD")
	for _, v := range volumes {
		systemTag := ""
		if v.System {
			systemTag = " *"
		}
		profile := v.Profile
		if profile == "" {
			profile = "?"
		}
		fmt.Printf("  %-20s %-10s %8d  %10s  %s%s\n",
			v.Name,
			profile,
			v.Entries,
			humanBytes(v.SizeBytes),
			v.LastMod.Format("2006-01-02"),
			systemTag,
		)
	}
	fmt.Println("  (* = system volume)")
}

func grepInProject(projectName, volumeFlag, pattern string) int {
	projectDir := cluster.ProjectDir(projectName)

	var files []string
	if volumeFlag != "" {
		if f := findVolumeFile(projectDir, volumeFlag); f != "" {
			files = []string{f}
		}
	} else {
		files = globAllVolumeFiles(projectDir)
	}

	matches := 0
	for _, file := range files {
		base := filepath.Base(file)
		if strings.Contains(base, "keywords-index") || strings.Contains(base, ".index-pending") {
			continue
		}

		entries := readAllEntries(file)
		volName := strings.TrimSuffix(base, ".jsonl")

		for _, e := range entries {
			content := strings.ToLower(e.Content)
			if strings.Contains(content, pattern) {
				matches++
				preview := truncatePreview(e.Content, 100)
				fullID := fmt.Sprintf("%s:%s", projectName, e.ID)
				fmt.Printf("  %s  [%s]  %s\n", fullID, volName, preview)
			}
		}
	}

	return matches
}

// readAllEntries parses a JSONL file into entries.
type entryData struct {
	ID       string   `json:"id"`
	Volume   string   `json:"volume"`
	Content  string   `json:"content"`
	Tags     []string `json:"tags"`
	Keywords []string `json:"keywords"`
	Author   string   `json:"author"`
	Created  string   `json:"created"`
	Updated  string   `json:"updated"`
}

func readAllEntries(path string) []entryData {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var entries []entryData
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var e entryData
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	return entries
}

type countEntry struct {
	key   string
	count int
}

func sortCounts(m map[string]int) []countEntry {
	result := make([]countEntry, 0, len(m))
	for k, v := range m {
		result = append(result, countEntry{key: k, count: v})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].count > result[j].count
	})
	return result
}

func humanBytes(n int) string {
	if n < 1024 {
		return fmt.Sprintf("%dB", n)
	}
	if n < 1024*1024 {
		return fmt.Sprintf("%.1fKB", float64(n)/1024)
	}
	return fmt.Sprintf("%.1fMB", float64(n)/(1024*1024))
}

func truncatePreview(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

// Flag helpers
func getStrFlag(args []string, name string) string {
	for i, arg := range args {
		if arg == name && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"=")
		}
	}
	return ""
}

func hasFlag(args []string, name string) bool {
	for _, arg := range args {
		if arg == name {
			return true
		}
	}
	return false
}
