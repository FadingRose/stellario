package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"stellario/engine/cmd"
	"stellario/engine/cluster"
	"stellario/engine/orchestrator"
	"stellario/engine/reader"
	"stellario/engine/store"
	"stellario/engine/types"
)

// clusterResolveProject wraps cluster.ResolveProject for use in main.
func clusterResolveProject(dir string) (string, string, string, error) {
	return cluster.ResolveProject(dir)
}

// getArg extracts a flag value from a string slice.
func getArg(args []string, flagName string) string {
	for i, arg := range args {
		if arg == flagName && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(arg, flagName+"=") {
			return strings.TrimPrefix(arg, flagName+"=")
		}
	}
	return ""
}

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
	case "doctor":
		cmdDoctor(args)
	case "status":
		cmdStatus(args)
	case "migrate":
		cmdMigrate(args)
	case "project":
		cmdProject(args)
	case "config":
		cmdConfig(args)
	case "memory-sync":
		cmdMemorySync(args)
	case "volume":
		cmdVolume(args)
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
	native := fs.Bool("native", false, "use native create with star-suffix ID (for fanout)")
	idFlag := fs.String("id", "", "explicit entry ID (fanout mode: use TS's ID)")
	frameType := fs.String("frame-type", "assert", "frame type")
	deriveFrom := fs.String("derive-from", "", "comma-separated entry IDs this derives from")
	fs.Parse(args)

	if *volume == "" || *content == "" {
		fmt.Fprintln(os.Stderr, "Error: --volume and --content are required")
		os.Exit(1)
	}

	// Native create path: star-suffix ID or fanout with provided ID
	if *native {
		opts := cmd.CreateOptions{
			Project:  *project,
			Volume:   *volume,
			Content:  *content,
			Tags:     splitCSV(*tagsStr),
			Keywords: splitCSV(*keywordsStr),
			Author:   *author,
		}
		if *idFlag != "" {
			opts.ID = *idFlag
		}
		result, err := cmd.RunCreate(opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		mode := "native"
		if opts.ID != "" {
			mode = "fanout"
		}
		_ = mode
		fmt.Printf("Created [%s] → %s:%s (%s)\n",
			result.ID, result.Project, result.Volume, mode)
		return
	}

	// Legacy create path (existing behavior)
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

func cmdDoctor(args []string) {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	root := fs.String("root", ".", "project root directory")
	compare := fs.Bool("compare", false, "compare JSONL vs SQLite for this project")
	compareProject := fs.String("project", "", "project name for --compare (uses global library)")
	noSync := fs.Bool("no-sync", false, "skip JSONL→SQLite sync before compare (fanout verification)")
	fs.Parse(args)

	if *compare {
		os.Exit(cmd.RunDoctorCompareNoSync(*root, *compareProject, *noSync))
	}

	os.Exit(cmd.RunDoctor(*root))
}

func cmdStatus(args []string) {
	os.Exit(cmd.RunStatus())
}

func cmdConfig(args []string) {
	if len(args) == 0 {
		fmt.Println("Usage: stellario config <show|validate|edit> [--root <dir>]")
		os.Exit(1)
	}

	subcmd := args[0]
	rest := args[1:]

	fs := flag.NewFlagSet("config", flag.ExitOnError)
	root := fs.String("root", ".", "project root directory")
	global := fs.Bool("global", false, "operate on global library config")
	fs.Parse(rest)

	switch subcmd {
	case "show":
		if *global {
			os.Exit(cmd.RunConfigShowGlobal())
		}
		os.Exit(cmd.RunConfigShow(*root))
	case "validate":
		os.Exit(cmd.RunConfigValidate(*root))
	case "edit":
		os.Exit(cmd.RunConfigEdit(*root))
	default:
		fmt.Fprintf(os.Stderr, "Unknown config subcommand: %s\n", subcmd)
		os.Exit(1)
	}
}

func cmdMemorySync(args []string) {
	fs := flag.NewFlagSet("memory-sync", flag.ExitOnError)
	project := fs.String("project", "", "specific project (default: all)")
	push := fs.Bool("push", false, "push to remote")
	pull := fs.Bool("pull", false, "pull from remote")
	statusOnly := fs.Bool("status", false, "show sync status only (default)")
	fs.Parse(args)

	opts := cmd.SyncOptions{
		ProjectName: *project,
		Push:        *push,
		Pull:        *pull,
		StatusOnly:  *statusOnly,
	}
	os.Exit(cmd.RunSync(opts))
}

func cmdVolume(args []string) {
	if len(args) == 0 {
		fmt.Println("Usage: stellario volume <list|stats|grep> [args]")
		fmt.Println()
		fmt.Println("  list [--project <name>] [--global]   List volumes with entry counts")
		fmt.Println("  stats <name> --project <name>         Detailed volume statistics")
		fmt.Println("  grep <pattern> [--project <name>]     Search entry content")
		os.Exit(1)
	}

	subcmd := args[0]
	rest := args[1:]

	switch subcmd {
	case "list":
		os.Exit(cmd.RunVolumeList(rest))
	case "stats":
		os.Exit(cmd.RunVolumeStats(rest))
	case "grep":
		os.Exit(cmd.RunVolumeGrep(rest))
	default:
		fmt.Fprintf(os.Stderr, "Unknown volume subcommand: %s\n", subcmd)
		os.Exit(1)
	}
}

func cmdMigrate(args []string) {
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	root := fs.String("root", ".", "project root directory")
	source := fs.String("source", "", "explicit source .stellario directory (default: auto-detect)")
	project := fs.String("project", "", "explicit project name (default: auto-resolve from git)")
	dryRun := fs.Bool("dry-run", false, "show what would be copied without copying")
	verify := fs.Bool("verify", true, "verify migration after copy")
	fs.Parse(args)

	// For backward compat: migrate still works but delegates to the subtree model
	opts := cmd.MigrateOptions{
		SourceDir:   *source,
		ProjectName: *project,
		ProjectRoot: *root,
		DryRun:      *dryRun,
		Verify:      *verify,
	}

	result, err := cmd.RunMigrate(opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	_ = result
}

func cmdProject(args []string) {
	if len(args) == 0 {
		fmt.Println("Usage: stellario project <list|register|forget|info|add|remote> [args]")
		fmt.Println()
		fmt.Println("  list                    List all registered projects")
		fmt.Println("  register <dir>          Register a local project directory")
		fmt.Println("  add <git-url>           Add project from remote (subtree)")
		fmt.Println("  add --local <dir>       Import local project data (subtree)")
		fmt.Println("  forget <name>           Remove from device registry")
		fmt.Println("  info <name>             Show project details")
		fmt.Println("  remote <name> [url]     Set/show/remove subtree remote")
		os.Exit(1)
	}

	subcmd := args[0]
	rest := args[1:]

	switch subcmd {
	case "list":
		os.Exit(cmd.RunProjectList())
	case "register":
		if len(rest) == 0 {
			fmt.Println("Usage: stellario project register <directory>")
			os.Exit(1)
		}
		os.Exit(cmd.RunProjectRegister(rest[0]))
	case "forget":
		if len(rest) == 0 {
			fmt.Println("Usage: stellario project forget <name>")
			os.Exit(1)
		}
		os.Exit(cmd.RunProjectForget(rest[0]))
	case "info":
		if len(rest) == 0 {
			fmt.Println("Usage: stellario project info <name>")
			os.Exit(1)
		}
		os.Exit(cmd.RunProjectInfo(rest[0]))
	case "remote":
		if len(rest) == 0 {
			fmt.Println("Usage: stellario project remote <name> [url|--remove]")
			os.Exit(1)
		}
		os.Exit(cmd.RunProjectRemote(rest[0], rest[1:]))
	case "add":
		if len(rest) == 0 {
			fmt.Println("Usage: stellario project add <git-remote-url> [--name <name>]")
			fmt.Println("       stellario project add --local <dir> [--name <name>]")
			os.Exit(1)
		}
		// Check for --local flag
		if rest[0] == "--local" {
			if len(rest) < 2 {
				fmt.Println("Usage: stellario project add --local <dir> [--name <name>]")
				os.Exit(1)
			}
			localDir := rest[1]
			// Resolve project name
			nameFlag := getArg(rest[2:], "--name")
			projectName := nameFlag
			if projectName == "" {
				name, _, _, err := clusterResolveProject(localDir)
				if err != nil {
					fmt.Printf("Error resolving project: %v\n", err)
					os.Exit(1)
				}
				projectName = name
			}
			os.Exit(cmd.RunProjectAddLocal(localDir, projectName))
		}
		// Remote URL mode
		remoteURL := rest[0]
		os.Exit(cmd.RunProjectAdd(remoteURL))
	default:
		fmt.Fprintf(os.Stderr, "Unknown project subcommand: %s\n", subcmd)
		fmt.Println("Usage: stellario project <list|register|forget|info> [args]")
		os.Exit(1)
	}
}

func printHelp() {
	fmt.Println(`stellario — graph engine + memory cluster manager

Memory Operations:
  create           Create a new entry
  show             Show an entry with its edges
  search           Search active entries
  supersede        Mark an entry as superseded by another

Graph Operations:
  downstream       Find entries that derive from the given entry (transitive)
  propagate        Find entries that become stale if the given entry is superseded
  state            Show current active state for a volume/tag
  constellation    Build an arc stream from a bid + hints

Cluster Management:
  status           Show cluster overview (all projects, volumes, sync state)
  doctor           Diagnose config + memory integrity (read-only)
  migrate          Copy memory data into the global library (~/.stellario/)
  project          Manage project registration (list/register/forget/info/add/remote)
  config           Show/validate/edit config (--global for global library)
  volume           List/stats/grep volumes and entries
  memory-sync      Git subtree push/pull per project
  sync             Sync JSONL files into SQLite (bulk import stale volumes)

Environment:
  STELLARIO_DB       Path to SQLite database (default: ~/.local/share/stellario/stellario.db)`)
}
