package cmd

import (
	"fmt"
	"time"

	"stellario/engine/store"
	"stellario/engine/types"
)

// ─── Go Native Create (SQLite) ───────────────────────────────────────────────

// CreateOptions for native Go create.
type CreateOptions struct {
	Project  string
	Volume   string
	Content  string
	Tags     []string
	Keywords []string
	Author   string
	ID       string // if set, use this ID (fanout mode). If empty, generate with star suffix.
}

// CreateResult holds the outcome.
type CreateResult struct {
	ID        string
	Project   string
	Volume    string
	StarID    string
	CreatedAt time.Time
}

// RunCreate writes an entry directly to SQLite.
//
// Two modes:
//   1. Fanout (ID provided): use TS's ID exactly.
//   2. Native (ID empty): generate a plain sequential ID (no star suffix —
//      the device-relative model uses per-device nonces in the device's own
//      dir, so no suffix is needed for cross-device uniqueness).
func RunCreate(opts CreateOptions) (*CreateResult, error) {
	if opts.Volume == "" {
		return nil, fmt.Errorf("volume is required")
	}
	if opts.Content == "" {
		return nil, fmt.Errorf("content is required")
	}

	starName := ""
	id := opts.ID

	// If no ID provided (native mode), generate a plain sequential ID.
	if id == "" {
		s, err := store.Open(store.DefaultDBPath())
		if err != nil {
			return nil, fmt.Errorf("open db: %w", err)
		}

		nonce, err := s.NextNonce(opts.Project, opts.Volume)
		if err != nil {
			s.Close()
			return nil, fmt.Errorf("generate nonce: %w", err)
		}
		s.Close()

		prefix := volumePrefix(opts.Volume)
		id = fmt.Sprintf("%s%d", prefix, nonce)
	}

	// Open SQLite for write
	s, err := store.Open(store.DefaultDBPath())
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	defer s.Close()

	// Determine frame type from tags
	frameType := types.FrameAssert
	for _, tag := range opts.Tags {
		switch tag {
		case "type:hypothesis", "type:insight", "layer:analysis", "type:issue":
			frameType = types.FrameDerive
		case "type:checkpoint", "type:plan", "layer:session":
			frameType = types.FrameCheckpoint
		}
	}

	entry := types.Entry{
		ID:        id,
		Project:   opts.Project,
		Volume:    opts.Volume,
		Content:   opts.Content,
		Tags:      opts.Tags,
		Keywords:  opts.Keywords,
		Author:    opts.Author,
		FrameType: frameType,
		Active:    true,
	}

	created, err := s.CreateEntry(entry)
	if err != nil {
		return nil, fmt.Errorf("create entry: %w", err)
	}

	if starName == "" {
		starName = "(fanout)"
	}

	return &CreateResult{
		ID:        created.ID,
		Project:   created.Project,
		Volume:    created.Volume,
		StarID:    starName,
		CreatedAt: created.CreatedAt,
	}, nil
}

func volumePrefix(volume string) string {
	switch volume {
	case "archived":
		return "z"
	case "meta":
		return "m"
	case "handover":
		return "h"
	case "layer":
		return "l"
	default:
		if len(volume) > 0 {
			return string(volume[0])
		}
		return "a"
	}
}
