package orchestrator

import (
	"encoding/json"
	"sort"
	"strings"
	"time"

	"stellario/engine/types"
)

// Orchestrator builds arc streams from entries and edges.
// It is a pure in-memory structure — no database, no network.
type Orchestrator struct {
	entries map[types.EntryKey]*types.Entry
	edges   []types.Edge
	outgoing map[types.EntryKey][]*types.Edge
	incoming map[types.EntryKey][]*types.Edge
}

// New creates an orchestrator from raw entries and edges.
func New(entries []types.Entry, edges []types.Edge) *Orchestrator {
	o := &Orchestrator{
		entries:  make(map[types.EntryKey]*types.Entry),
		outgoing: make(map[types.EntryKey][]*types.Edge),
		incoming: make(map[types.EntryKey][]*types.Edge),
	}

	for i := range entries {
		e := &entries[i]
		key := types.MakeEntryKey(e.Project, e.ID)
		o.entries[key] = e
		e.Active = true
	}

	o.edges = edges
	for i := range edges {
		edge := &o.edges[i]
		sourceKey := types.MakeEntryKey(edge.SourceProject, edge.Source)
		targetKey := types.MakeEntryKey(edge.TargetProject, edge.Target)
		o.outgoing[sourceKey] = append(o.outgoing[sourceKey], edge)
		o.incoming[targetKey] = append(o.incoming[targetKey], edge)

		if edge.Type == types.EdgeSupersede {
			if target, ok := o.entries[targetKey]; ok {
				target.Active = false
			}
		}
	}

	return o
}

// ConstellationRequest is the input to a constellation query.
type ConstellationRequest struct {
	Bid             string                          `json:"bid"`
	Volume          string                          `json:"volume,omitempty"`
	TagFilter       string                          `json:"tag_filter,omitempty"`
	StructuredHints []types.StructuredHint      `json:"structured_hints,omitempty"`
	RawHints        []string                        `json:"raw_hints,omitempty"`
}

// ConstellationResult is the output.
type ConstellationResult struct {
	Arcs     []ArcEntry         `json:"arcs"`
	Metadata ConstellationMeta  `json:"metadata"`
}

type ArcEntry struct {
	ID        string          `json:"id"`
	Project   string          `json:"project,omitempty"`
	Volume    string          `json:"volume"`
	Content   string          `json:"content"`
	Tags      []string        `json:"tags"`
	Keywords  []string        `json:"keywords"`
	FrameType types.FrameType `json:"frame_type"`
	Active    bool            `json:"active"`
	CreatedAt time.Time       `json:"created_at"`
}

type MetaEdge struct {
	From string         `json:"from"`
	To   string         `json:"to"`
	Type types.EdgeType `json:"type"`
}

type ConstellationMeta struct {
	Frames           []string              `json:"frames"`
	Edges            []MetaEdge            `json:"edges"`
	HintsApplied     []string              `json:"hints_applied"`
	HintsIgnored     []string              `json:"hints_ignored"`
	HintTranslations []HintTranslationInfo `json:"hint_translations,omitempty"`
	TotalCandidates  int                   `json:"total_candidates"`
}

type HintTranslationInfo struct {
	Raw        string  `json:"raw"`
	Op         string  `json:"op"`
	Value      string  `json:"value,omitempty"`
	Confidence float64 `json:"confidence,omitempty"`
	Applied    bool    `json:"applied"`
}

