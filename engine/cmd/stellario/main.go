package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"stellario/engine/orchestrator"
	"stellario/engine/reader"
	"stellario/engine/store"
	"stellario/engine/types"
)

func main() {
	if len(os.Args) < 2 {
		printHelp()
		os.Exit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "create":
		cmdCreate(args)
	case "show":
		cmdShow(args)
	case "search":
		cmdSearch(args)
	case "downstream":
		cmdDownstream(args)
	case "propagate":
		cmdPropagate(args)
	case "state":
		cmdState(args)
	case "supersede":
		cmdSupersede(args)
	case "constellation":
		cmdConstellation(args)
	case "sync":
		cmdSync(args)
	case "help", "--help", "-h":
		printHelp()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		printHelp()
		os.Exit(1)
	}
}

func getDB() *store.Store {
	dbPath := os.Getenv("STELLARIO_DB")
	if dbPath == "" {
		dbPath = store.DefaultDBPath()
	}
	s, err := store.Open(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error opening db: %v\n", err)
		os.Exit(1)
	}
	return s
}

func cmdCreate(args []string) {
	fs := flag.NewFlagSet("create", flag.ExitOnError)
	project := fs.String("project", "_default", "project name")
	volume := fs.String("volume", "", "volume name")
	content := fs.String("content", "", "entry content")
	tagsStr := fs.String("tags", "", "comma-separated tags")
	keywordsStr := fs.String("keywords", "", "comma-separated keywords")
	author := fs.String("author", "cli", "author")
	frameType := fs.String("frame-type", "assert", "frame type")
	deriveFrom := fs.String("derive-from", "", "comma-separated entry IDs this derives from")
	fs.Parse(args)

	if *volume == "" || *content == "" {
		fmt.Fprintln(os.Stderr, "Error: --volume and --content are required")
		os.Exit(1)
	}

	s := getDB()
	defer s.Close()

	nonce, err := s.NextNonce(*project, *volume)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error generating ID: %v\n", err)
		os.Exit(1)
	}

	idPrefix := "a"
	if len(*volume) > 0 {
		idPrefix = string((*volume)[0])
	}
	id := fmt.Sprintf("%s%d", idPrefix, nonce)

	e := types.Entry{
		ID:        id,
		Project:   *project,
		Volume:    *volume,
		Content:   *content,
		Tags:      splitCSV(*tagsStr),
		Keywords:  splitCSV(*keywordsStr),
		Author:    *author,
		FrameType: types.FrameType(*frameType),
	}

	created, err := s.CreateEntry(e)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating entry: %v\n", err)
		os.Exit(1)
	}

	if *deriveFrom != "" {
		for _, target := range splitCSV(*deriveFrom) {
			if err := s.AddEdge(types.Edge{
				Source:        id,
				SourceProject: *project,
				Target:        target,
				TargetProject: *project,
				Type:          types.EdgeDeriveFrom,
				Reason:        "derive",
			}); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to add edge to %s: %v\n", target, err)
			}
		}
	}

	printJSON(created)
}

func cmdShow(args []string) {
	fs := flag.NewFlagSet("show", flag.ExitOnError)
	project := fs.String("project", "_default", "project name")
	volume := fs.String("volume", "", "volume name")
	fs.Parse(args)

	if fs.NArg() < 1 || *volume == "" {
		fmt.Fprintln(os.Stderr, "Usage: show --project <proj> --volume <vol> <id>")
		os.Exit(1)
	}

	id := fs.Arg(0)
	s := getDB()
	defer s.Close()

	entry, err := s.GetEntry(id, *volume, *project)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	printJSON(entry)
}

func cmdSearch(args []string) {
	fs := flag.NewFlagSet("search", flag.ExitOnError)
	project := fs.String("project", "_default", "project name")
	volume := fs.String("volume", "", "volume name")
	tagFilter := fs.String("tag", "", "tag filter")
	fs.Parse(args)

	s := getDB()
	defer s.Close()

	entries, err := s.ActiveEntries(*project, *volume, *tagFilter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	printJSON(entries)
}

func cmdDownstream(args []string) {
	fs := flag.NewFlagSet("downstream", flag.ExitOnError)
	project := fs.String("project", "_default", "project name")
	fs.Parse(args)

	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "Usage: downstream --project <proj> <id>")
		os.Exit(1)
	}

	id := fs.Arg(0)
	s := getDB()
	defer s.Close()

	ids, err := s.Downstream(id, *project)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	printJSON(ids)
}

func cmdPropagate(args []string) {
	fs := flag.NewFlagSet("propagate", flag.ExitOnError)
	project := fs.String("project", "_default", "project name")
	fs.Parse(args)

	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "Usage: propagate --project <proj> <id>")
		os.Exit(1)
	}

	id := fs.Arg(0)
	s := getDB()
	defer s.Close()

	ids, err := s.PropagateSupersede(id, *project)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	printJSON(ids)
}

