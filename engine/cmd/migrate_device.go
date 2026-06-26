package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"stellario/engine/cluster"
)

// ─── Migrate Device-Relative ─────────────────────────────────────────────────
//
// One-time migration from the flat layout (data directly under
// projects/{name}/) to the device-relative layout (data under
// projects/{name}/{device-id}/). Also strips star suffixes from entry IDs
// (a18.Sirius → a18), since the device-relative model uses per-device
// nonces in each device's own dir — no suffix needed.
//
// Idempotent: if the device subdir already contains data, it's a no-op.
// Stellario.yaml (shared config) stays at the container level.

// RunMigrateDeviceRelative migrates all projects + global from flat → device-relative.
func RunMigrateDeviceRelative() int {
	dev, err := cluster.GetOrCreateDeviceID()
	if err != nil {
		fmt.Printf("Error loading device identity: %v\n", err)
		return 1
	}

	fmt.Println("Stellario device-relative migration")
	fmt.Println("═══════════════════════════════════════════════════════")
	fmt.Printf("Device: %s (%s)\n", dev.ID, dev.Hostname)
	fmt.Println()

	migrated, stripped, report := migrateDeviceRelativeCore(dev.ID)

	for _, line := range report {
		fmt.Println(line)
	}
	fmt.Println()
	fmt.Printf("Done: moved %d files into device dirs, stripped %d star-suffixed IDs.\n", migrated, stripped)
	if migrated == 0 {
		fmt.Println("(Already on device-relative layout — nothing to do.)")
	}
	return 0
}

// migrateDeviceRelativeCore performs the migration without the header/footer,
// returning counts and per-container report lines. Used by both the standalone
// command (verbose) and setup (quiet).
func migrateDeviceRelativeCore(deviceID string) (migrated, stripped int, report []string) {
	// ── Projects ──
	projectsDir := cluster.ProjectsDir()
	if entries, err := os.ReadDir(projectsDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			container := filepath.Join(projectsDir, name)
			m, s, line, err := migrateContainer(container, deviceID, name)
			if err != nil {
				report = append(report, fmt.Sprintf("  ⚠ %s: %v", name, err))
				continue
			}
			migrated += m
			stripped += s
			if line != "" {
				report = append(report, line)
			}
		}
	}

	// ── Global ──
	globalContainer := cluster.GlobalVolumesDir()
	m, s, line, err := migrateContainer(globalContainer, deviceID, "_global")
	if err != nil {
		report = append(report, fmt.Sprintf("  ⚠ global: %v", err))
	}
	migrated += m
	stripped += s
	if line != "" {
		report = append(report, line)
	}

	return migrated, stripped, report
}

// migrateContainer moves loose data files from `container` into `container/{deviceID}/`,
// leaving stellario.yaml and other devices' subdirs untouched.
// Returns (filesMoved, idsStripped, reportLine, error).
func migrateContainer(container, deviceID, label string) (int, int, string, error) {
	entries, err := os.ReadDir(container)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, "", nil
		}
		return 0, 0, "", err
	}

	deviceDir := filepath.Join(container, deviceID)

	// Determine which loose entries are data to move (vs. config to keep).
	type moveTarget struct {
		srcName string
		isDir   bool
	}
	var toMove []moveTarget
	hasLooseData := false

	for _, e := range entries {
		name := e.Name()
		// Skip the device dir itself (already migrated) and other device dirs
		if e.IsDir() {
			if name == deviceID || isLikelyDeviceDir(filepath.Join(container, name)) {
				continue
			}
			// .track and other data dirs → move
			toMove = append(toMove, moveTarget{srcName: name, isDir: true})
			hasLooseData = true
			continue
		}
		// Generated index files: drop (they regenerate)
		if name == "keywords-index.jsonl" || name == "intent-log.jsonl" ||
			strings.Contains(name, ".index-pending") {
			continue
		}
		// All other files (incl. stellario.yaml config) → move into device dir
		toMove = append(toMove, moveTarget{srcName: name, isDir: false})
		hasLooseData = true
	}

	if !hasLooseData {
		return 0, 0, "", nil
	}

	// Create device dir
	if err := os.MkdirAll(deviceDir, 0755); err != nil {
		return 0, 0, "", fmt.Errorf("create device dir: %w", err)
	}

	moved := 0
	stripped := 0
	for _, mt := range toMove {
		src := filepath.Join(container, mt.srcName)
		dst := filepath.Join(deviceDir, mt.srcName)

		if mt.isDir {
			if err := moveDir(src, dst); err != nil {
				return moved, stripped, "", fmt.Errorf("move %s: %w", mt.srcName, err)
			}
		} else {
			if err := os.Rename(src, dst); err != nil {
				return moved, stripped, "", fmt.Errorf("move %s: %w", mt.srcName, err)
			}
			// Strip star suffixes from entry IDs in JSONL data files
			if strings.HasSuffix(mt.srcName, ".jsonl") && mt.srcName != "volumes.jsonl" {
				if n, err := stripStarSuffixesInFile(dst); err == nil {
					stripped += n
				}
			}
		}
		moved++
	}

	line := fmt.Sprintf("  ✓ %s: moved %d items into %s/", label, moved, deviceDir)
	return moved, stripped, line, nil
}

