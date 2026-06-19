package types

import (
	"strings"
	"time"
)

// FrameType defines the operational semantics of an entry on the memory graph.
type FrameType string

const (
	FrameAssert     FrameType = "assert"
	FrameDerive     FrameType = "derive"
	FrameSupersede  FrameType = "supersede"
	FrameValidate   FrameType = "validate"
	FrameCheckpoint FrameType = "checkpoint"
	FrameConstrain  FrameType = "constrain"
)

// EdgeType defines the typed relationship between entries.
type EdgeType string

const (
	EdgeDeriveFrom EdgeType = "derive_from"
	EdgeSupersede  EdgeType = "supersede"
	EdgeValidates  EdgeType = "validates"
	EdgeConstrains EdgeType = "constrains"
	EdgeRef        EdgeType = "ref"
)

// Entry is a unit of memory with frame semantics.
type Entry struct {
	ID        string    `json:"id"`
	Project   string    `json:"project,omitempty"`
	Volume    string    `json:"volume"`
	Content   string    `json:"content"`
	Tags      []string  `json:"tags"`
	Keywords  []string  `json:"keywords"`
	Author    string    `json:"author"`
	FrameType FrameType `json:"frame_type"`

	// Active is false if this entry has been superseded.
	// Derived from edges: if any EdgeSupersede points to this entry, active = false.
	Active bool `json:"active"`

	// Stale is true if an entry this derives from has been modified or superseded.
	// Computed at query time, not stored.
	Stale bool `json:"stale,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// EntryKey is a composite key that uniquely identifies an entry across projects.
type EntryKey string

// MakeEntryKey creates a composite key "project:id" for map indexing.
func MakeEntryKey(project, id string) EntryKey {
	return EntryKey(project + ":" + id)
}

// SplitEntryKey reverses MakeEntryKey.
func SplitEntryKey(k EntryKey) (project, id string) {
	idx := string(k)
	if i := strings.Index(idx, ":"); i != -1 {
		return idx[:i], idx[i+1:]
	}
	return "", idx
}

// Edge is a typed directed relationship between two entries.
type Edge struct {
	Source       string   `json:"source"`        // entry ID
	SourceProject string  `json:"source_project,omitempty"` // project the source belongs to
	Target       string   `json:"target"`        // entry ID (or dimension key for constrains)
	TargetProject string  `json:"target_project,omitempty"` // project the target belongs to (nullable for external)
	Type         EdgeType `json:"type"`
	Reason       string   `json:"reason"`
	CreatedAt    time.Time `json:"created_at"`
}

// EntryWithEdges is an entry plus its graph relationships.
type EntryWithEdges struct {
	Entry
	Outgoing []Edge `json:"outgoing,omitempty"`
	Incoming []Edge `json:"incoming,omitempty"`
}

// StructuredHint represents a parsed hint operation (legacy, no longer translated by LLM).
// Kept for backwards compatibility with ConstellationRequest.
type StructuredHint struct {
	Raw        string  `json:"raw"`
	Op         string  `json:"op"`
	Value      string  `json:"value,omitempty"`
	Confidence float64 `json:"confidence,omitempty"`
	Error      string  `json:"error,omitempty"`
}