// Constellation builds an arc stream from a bid + structured hints.
// Pure computation — no network, no I/O.
func (o *Orchestrator) Constellation(req ConstellationRequest) (*ConstellationResult, error) {
	// 1. Apply structured hints that modify the request
	req = applyHints(req)

	// 2. Collect: search by bid keywords + tag filter
	candidates := o.search(req.Bid, req.Volume, req.TagFilter)

	// 3. Filter: remove superseded entries (unless hint says otherwise)
	includeSuperseded := hasHintOp(req.StructuredHints, "include_superseded")
	active := o.filterActive(candidates, includeSuperseded)

	// 4. Sort: topological by derive_from, fallback to created_at
	sorted := o.causalSort(active)

	// 5. Project metadata
	meta := o.projectMetadata(sorted)

	// 6. Record hint outcomes (only mark as applied if op is actually implemented)
	for _, sh := range req.StructuredHints {
		info := HintTranslationInfo{
			Raw:        sh.Raw,
			Op:         sh.Op,
			Value:      sh.Value,
			Confidence: sh.Confidence,
		}
		info.Applied = isHintApplied(sh)
		if info.Applied {
			meta.HintsApplied = append(meta.HintsApplied, sh.Raw)
		} else {
			meta.HintsIgnored = append(meta.HintsIgnored, sh.Raw)
		}
		meta.HintTranslations = append(meta.HintTranslations, info)
	}

	// Raw hints that weren't translated (no inference backend)
	translatedSet := make(map[string]bool)
	for _, sh := range req.StructuredHints {
		translatedSet[sh.Raw] = true
	}
	for _, h := range req.RawHints {
		if !translatedSet[h] {
			meta.HintsIgnored = append(meta.HintsIgnored, h)
		}
	}

	meta.TotalCandidates = len(candidates)

	// 7. Build arc entries
	arcs := make([]ArcEntry, 0, len(sorted))
	for _, e := range sorted {
		arcs = append(arcs, ArcEntry{
			ID:        e.ID,
			Project:   e.Project,
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

// applyHints modifies the request based on structured hint operations.
func applyHints(req ConstellationRequest) ConstellationRequest {
	for _, h := range req.StructuredHints {
		switch h.Op {
		case "tag_filter":
			if h.Value != "" {
				req.TagFilter = h.Value
			}
		case "volume_filter":
			if h.Value != "" {
				req.Volume = h.Value
			}
		}
	}
	return req
}

// isHintApplied returns true only for ops that are actually implemented.
func isHintApplied(h types.StructuredHint) bool {
	if h.Error != "" || h.Op == "" || h.Op == "unknown" {
		return false
	}
	switch h.Op {
	case "tag_filter", "volume_filter", "include_superseded":
		return true
	default:
		return false
	}
}

func hasHintOp(hints []types.StructuredHint, op string) bool {
	for _, h := range hints {
		if h.Op == op {
			return true
		}
	}
	return false
}

// search finds entries matching the bid keywords + filters.
func (o *Orchestrator) search(bid, volume, tagFilter string) []*types.Entry {
	bidLower := strings.ToLower(bid)
	bidTokens := tokenize(bidLower)

	var result []*types.Entry
	for _, e := range o.entries {
		if volume != "" && e.Volume != volume {
			continue
		}

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

		if len(bidTokens) > 0 {
			score := scoreMatch(e, bidLower, bidTokens)
			if score == 0 {
				continue
			}
		}

		result = append(result, e)
	}

	return result
}

func (o *Orchestrator) filterActive(entries []*types.Entry, includeSuperseded bool) []*types.Entry {
	if includeSuperseded {
		return entries
	}
	var result []*types.Entry
	for _, e := range entries {
		if e.Active {
			result = append(result, e)
		}
	}
	return result
}

func (o *Orchestrator) causalSort(entries []*types.Entry) []*types.Entry {
	idSet := make(map[types.EntryKey]bool)
	entryByKey := make(map[types.EntryKey]*types.Entry)
	for _, e := range entries {
		key := types.MakeEntryKey(e.Project, e.ID)
		idSet[key] = true
		entryByKey[key] = e
	}

	deps := make(map[types.EntryKey][]types.EntryKey)
	for _, e := range entries {
		key := types.MakeEntryKey(e.Project, e.ID)
		for _, edge := range o.outgoing[key] {
			targetKey := types.MakeEntryKey(edge.TargetProject, edge.Target)
			if edge.Type == types.EdgeDeriveFrom && idSet[targetKey] {
				deps[key] = append(deps[key], targetKey)
			}
		}
	}

	inDegree := make(map[types.EntryKey]int)
	for _, e := range entries {
		key := types.MakeEntryKey(e.Project, e.ID)
		inDegree[key] = len(deps[key])
	}

	var queue []*types.Entry
	for _, e := range entries {
		key := types.MakeEntryKey(e.Project, e.ID)
		if inDegree[key] == 0 {
			queue = append(queue, e)
		}
	}
	sort.Slice(queue, func(i, j int) bool {
		return queue[i].CreatedAt.Before(queue[j].CreatedAt)
	})

	var result []*types.Entry
	processed := make(map[types.EntryKey]bool)

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		currentKey := types.MakeEntryKey(current.Project, current.ID)
		if processed[currentKey] {
			continue
		}
		processed[currentKey] = true
		result = append(result, current)

		for _, e := range entries {
			eKey := types.MakeEntryKey(e.Project, e.ID)
			if processed[eKey] {
				continue
			}
			for _, dep := range deps[eKey] {
				if dep == currentKey {
					inDegree[eKey]--
					if inDegree[eKey] == 0 {
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

	if len(result) < len(entries) {
		for _, e := range entries {
			key := types.MakeEntryKey(e.Project, e.ID)
			if !processed[key] {
				result = append(result, e)
			}
		}
	}

	return result
}

func (o *Orchestrator) projectMetadata(entries []*types.Entry) ConstellationMeta {
	idSet := make(map[types.EntryKey]bool)
	for _, e := range entries {
		key := types.MakeEntryKey(e.Project, e.ID)
		idSet[key] = true
	}

	var frames []string
	var edges []MetaEdge

	for _, e := range entries {
		frames = append(frames, string(e.FrameType))
		key := types.MakeEntryKey(e.Project, e.ID)
		for _, edge := range o.outgoing[key] {
			targetKey := types.MakeEntryKey(edge.TargetProject, edge.Target)
			if idSet[targetKey] {
				edges = append(edges, MetaEdge{
					From: edge.Source,
					To:   edge.Target,
					Type: edge.Type,
				})
			}
		}
	}

	return ConstellationMeta{
		Frames:       frames,
		Edges:        edges,
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

	contentLower := strings.ToLower(e.Content)
	for _, token := range tokens {
		if strings.Contains(contentLower, token) {
			score += 2
		}
	}

	for _, kw := range e.Keywords {
		kwLower := strings.ToLower(kw)
		for _, token := range tokens {
			if strings.Contains(kwLower, token) || strings.Contains(token, kwLower) {
				score += 3
			}
		}
	}

	for _, tag := range e.Tags {
		if strings.Contains(bidLower, tag) || strings.Contains(strings.ToLower(tag), bidLower) {
			score += 5
		}
	}

	return score
}

func (r *ConstellationResult) DumpJSON() string {
	data, _ := json.MarshalIndent(r, "", "  ")
	return string(data)
}
