package orchestrator

import (
	"encoding/json"
	"sort"
	"strings"
	"time"

	"stellario/engine/types"
)

// Orchestrator builds arc streams from entries and edges.
// It is a pure in-memory structure — no database, no files.
// State is loaded once (by reader) and passed in.
type Orchestrator struct {
	entries map[string]*types.Entry // id → entry
	edges   []types.Edge
	// Index for fast lookup
	outgoing map[string][]*types.Edge // source → edges
	incoming map[string][]*types.Edge // target → edges
}

// New creates an orchestrator from raw entries and edges.
func New(entries []types.Entry, edges []types.Edge) *Orchestrator {
	o := &Orchestrator{
		entries:  make(map[string]*types.Entry),
		outgoing: make(map[string][]*types.Edge),
		incoming: make(map[string][]*types.Edge),
	}

	// Index entries
	for i := range entries {
		e := &entries[i]
		o.entries[e.ID] = e

		// Check active state: if any supersede edge points to this entry, it's inactive
		e.Active = true
	}

	// Index edges and compute active state
	o.edges = edges
	for i := range edges {
		edge := &o.edges[i]
		o.outgoing[edge.Source] = append(o.outgoing[edge.Source], edge)
		o.incoming[edge.Target] = append(o.incoming[edge.Target], edge)

		// Supersede marks target as inactive
		if edge.Type == types.EdgeSupersede {
			if target, ok := o.entries[edge.Target]; ok {
				target.Active = false
			}
		}
	}

	return o
}

// ConstellationRequest is the input to a constellation query.
type ConstellationRequest struct {
	Bid       string   `json:"bid"`
	Hints     []string `json:"hints,omitempty"`
	Volume    string   `json:"volume,omitempty"`
	TagFilter string   `json:"tag_filter,omitempty"`
}

// ConstellationResult is the output.
type ConstellationResult struct {
	Arcs     []ArcEntry       `json:"arcs"`
	Metadata ConstellationMeta `json:"metadata"`
}

type ArcEntry struct {
	ID        string            `json:"id"`
	Volume    string            `json:"volume"`
	Content   string            `json:"content"`
	Tags      []string          `json:"tags"`
	Keywords  []string          `json:"keywords"`
	FrameType types.FrameType   `json:"frame_type"`
	Active    bool              `json:"active"`
	CreatedAt time.Time         `json:"created_at"`
}

type MetaEdge struct {
	From string         `json:"from"`
	To   string         `json:"to"`
	Type types.EdgeType `json:"type"`
}

// ConstellationMeta is metadata about the arc stream.
// All fields are projections of data agent already wrote — no new judgments.
type ConstellationMeta struct {
	Frames      []string   `json:"frames"`
	Edges       []MetaEdge `json:"edges"`
	HintsApplied []string  `json:"hints_applied"`
	HintsIgnored []string  `json:"hints_ignored"`
	TotalCandidates int    `json:"total_candidates"`
}

// Constellation builds an arc stream from a bid + hints.
// Phase 1: keyword/tag search + causal topological sort.
// Hints are accepted but not yet processed (future: small model translation).
func (o *Orchestrator) Constellation(req ConstellationRequest) (*ConstellationResult, error) {
	// 1. Collect: search by bid keywords + tag filter
	candidates := o.search(req.Bid, req.Volume, req.TagFilter)

	// 2. Filter: remove superseded entries (unless hint says otherwise)
	active := o.filterActive(candidates)

	// 3. Sort: topological by derive_from, fallback to created_at
	sorted := o.causalSort(active)

	// 4. Project metadata
	meta := o.projectMetadata(sorted)

	// Hints not yet processed
	meta.HintsIgnored = []string{}
	for _, h := range req.Hints {
		_ = h // Phase 2: translate via small model
		meta.HintsIgnored = append(meta.HintsIgnored, h)
	}
	meta.TotalCandidates = len(candidates)

	// 5. Build arc entries
	arcs := make([]ArcEntry, 0, len(sorted))
	for _, e := range sorted {
		arcs = append(arcs, ArcEntry{
			ID:        e.ID,
			Volume:    e.Volume,
			Content:   e.Content,
			Tags:      e.Tags,
			Keywords:  e.Keywords,
			FrameType: e.FrameType,
			Active:    e.Active,
			CreatedAt: e.CreatedAt,
		})
	}

	return &ConstellationResult{Arcs: arcs, Metadata: meta}, nil
}

