package reader

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"stellario/engine/types"
)

// JSONLEntry represents the on-disk format of a stellario entry.
// This matches the current TS stellario format exactly.
type JSONLEntry struct {
	ID        string `json:"id"`
	Volume    string `json:"volume"`
	Content   string `json:"content"`
	Tags      []string `json:"tags"`
	Keywords  []string `json:"keywords"`
	Author    string `json:"author"`
	Created   string `json:"created"`
	Updated   string `json:"updated"`
	Refs      []JSONLRef `json:"refs,omitempty"`
	RefsRemoved []string `json:"refs_removed,omitempty"`
}

type JSONLRef struct {
	Target string `json:"target"`
	Reason string `json:"reason"`
	Source string `json:"source"` // "manual" or "auto"
}

// ReadProject reads all JSONL files from a stellario project directory.
// Returns entries and extracted edges (from refs + frame type inference).
func ReadProject(stellarioDir string) ([]types.Entry, []types.Edge, error) {
	var allEntries []types.Entry
	var allEdges []types.Edge

	// Find all .jsonl files (exclude generated index files)
	files, err := filepath.Glob(filepath.Join(stellarioDir, "*.jsonl"))
	if err != nil {
		return nil, nil, fmt.Errorf("glob jsonl: %w", err)
	}

	for _, file := range files {
		base := filepath.Base(file)
		// Skip generated files
		if base == "keywords-index.jsonl" || strings.Contains(base, ".track") {
			continue
		}

		entries, edges, err := readJSONL(file)
		if err != nil {
			return nil, nil, fmt.Errorf("read %s: %w", base, err)
		}
		allEntries = append(allEntries, entries...)
		allEdges = append(allEdges, edges...)
	}

	return allEntries, allEdges, nil
}

func readJSONL(path string) ([]types.Entry, []types.Edge, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	var entries []types.Entry
	var edges []types.Edge

	scanner := bufio.NewScanner(f)
	// Increase buffer size for large entries
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var raw JSONLEntry
		if err := json.Unmarshal(line, &raw); err != nil {
			continue // Skip malformed lines
		}

		// Convert to internal Entry type
		entry := types.Entry{
			ID:        raw.ID,
			Volume:    raw.Volume,
			Content:   raw.Content,
			Tags:      raw.Tags,
			Keywords:  raw.Keywords,
			Author:    raw.Author,
			FrameType: inferFrameType(raw),
			Active:    true, // Default; will be updated from edges
			CreatedAt: parseDate(raw.Created),
			UpdatedAt: parseDate(raw.Updated),
		}

		entries = append(entries, entry)

		// Extract edges from refs
		for _, ref := range raw.Refs {
			// Determine edge type from reason
			edgeType := types.EdgeRef
			reasonLower := strings.ToLower(ref.Reason)
			if strings.Contains(reasonLower, "supersed") || strings.Contains(reasonLower, "取代") || strings.Contains(reasonLower, "替代") {
				edgeType = types.EdgeSupersede
			} else if strings.Contains(reasonLower, "validat") || strings.Contains(reasonLower, "验证") {
				edgeType = types.EdgeValidates
			} else if strings.Contains(reasonLower, "deriv") || strings.Contains(reasonLower, "来源") || strings.Contains(reasonLower, "源自") || strings.Contains(reasonLower, "基于") {
				edgeType = types.EdgeDeriveFrom
			} else if strings.Contains(reasonLower, "constrain") || strings.Contains(reasonLower, "约束") {
				edgeType = types.EdgeConstrains
			}

			edges = append(edges, types.Edge{
				Source: raw.ID,
				Target: ref.Target,
				Type:   edgeType,
				Reason: ref.Reason,
			})
		}
	}

	return entries, edges, scanner.Err()
}

// inferFrameType attempts to determine the frame type from entry tags and content.
// This is a best-effort inference for legacy data that doesn't have explicit frame_type.
func inferFrameType(raw JSONLEntry) types.FrameType {
	// Check for explicit frame type in tags
	for _, tag := range raw.Tags {
		switch tag {
		case "layer:foundation", "type:scope", "type:trust_assumption", "type:architecture":
			return types.FrameAssert
		case "layer:meta", "type:observation", "type:concern", "type:question":
			return types.FrameAssert
		case "layer:analysis", "type:hypothesis", "type:insight":
			return types.FrameDerive
		case "layer:findings", "type:issue":
			return types.FrameDerive
		case "layer:session", "type:checkpoint", "type:plan":
			return types.FrameCheckpoint
		}
	}

	// Default
	return types.FrameAssert
}

func parseDate(s string) time.Time {
	// Current stellario format: "YYYY-MM-DD"
	if len(s) >= 10 {
		t, _ := time.Parse("2006-01-02", s[:10])
		return t
	}
	return time.Time{}
}