// isLikelyDeviceDir heuristically decides whether a subdir is a device-id dir
// (contains a stellario.yaml or .jsonl data) vs. something else. Device IDs
// look like "darwin-host-abc12". We treat any non-dot subdir as a potential
// device dir to avoid moving other devices' data.
func isLikelyDeviceDir(path string) bool {
	// Conservative: any subdirectory is assumed to be a device dir (or .track).
	// .track is handled as data-to-move above only if not recognized here.
	// We return true for dirs that look like device ids (contain a dash + hex tail).
	name := filepath.Base(path)
	if strings.HasPrefix(name, ".") {
		return false
	}
	// Device ids are generated as platform-shortHost-hex; require at least one dash
	// and a hex-looking tail to be confident.
	parts := strings.Split(name, "-")
	if len(parts) < 2 {
		return false
	}
	tail := parts[len(parts)-1]
	if len(tail) < 3 {
		return false
	}
	for _, c := range tail {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// moveDir renames src→dst; if rename fails (cross-device), copies recursively.
func moveDir(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	// Fallback: recursive copy + remove
	return copyDir(src, dst)
}

// stripStarSuffixesInFile rewrites a JSONL file, removing star suffixes from
// entry `id` fields and any ref `target` fields. Returns count of stripped IDs.
// Format per line: {"id":"a18.Sirius", ... "refs":[{"target":"a06.Sirius",...}]}
func stripStarSuffixesInFile(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	content := strings.TrimSpace(string(data))
	if content == "" {
		return 0, nil
	}

	lines := strings.Split(content, "\n")
	stripped := 0

	// First pass: collect target ids that will be renamed (for collision-aware renumbering)
	// and detect collisions within the file after stripping.
	seen := make(map[string]int) // strippedId → count
	type parsed struct {
		raw    map[string]interface{}
		oldID  string
		newID  string
		isData bool
	}
	var parsedLines []parsed

	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			parsedLines = append(parsedLines, parsed{raw: nil})
			continue
		}
		var obj map[string]interface{}
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			// Not JSON — keep as-is (shouldn't happen for data files)
			parsedLines = append(parsedLines, parsed{raw: nil})
			continue
		}
		p := parsed{raw: obj, isData: true}
		if id, ok := obj["id"].(string); ok {
			p.oldID = id
			p.newID = stripStarSuffixToken(id)
			if p.newID != id {
				stripped++
			}
		}
		// also strip ref targets
		if refs, ok := obj["refs"].([]interface{}); ok {
			for _, r := range refs {
				if ref, ok := r.(map[string]interface{}); ok {
					if t, ok := ref["target"].(string); ok {
						ref["target"] = stripStarSuffixToken(t)
					}
				}
			}
		}
		parsedLines = append(parsedLines, p)
		if p.newID != "" {
			seen[p.newID]++
		}
	}

	// Resolve collisions: if a stripped id appears more than once, renumber later ones.
	finalID := make(map[string]string) // oldID → finalID
	used := make(map[string]bool)
	// preserve order by first appearance
	for _, p := range parsedLines {
		if p.newID == "" {
			continue
		}
		if seen[p.newID] > 1 {
			// potential collision — assign uniquely
			cand := p.newID
			if used[cand] {
				cand = nextFreeID(p.newID, used)
				stripped++ // counting renumber as a strip too (shape change)
			}
			finalID[p.oldID] = cand
			used[cand] = true
		} else {
			finalID[p.oldID] = p.newID
			used[p.newID] = true
		}
	}

	// Second pass: rewrite
	var out []string
	for _, p := range parsedLines {
		if p.raw == nil {
			continue
		}
		if p.isData && p.oldID != "" {
			if fin, ok := finalID[p.oldID]; ok {
				p.raw["id"] = fin
			}
		}
		b, err := json.Marshal(p.raw)
		if err != nil {
			out = append(out, "{}")
			continue
		}
		out = append(out, string(b))
	}

	newContent := strings.Join(out, "\n") + "\n"
	return stripped, os.WriteFile(path, []byte(newContent), 0644)
}

// stripStarSuffixToken removes a star suffix from an id token.
// "a18.Sirius" → "a18", "a18" → "a18".
// Only strips if the part after the dot starts with an uppercase letter
// (star names are capitalized; version-like suffixes are not).
func stripStarSuffixToken(id string) string {
	dot := strings.Index(id, ".")
	if dot <= 0 || dot >= len(id)-1 {
		return id
	}
	if c := id[dot+1]; c >= 'A' && c <= 'Z' {
		return id[:dot]
	}
	return id
}

// nextFreeID finds the next non-colliding id by bumping the numeric tail.
// "a18" → "a19", "a19" → "a20", etc.
func nextFreeID(base string, used map[string]bool) string {
	// split prefix (non-digit) and number
	i := len(base)
	for i > 0 && base[i-1] >= '0' && base[i-1] <= '9' {
		i--
	}
	prefix := base[:i]
	num := 0
	if i < len(base) {
		fmt.Sscanf(base[i:], "%d", &num)
	}
	for {
		num++
		cand := fmt.Sprintf("%s%d", prefix, num)
		// zero-pad to match original width
		if i < len(base) {
			cand = fmt.Sprintf("%s%0*d", prefix, len(base)-i, num)
		}
		if !used[cand] {
			return cand
		}
	}
}

// (sorted import stub to keep sort referenced if needed later)
var _ = sort.Strings
