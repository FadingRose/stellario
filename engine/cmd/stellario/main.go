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
		dbPath = "stellario.db"
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

	nonce, err := s.NextNonce(*volume)
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

	// Add derive_from edges
	if *deriveFrom != "" {
		for _, target := range splitCSV(*deriveFrom) {
			if err := s.AddEdge(types.Edge{
				Source: id,
				Target: target,
				Type:   types.EdgeDeriveFrom,
				Reason: "derive",
			}); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to add edge to %s: %v\n", target, err)
			}
		}
	}

	printJSON(created)
}

func cmdShow(args []string) {
	fs := flag.NewFlagSet("show", flag.ExitOnError)
	volume := fs.String("volume", "", "volume name")
	fs.Parse(args)

	if fs.NArg() < 1 || *volume == "" {
		fmt.Fprintln(os.Stderr, "Usage: show --volume <vol> <id>")
		os.Exit(1)
	}

	id := fs.Arg(0)
	s := getDB()
	defer s.Close()

	entry, err := s.GetEntry(id, *volume)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	printJSON(entry)
}

func cmdSearch(args []string) {
	fs := flag.NewFlagSet("search", flag.ExitOnError)
	volume := fs.String("volume", "", "volume name")
	tagFilter := fs.String("tag", "", "tag filter")
	fs.Parse(args)

	s := getDB()
	defer s.Close()

	entries, err := s.ActiveEntries(*volume, *tagFilter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	printJSON(entries)
}

func cmdDownstream(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: downstream <id>")
		os.Exit(1)
	}
	id := args[0]

	s := getDB()
	defer s.Close()

	ids, err := s.Downstream(id)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	printJSON(ids)
}

func cmdPropagate(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: propagate <id>")
		os.Exit(1)
	}
	id := args[0]

	s := getDB()
	defer s.Close()

	ids, err := s.PropagateSupersede(id)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	printJSON(ids)
}

func cmdState(args []string) {
	fs := flag.NewFlagSet("state", flag.ExitOnError)
	volume := fs.String("volume", "", "volume name")
	tagFilter := fs.String("tag", "", "tag filter")
	fs.Parse(args)

	s := getDB()
	defer s.Close()

	entries, err := s.ActiveEntries(*volume, *tagFilter)
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
	reason := fs.String("reason", "", "reason for supersede")
	_ = fs.String("volume", "", "volume name")
	fs.Parse(args)

	if fs.NArg() < 2 {
		fmt.Fprintln(os.Stderr, "Usage: supersede --volume <vol> --reason <text> <new_id> <old_id>")
		os.Exit(1)
	}

	newID := fs.Arg(0)
	oldID := fs.Arg(1)

	s := getDB()
	defer s.Close()

	err := s.AddEdge(types.Edge{
		Source: newID,
		Target: oldID,
		Type:   types.EdgeSupersede,
		Reason: *reason,
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
	volume := fs.String("volume", "", "volume filter")
	tagFilter := fs.String("tag", "", "tag filter")
	hintsStr := fs.String("hints", "", "comma-separated hints (natural language)")
	fs.Parse(args)

	if *bid == "" || *stellarioDir == "" {
		fmt.Fprintln(os.Stderr, "Usage: constellation --dir <stellario-dir> --bid <intent> [--volume <vol>] [--tag <tag>] [--hints <hints>]")
		os.Exit(1)
	}

	// Read JSONL files
	entries, edges, err := reader.ReadProject(*stellarioDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading project: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "Loaded %d entries, %d edges\n", len(entries), len(edges))

	// Build orchestrator
	orch := orchestrator.New(entries, edges)

	// Parse hints
	var hints []string
	if *hintsStr != "" {
		hints = splitCSV(*hintsStr)
	}

	// Execute constellation
	result, err := orch.Constellation(orchestrator.ConstellationRequest{
		Bid:       *bid,
		Hints:     hints,
		Volume:    *volume,
		TagFilter: *tagFilter,
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

func printHelp() {
	fmt.Println(`stellario — graph engine

Commands:
  create        Create a new entry
  show          Show an entry with its edges
  search        Search active entries
  downstream    Find entries that derive from the given entry (transitive)
  propagate     Find entries that become stale if the given entry is superseded
  state         Show current active state for a volume/tag
  supersede     Mark an entry as superseded by another
  constellation Build an arc stream from a bid + hints
  help          Show this help

Environment:
  STELLARIO_DB  Path to SQLite database (default: stellario.db)`)
}
