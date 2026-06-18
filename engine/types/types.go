package types

import "time"

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

// Edge is a typed directed relationship between two entries.
type Edge struct {
	Source    string   `json:"source"`    // entry ID
	Target    string   `json:"target"`    // entry ID (or dimension key for constrains)
	Type      EdgeType `json:"type"`
	Reason    string   `json:"reason"`
	CreatedAt time.Time `json:"created_at"`
}

// EntryWithEdges is an entry plus its graph relationships.
type EntryWithEdges struct {
	Entry
	Outgoing []Edge `json:"outgoing,omitempty"`
	Incoming []Edge `json:"incoming,omitempty"`
}