// search finds entries matching the bid keywords + filters.
func (o *Orchestrator) search(bid, volume, tagFilter string) []*types.Entry {
	bidLower := strings.ToLower(bid)
	bidTokens := tokenize(bidLower)

	var result []*types.Entry
	for _, e := range o.entries {
		// Volume filter
		if volume != "" && e.Volume != volume {
			continue
		}

		// Tag filter
		if tagFilter != "" {
			found := false
			for _, t := range e.Tags {
				if strings.Contains(t, tagFilter) {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}

		// Keyword/token matching
		if len(bidTokens) > 0 {
			score := scoreMatch(e, bidLower, bidTokens)
			if score == 0 {
				continue
			}
		}

		result = append(result, e)
	}

	// Sort by relevance score (simplified: just keep insertion order for now)
	return result
}

// filterActive removes entries that have been superseded.
func (o *Orchestrator) filterActive(entries []*types.Entry) []*types.Entry {
	var result []*types.Entry
	for _, e := range entries {
		if e.Active {
			result = append(result, e)
		}
	}
	return result
}

// causalSort performs topological sort based on derive_from edges.
// Entries that are derived-from sources come before entries that derive from them.
// Entries with no causal relationship are sorted by created_at.
func (o *Orchestrator) causalSort(entries []*types.Entry) []*types.Entry {
	// Build a set of entry IDs in the candidate set
	idSet := make(map[string]bool)
	for _, e := range entries {
		idSet[e.ID] = true
	}

	// Build adjacency: for each entry, what entries must come BEFORE it?
	// If B has derive_from edge to A (B derives from A), then A must come before B.
	deps := make(map[string][]string) // entry → its prerequisites
	for _, e := range entries {
		for _, edge := range o.outgoing[e.ID] {
			if edge.Type == types.EdgeDeriveFrom && idSet[edge.Target] {
				deps[e.ID] = append(deps[e.ID], edge.Target)
			}
		}
	}

	// Kahn's algorithm for topological sort
	inDegree := make(map[string]int)
	for _, e := range entries {
		inDegree[e.ID] = len(deps[e.ID])
	}

	// Queue: entries with no dependencies, sorted by created_at
	var queue []*types.Entry
	for _, e := range entries {
		if inDegree[e.ID] == 0 {
			queue = append(queue, e)
		}
	}
	sort.Slice(queue, func(i, j int) bool {
		return queue[i].CreatedAt.Before(queue[j].CreatedAt)
	})

	var result []*types.Entry
	processed := make(map[string]bool)

	for len(queue) > 0 {
		// Take first
		current := queue[0]
		queue = queue[1:]

		if processed[current.ID] {
			continue
		}
		processed[current.ID] = true
		result = append(result, current)

		// Find entries that depend on current (current is their prerequisite)
		for _, e := range entries {
			if processed[e.ID] {
				continue
			}
			for _, dep := range deps[e.ID] {
				if dep == current.ID {
					inDegree[e.ID]--
					if inDegree[e.ID] == 0 {
						// Insert maintaining created_at order
						insertPos := sort.Search(len(queue), func(i int) bool {
							return queue[i].CreatedAt.After(e.CreatedAt)
						})
						queue = append(queue, nil)
						copy(queue[insertPos+1:], queue[insertPos:])
						queue[insertPos] = e
					}
					break
				}
			}
		}
	}

	// Handle cycles: append any unprocessed entries
	if len(result) < len(entries) {
		for _, e := range entries {
			if !processed[e.ID] {
				result = append(result, e)
			}
		}
	}

	return result
}

// projectMetadata builds the metadata for the arc stream.
func (o *Orchestrator) projectMetadata(entries []*types.Entry) ConstellationMeta {
	idSet := make(map[string]bool)
	for _, e := range entries {
		idSet[e.ID] = true
	}

	frames := []string{}
	edges := []MetaEdge{}

	for _, e := range entries {
		frames = append(frames, string(e.FrameType))

		// Report edges within the stream
		for _, edge := range o.outgoing[e.ID] {
			if idSet[edge.Target] {
				edges = append(edges, MetaEdge{
					From: edge.Source,
					To:   edge.Target,
					Type: edge.Type,
				})
			}
		}
	}

	return ConstellationMeta{
		Frames: frames,
		Edges:  edges,
		HintsApplied: []string{},
		HintsIgnored: []string{},
	}
}

// --- Helpers ---

func tokenize(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == ',' || r == '.' || r == '/' || r == '-'
	})
}

func scoreMatch(e *types.Entry, bidLower string, tokens []string) int {
	score := 0

	// Content match
	contentLower := strings.ToLower(e.Content)
	for _, token := range tokens {
		if strings.Contains(contentLower, token) {
			score += 2
		}
	}

	// Keyword match
	for _, kw := range e.Keywords {
		kwLower := strings.ToLower(kw)
		for _, token := range tokens {
			if strings.Contains(kwLower, token) || strings.Contains(token, kwLower) {
				score += 3
			}
		}
	}

	// Tag match
	for _, tag := range e.Tags {
		if strings.Contains(bidLower, tag) || strings.Contains(strings.ToLower(tag), bidLower) {
			score += 5
		}
	}

	return score
}

// DumpJSON marshals the result for CLI output.
func (r *ConstellationResult) DumpJSON() string {
	data, _ := json.MarshalIndent(r, "", "  ")
	return string(data)
}
