package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"stellario/engine/cluster"
	"stellario/engine/config"
	"stellario/engine/jsonlstore"
	"stellario/engine/store"
	"stellario/engine/types"
)

// ─── Go Native Create ────────────────────────────────────────────────────────

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

// RunCreate writes an entry.
//
// Two modes:
//   1. Fanout (ID provided): TS has already written JSONL; Go only mirrors to SQLite.
//   2. Native (ID empty): Go is the ground-truth writer. Write JSONL + SQLite.
func RunCreate(opts CreateOptions) (*CreateResult, error) {
	if opts.Volume == "" {
		return nil, fmt.Errorf("volume is required")
	}
	if opts.Content == "" {
		return nil, fmt.Errorf("content is required")
	}

	if opts.ID != "" {
		return createFanout(opts)
	}
	return createNative(opts)
}

func createFanout(opts CreateOptions) (*CreateResult, error) {
	s, err := store.Open(store.DefaultDBPath())
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	defer s.Close()

	entry := types.Entry{
		ID:        opts.ID,
		Project:   opts.Project,
		Volume:    opts.Volume,
		Content:   opts.Content,
		Tags:      opts.Tags,
		Keywords:  opts.Keywords,
		Author:    opts.Author,
		FrameType: inferFrameType(opts.Tags),
		Active:    true,
	}

	created, err := s.CreateEntry(entry)
	if err != nil {
		return nil, fmt.Errorf("create entry: %w", err)
	}

	return &CreateResult{
		ID:        created.ID,
		Project:   created.Project,
		Volume:    created.Volume,
		StarID:    "(fanout)",
		CreatedAt: created.CreatedAt,
	}, nil
}

func createNative(opts CreateOptions) (*CreateResult, error) {
	dev, err := cluster.GetOrCreateDeviceID()
	if err != nil {
		return nil, fmt.Errorf("device identity: %w", err)
	}

	memDir, cfg, err := resolveCreateMemDir(opts.Project)
	if err != nil {
		return nil, err
	}

	def, ok := cfg.Volumes[opts.Volume]
	if !ok || def == nil {
		return nil, fmt.Errorf("unknown volume %q", opts.Volume)
	}
	if !jsonlstore.CanWrite(opts.Author, opts.Volume, cfg) {
		return nil, fmt.Errorf("agent %q cannot write to volume %q", opts.Author, opts.Volume)
	}

	id, err := jsonlstore.GenerateNextId(memDir, opts.Volume, cfg, dev.Star)
	if err != nil {
		return nil, fmt.Errorf("generate id: %w", err)
	}

	today := jsonlstore.Today()
	entry := jsonlstore.Entry{
		ID:       id,
		Volume:   opts.Volume,
		Content:  opts.Content,
		Tags:     dedupeStrings(opts.Tags),
		Keywords: dedupeStrings(opts.Keywords),
		Author:   opts.Author,
		Created:  today,
		Updated:  today,
	}

	entries, _ := jsonlstore.ReadVolume(memDir, opts.Volume)
	entries = append(entries, entry)
	if err := jsonlstore.WriteVolume(memDir, opts.Volume, entries); err != nil {
		return nil, fmt.Errorf("write volume: %w", err)
	}
	if err := jsonlstore.WriteEntryMd(memDir, opts.Volume, &entry); err != nil {
		return nil, fmt.Errorf("write track md: %w", err)
	}

	hash, _ := jsonlstore.GitCommit(memDir, opts.Volume,
		fmt.Sprintf("create: %s\n\nEntry: %s\nVolume: %s\nAuthor: %s", truncate(entry.Content, 50), id, opts.Volume, opts.Author),
		[]string{id})

	// Mirror to SQLite (shadow copy, best-effort)
	_, _ = createFanout(CreateOptions{
		Project:  opts.Project,
		Volume:   opts.Volume,
		Content:  opts.Content,
		Tags:     entry.Tags,
		Keywords: entry.Keywords,
		Author:   opts.Author,
		ID:       id,
	})

	createdAt, _ := time.Parse("2006-01-02", today)
	res := &CreateResult{
		ID:        id,
		Project:   opts.Project,
		Volume:    opts.Volume,
		StarID:    dev.Star,
		CreatedAt: createdAt,
	}

	fmt.Printf("Created [%s] → %s\n", displayID(&entry, opts.Volume), opts.Volume)
	fmt.Printf("Author: %s\n", opts.Author)
	fmt.Printf("Tags: %s\n", strings.Join(entry.Tags, ", "))
	if hash != "" {
		fmt.Printf("Commit: %s\n", hash)
	}
	return res, nil
}

// resolveCreateMemDir resolves project to memory dir and config for native create.
func resolveCreateMemDir(projectName string) (string, *config.StellarioConfig, error) {
	dev, err := cluster.GetOrCreateDeviceID()
	if err != nil {
		return "", nil, fmt.Errorf("device identity: %w", err)
	}

	var memDir, configPath string
	if projectName == "_global" {
		memDir = cluster.DeviceGlobalDir(dev.ID)
		configPath = filepath.Join(memDir, "stellario.yaml")
		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			containerConfig := filepath.Join(cluster.GlobalVolumesDir(), "stellario.yaml")
			if _, err := os.Stat(containerConfig); err == nil {
				configPath = containerConfig
			}
		}
	} else {
		memDir, err = cluster.LocalProjectDir(projectName)
		if err != nil {
			return "", nil, err
		}
		if _, err := os.Stat(memDir); os.IsNotExist(err) {
			memDir = cluster.ProjectDir(projectName)
		}
		configPath = filepath.Join(memDir, "stellario.yaml")
		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			containerConfig := filepath.Join(cluster.ProjectDir(projectName), "stellario.yaml")
			if _, err := os.Stat(containerConfig); err == nil {
				configPath = containerConfig
			}
		}
	}

	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return "", nil, fmt.Errorf("config not found for project %q", projectName)
	}

	result, err := config.LoadAndValidatePath(configPath)
	if err != nil {
		return "", nil, fmt.Errorf("load config: %w", err)
	}
	return memDir, result.Config, nil
}

func inferFrameType(tags []string) types.FrameType {
	for _, tag := range tags {
		switch tag {
		case "type:hypothesis", "type:insight", "layer:analysis", "type:issue":
			return types.FrameDerive
		case "type:checkpoint", "type:plan", "layer:session":
			return types.FrameCheckpoint
		}
	}
	return types.FrameAssert
}

// volumePrefix is kept for backward compatibility with any callers.
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