func cmdState(args []string) {
	fs := flag.NewFlagSet("state", flag.ExitOnError)
	project := fs.String("project", "_default", "project name")
	volume := fs.String("volume", "", "volume name")
	tagFilter := fs.String("tag", "", "tag filter")
	fs.Parse(args)

	s := getDB()
	defer s.Close()

	entries, err := s.ActiveEntries(*project, *volume, *tagFilter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	type stateEntry struct {
		ID        string `json:"id"`
		FrameType string `json:"frame_type"`
		Content   string `json:"content_preview"`
	}
	var result []stateEntry
	for _, e := range entries {
		preview := e.Content
		if len(preview) > 120 {
			preview = preview[:120] + "..."
		}
		result = append(result, stateEntry{
			ID:        e.ID,
			FrameType: string(e.FrameType),
			Content:   preview,
		})
	}
	printJSON(result)
}

func cmdSupersede(args []string) {
	fs := flag.NewFlagSet("supersede", flag.ExitOnError)
	project := fs.String("project", "_default", "project name")
	reason := fs.String("reason", "", "reason for supersede")
	_ = fs.String("volume", "", "volume name")
	fs.Parse(args)

	if fs.NArg() < 2 {
		fmt.Fprintln(os.Stderr, "Usage: supersede --project <proj> --volume <vol> --reason <text> <new_id> <old_id>")
		os.Exit(1)
	}

	newID := fs.Arg(0)
	oldID := fs.Arg(1)

	s := getDB()
	defer s.Close()

	err := s.AddEdge(types.Edge{
		Source:        newID,
		SourceProject: *project,
		Target:        oldID,
		TargetProject: *project,
		Type:          types.EdgeSupersede,
		Reason:        *reason,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Marked %s as superseded by %s\n", oldID, newID)
}

func cmdConstellation(args []string) {
	fs := flag.NewFlagSet("constellation", flag.ExitOnError)
	stellarioDir := fs.String("dir", "", "stellario directory (e.g. .opencode/.stellario)")
	bid := fs.String("bid", "", "bid — what you want to understand")
	project := fs.String("project", "_default", "project name")
	volume := fs.String("volume", "", "volume filter")
	tagFilter := fs.String("tag", "", "tag filter")
	hintsStr := fs.String("hints", "", "comma-separated hints (natural language)")
	syncFlag := fs.Bool("sync", true, "sync JSONL → SQLite before querying")
	fs.Parse(args)

	if *bid == "" || *stellarioDir == "" {
		fmt.Fprintln(os.Stderr, "Usage: constellation --dir <dir> --bid <intent> --project <proj> [--volume <vol>] [--tag <tag>] [--hints <hints>]")
		os.Exit(1)
	}

	s := getDB()
	defer s.Close()

	var entries []types.Entry
	var edges []types.Edge

	if *syncFlag {
		report, err := s.SyncFromJSONL(*project, *stellarioDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error syncing: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Sync: %s (%s)\n", report.Summary(), report.Duration)

		// Sync intent log (append-only, new entries only)
		if n, err := s.SyncIntentLog(*project, *stellarioDir); err == nil && n > 0 {
			fmt.Fprintf(os.Stderr, "Intent log: %d new entries\n", n)
		}

		entries, edges, err = s.LoadGraph(*project)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error loading graph: %v\n", err)
			os.Exit(1)
		}
	} else {
		var err error
		entries, edges, err = reader.ReadProject(*stellarioDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading project: %v\n", err)
			os.Exit(1)
		}
	}

	fmt.Fprintf(os.Stderr, "Loaded %d entries, %d edges\n", len(entries), len(edges))

	orch := orchestrator.New(entries, edges)

	// Parse raw hints (no translation — hints are now intent log only)
	var rawHints []string
	if *hintsStr != "" {
		rawHints = splitCSV(*hintsStr)
	}

	result, err := orch.Constellation(orchestrator.ConstellationRequest{
		Bid:        *bid,
		Volume:     *volume,
		TagFilter:  *tagFilter,
		RawHints:   rawHints,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(result.DumpJSON())
}

// --- Helpers ---

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(p)
	}
	return parts
}

func printJSON(v interface{}) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(data))
}

func cmdSync(args []string) {
	fs := flag.NewFlagSet("sync", flag.ExitOnError)
	stellarioDir := fs.String("dir", "", "stellario directory")
	project := fs.String("project", "_default", "project name")
	fs.Parse(args)

	if *stellarioDir == "" {
		fmt.Fprintln(os.Stderr, "Usage: sync --dir <dir> --project <name>")
		os.Exit(1)
	}

	s := getDB()
	defer s.Close()

	report, err := s.SyncFromJSONL(*project, *stellarioDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "Sync [%s]: %s (%s)\n", *project, report.Summary(), report.Duration)
	if len(report.SyncedVolumes) > 0 {
		fmt.Fprintf(os.Stderr, "Synced volumes: %s\n", strings.Join(report.SyncedVolumes, ", "))
	}

	// Sync intent log
	if n, err := s.SyncIntentLog(*project, *stellarioDir); err == nil && n > 0 {
		fmt.Fprintf(os.Stderr, "Intent log: %d new entries\n", n)
	}
	printJSON(report)
}

func printHelp() {
	fmt.Println(`stellario — graph engine

Commands:
  create           Create a new entry
  show             Show an entry with its edges
  search           Search active entries
  downstream       Find entries that derive from the given entry (transitive)
  propagate        Find entries that become stale if the given entry is superseded
  state            Show current active state for a volume/tag
  supersede        Mark an entry as superseded by another
  constellation    Build an arc stream from a bid + hints
  sync             Sync JSONL files into SQLite (bulk import stale volumes)
  help             Show this help

Environment:
  STELLARIO_DB       Path to SQLite database (default: ~/.local/share/stellario/stellario.db)`)
}
