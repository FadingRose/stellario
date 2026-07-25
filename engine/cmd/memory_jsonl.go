package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"stellario/engine/cluster"
	"stellario/engine/config"
	"stellario/engine/jsonlstore"
)

// memoryCtx holds resolved project memory directory and config.
type memoryCtx struct {
	Project  string
	MemDir   string
	Config   *config.StellarioConfig
	StarName string
}

// resolveMemoryCtx resolves a project name (or "_global") to its device-local
// memory directory and validated config.
func resolveMemoryCtx(projectName string) (*memoryCtx, error) {
	dev, err := cluster.GetOrCreateDeviceID()
	if err != nil {
		return nil, fmt.Errorf("device identity: %w", err)
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
			return nil, err
		}
		// Fallback to container path if device-local dir does not exist yet.
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
		return nil, fmt.Errorf("config not found for project %q", projectName)
	}

	result, err := config.LoadAndValidatePath(configPath)
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}

	return &memoryCtx{
		Project:  projectName,
		MemDir:   memDir,
		Config:   result.Config,
		StarName: dev.Star,
	}, nil
}

// agentOrDefault returns the agent name, defaulting to the CLI-invoking user.
func agentOrDefault(agent string) string {
	if agent != "" {
		return agent
	}
	if v := os.Getenv("STELLARIO_AGENT"); v != "" {
		return v
	}
	return "cli"
}

// displayID formats an entry ID for display as "volume:id".
func displayID(entry *jsonlstore.Entry, volume string) string {
	base := stripStarSuffix(entry.ID)
	if len(base) == 0 {
		return entry.ID
	}
	// numeric suffix is everything after the prefix (first char)
	numeric := base[1:]
	return volume + ":" + numeric
}

func stripStarSuffix(id string) string {
	if i := strings.LastIndex(id, "."); i > 0 {
		return id[:i]
	}
	return id
}

// ─── revise ─────────────────────────────────────────────────────────────────

type ReviseEdit struct {
	From    int    `json:"from"`
	To      int    `json:"to"`
	Content string `json:"content"`
}

type ReviseOptions struct {
	Project  string
	ID       string
	Edits    []ReviseEdit
	Tags     []string
	Keywords []string
	Message  string
	Agent    string
}

func RunRevise(opts ReviseOptions) error {
	ctx, err := resolveMemoryCtx(opts.Project)
	if err != nil {
		return err
	}
	agent := agentOrDefault(opts.Agent)

	entry, volume, err := jsonlstore.FindEntry(ctx.MemDir, ctx.Config, opts.ID)
	if err != nil {
		return err
	}
	if entry == nil {
		return fmt.Errorf("entry %q not found", opts.ID)
	}
	if !jsonlstore.CanRevise(volume, ctx.Config) {
		return fmt.Errorf("volume %q does not allow revisions", volume)
	}
	if entry.Author != agent {
		return fmt.Errorf("only the author (%s) can revise %q", entry.Author, opts.ID)
	}
	if len(opts.Edits) == 0 && opts.Tags == nil && opts.Keywords == nil {
		return fmt.Errorf("revise requires edits, tags, or keywords")
	}
	if opts.Message == "" {
		return fmt.Errorf("revise requires a message")
	}

	entries, err := jsonlstore.ReadVolume(ctx.MemDir, volume)
	if err != nil {
		return err
	}
	idx := -1
	for i := range entries {
		if entries[i].ID == entry.ID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return fmt.Errorf("entry %q not found in volume %q", entry.ID, volume)
	}

	updated := *entry
	changes := []string{}

	if len(opts.Edits) > 0 {
		lines := strings.Split(updated.Content, "\n")
		total := len(lines)
		// validate and normalize
		parsed := make([]jsonlstoreEdit, len(opts.Edits))
		for i, e := range opts.Edits {
			to := e.To
			if to == 0 {
				to = e.From
			}
			if e.From < 1 || to < 1 || e.From > total || to > total {
				return fmt.Errorf("line range %d-%d out of range (1-%d)", e.From, to, total)
			}
			if e.From > to {
				return fmt.Errorf("invalid range: from (%d) > to (%d)", e.From, to)
			}
			parsed[i] = jsonlstoreEdit{start: e.From, end: to, content: e.Content, label: fmt.Sprintf("%d-%d", e.From, to)}
		}
		// sort highest-line first
		for i := 0; i < len(parsed)-1; i++ {
			for j := i + 1; j < len(parsed); j++ {
				if parsed[i].start < parsed[j].start {
					parsed[i], parsed[j] = parsed[j], parsed[i]
				}
			}
		}
		// check overlap
		for i := 0; i < len(parsed)-1; i++ {
			if parsed[i].start <= parsed[i+1].end {
				return fmt.Errorf("ranges %s and %s overlap", parsed[i].label, parsed[i+1].label)
			}
		}
		for _, e := range parsed {
			replacement := []string{}
			if e.content != "" {
				replacement = strings.Split(e.content, "\n")
			}
			lines = append(lines[:e.start-1], append(replacement, lines[e.end:]...)...)
		}
		updated.Content = strings.Join(lines, "\n")
		labels := make([]string, len(parsed))
		for i, e := range parsed {
			labels[i] = e.label
		}
		changes = append(changes, fmt.Sprintf("content(%s)", strings.Join(labels, ", ")))
	}

	if opts.Tags != nil {
		updated.Tags = dedupeStrings(opts.Tags)
		changes = append(changes, "tags")
	}
	if opts.Keywords != nil {
		updated.Keywords = dedupeStrings(opts.Keywords)
		changes = append(changes, "keywords")
	}

	updated.Updated = jsonlstore.Today()
	entries[idx] = updated

	if err := jsonlstore.WriteVolume(ctx.MemDir, volume, entries); err != nil {
		return err
	}
	if err := jsonlstore.WriteEntryMd(ctx.MemDir, volume, &updated); err != nil {
		return err
	}

	hash, err := jsonlstore.GitCommit(ctx.MemDir, volume,
		fmt.Sprintf("revise: %s\n\nEntry: %s\nChanges: %s", opts.Message, updated.ID, strings.Join(changes, ", ")),
		[]string{updated.ID})
	if err != nil {
		// non-fatal
		hash = ""
	}

	fmt.Printf("Revised [%s] → %s\n", displayID(&updated, volume), volume)
	fmt.Printf("Changes: %s\n", strings.Join(changes, ", "))
	if hash != "" {
		fmt.Printf("Commit: %s\n", hash)
	}
	fmt.Printf("Message: %s\n", opts.Message)
	return nil
}

type jsonlstoreEdit struct {
	start, end int
	content    string
	label      string
}

// ─── forget ─────────────────────────────────────────────────────────────────

type ForgetOptions struct {
	Project string
	ID      string
	Agent   string
}

func RunForget(opts ForgetOptions) error {
	ctx, err := resolveMemoryCtx(opts.Project)
	if err != nil {
		return err
	}
	agent := agentOrDefault(opts.Agent)

	entry, volume, err := jsonlstore.FindEntry(ctx.MemDir, ctx.Config, opts.ID)
	if err != nil {
		return err
	}
	if entry == nil {
		return fmt.Errorf("entry %q not found", opts.ID)
	}
	if !jsonlstore.CanForget(volume, ctx.Config) {
		return fmt.Errorf("volume %q does not allow forget", volume)
	}
	if entry.Author != agent {
		return fmt.Errorf("only the author (%s) can forget %q", entry.Author, opts.ID)
	}

	entries, err := jsonlstore.ReadVolume(ctx.MemDir, volume)
	if err != nil {
		return err
	}
	filtered := make([]jsonlstore.Entry, 0, len(entries))
	for _, e := range entries {
		if e.ID != entry.ID {
			filtered = append(filtered, e)
		}
	}
	if len(filtered) == len(entries) {
		return fmt.Errorf("entry %q not found in volume %q", entry.ID, volume)
	}

	archived := *entry
	archived.Volume = "archived"
	archived.ArchivedAt = jsonlstore.NowISO()
	archived.ArchivedReason = "forget"

	if err := jsonlstore.WriteVolume(ctx.MemDir, volume, filtered); err != nil {
		return err
	}

	archivedEntries, _ := jsonlstore.ReadVolume(ctx.MemDir, "archived")
	archivedEntries = append(archivedEntries, archived)
	if err := jsonlstore.WriteVolume(ctx.MemDir, "archived", archivedEntries); err != nil {
		return err
	}

	jsonlstore.RemoveEntryMd(ctx.MemDir, volume, entry.ID)
	jsonlstore.WriteEntryMd(ctx.MemDir, "archived", &archived)

	hash1, _ := jsonlstore.GitCommit(ctx.MemDir, volume,
		fmt.Sprintf("archive: %s\n\nEntry: %s\nFrom: %s → archived", truncate(archived.Content, 50), entry.ID, volume),
		[]string{entry.ID})
	hash2, _ := jsonlstore.GitCommit(ctx.MemDir, "archived",
		fmt.Sprintf("archived: %s\n\nEntry: %s\nFrom: %s", truncate(archived.Content, 50), entry.ID, volume),
		[]string{entry.ID})

	fmt.Printf("Archived [%s] %s → archived\n", displayID(&archived, volume), volume)
	fmt.Printf("Author: %s\n", archived.Author)
	if hash1 != "" {
		fmt.Printf("Commit: %s\n", hash1)
	}
	if hash2 != "" && hash2 != hash1 {
		fmt.Printf("Archived commit: %s\n", hash2)
	}
	return nil
}

// ─── history ────────────────────────────────────────────────────────────────

type HistoryOptions struct {
	Project string
	ID      string
	Limit   int
}

func RunHistory(opts HistoryOptions) error {
	ctx, err := resolveMemoryCtx(opts.Project)
	if err != nil {
		return err
	}
	if opts.Limit <= 0 {
		opts.Limit = 10
	}

	entry, volume, err := jsonlstore.FindEntry(ctx.MemDir, ctx.Config, opts.ID)
	if err != nil {
		return err
	}
	if entry == nil {
		return fmt.Errorf("entry %q not found", opts.ID)
	}

	log, err := jsonlstore.GitLogEntry(ctx.MemDir, volume, entry.ID, opts.Limit)
	if err != nil {
		return err
	}
	if log == "" {
		fmt.Printf("No git history for [%s] in %s.\n", opts.ID, volume)
		return nil
	}

	fmt.Printf("History for [%s] in %s:\n\n%s\n", opts.ID, volume, log)
	return nil
}

// ─── meta ───────────────────────────────────────────────────────────────────

type MetaOptions struct {
	Project string
	Content string
	Agent   string
}

func RunMeta(opts MetaOptions) error {
	ctx, err := resolveMemoryCtx(opts.Project)
	if err != nil {
		return err
	}
	agent := agentOrDefault(opts.Agent)

	// Find meta volume (first mutable volume named "meta")
	var metaVol string
	for name, def := range ctx.Config.Volumes {
		if name == "meta" && def != nil && def.Profile == config.ProfileMutable {
			metaVol = name
			break
		}
	}
	if metaVol == "" {
		return fmt.Errorf("no meta volume defined")
	}
	if !jsonlstore.CanWrite(agent, metaVol, ctx.Config) {
		return fmt.Errorf("agent %q cannot write to meta", agent)
	}

	id, err := jsonlstore.GenerateNextId(ctx.MemDir, metaVol, ctx.Config, ctx.StarName)
	if err != nil {
		return err
	}

	entry := jsonlstore.Entry{
		ID:      id,
		Volume:  metaVol,
		Content: strings.TrimSpace(opts.Content),
		Tags:    nil,
		Author:  agent,
		Created: jsonlstore.Today(),
		Updated: jsonlstore.Today(),
	}

	entries, _ := jsonlstore.ReadVolume(ctx.MemDir, metaVol)
	entries = append(entries, entry)
	if err := jsonlstore.WriteVolume(ctx.MemDir, metaVol, entries); err != nil {
		return err
	}
	if err := jsonlstore.WriteEntryMd(ctx.MemDir, metaVol, &entry); err != nil {
		return err
	}

	hash, _ := jsonlstore.GitCommit(ctx.MemDir, metaVol,
		fmt.Sprintf("meta: %s\n\nEntry: %s\nAuthor: %s", truncate(entry.Content, 50), id, agent),
		[]string{id})

	fmt.Printf("Calibrated [%s] → %s\n", displayID(&entry, metaVol), metaVol)
	fmt.Println("This calibration will take effect on next session startup.")
	fmt.Printf("Author: %s\n", agent)
	if hash != "" {
		fmt.Printf("Commit: %s\n", hash)
	}
	return nil
}

// ─── ref / unref ────────────────────────────────────────────────────────────

type RefOptions struct {
	Project string
	ID      string
	Target  string
	Reason  string
	Agent   string
}

func RunRef(opts RefOptions) error {
	ctx, err := resolveMemoryCtx(opts.Project)
	if err != nil {
		return err
	}
	agent := agentOrDefault(opts.Agent)

	if opts.ID == opts.Target {
		return fmt.Errorf("cannot link an entry to itself")
	}

	source, sourceVol, err := jsonlstore.FindEntry(ctx.MemDir, ctx.Config, opts.ID)
	if err != nil {
		return err
	}
	if source == nil {
		return fmt.Errorf("source entry %q not found", opts.ID)
	}
	if !jsonlstore.CanWrite(agent, sourceVol, ctx.Config) {
		return fmt.Errorf("agent %q cannot write to volume %q", agent, sourceVol)
	}

	targetEntry, targetVol, err := jsonlstore.FindEntry(ctx.MemDir, ctx.Config, opts.Target)
	if err != nil {
		return err
	}
	if targetEntry == nil {
		return fmt.Errorf("target entry %q not found", opts.Target)
	}
	if !jsonlstore.CanRead(agent, targetVol, ctx.Config) {
		return fmt.Errorf("agent %q cannot read target volume %q", agent, targetVol)
	}
	if targetEntry.ArchivedAt != "" {
		return fmt.Errorf("cannot link to archived entry %q", opts.Target)
	}

	entries, err := jsonlstore.ReadVolume(ctx.MemDir, sourceVol)
	if err != nil {
		return err
	}
	var src *jsonlstore.Entry
	for i := range entries {
		if entries[i].ID == source.ID {
			src = &entries[i]
			break
		}
	}
	if src == nil {
		return fmt.Errorf("source entry %q not found in volume %q", source.ID, sourceVol)
	}

	// Already linked?
	for _, r := range src.Refs {
		if r.Target == opts.Target || r.Target == targetEntry.ID {
			return fmt.Errorf("[%s] is already linked to [%s]", opts.ID, opts.Target)
		}
	}

	// Restore from refs_removed if needed
	if len(src.RefsRemoved) > 0 {
		filtered := make([]string, 0, len(src.RefsRemoved))
		for _, t := range src.RefsRemoved {
			if t != opts.Target {
				filtered = append(filtered, t)
			}
		}
		src.RefsRemoved = filtered
	}

	src.Refs = append(src.Refs, jsonlstore.Ref{
		Target: targetEntry.ID,
		Reason: strings.TrimSpace(opts.Reason),
		Source: "manual",
	})
	src.Updated = jsonlstore.Today()

	if err := jsonlstore.WriteVolume(ctx.MemDir, sourceVol, entries); err != nil {
		return err
	}
	if err := jsonlstore.WriteEntryMd(ctx.MemDir, sourceVol, src); err != nil {
		return err
	}

	hash, _ := jsonlstore.GitCommit(ctx.MemDir, sourceVol,
		fmt.Sprintf("ref: %s → %s\n\nReason: %s", source.ID, targetEntry.ID, opts.Reason),
		[]string{source.ID})

	fmt.Printf("Ref'd [%s] → [%s]\n", opts.ID, opts.Target)
	fmt.Printf("Reason: %s\n", opts.Reason)
	if hash != "" {
		fmt.Printf("Commit: %s\n", hash)
	}
	return nil
}

type UnrefOptions struct {
	Project string
	ID      string
	Target  string
	Agent   string
}

func RunUnref(opts UnrefOptions) error {
	ctx, err := resolveMemoryCtx(opts.Project)
	if err != nil {
		return err
	}
	agent := agentOrDefault(opts.Agent)

	source, sourceVol, err := jsonlstore.FindEntry(ctx.MemDir, ctx.Config, opts.ID)
	if err != nil {
		return err
	}
	if source == nil {
		return fmt.Errorf("source entry %q not found", opts.ID)
	}
	if !jsonlstore.CanWrite(agent, sourceVol, ctx.Config) {
		return fmt.Errorf("agent %q cannot write to volume %q", agent, sourceVol)
	}

	targetEntry, _, err := jsonlstore.FindEntry(ctx.MemDir, ctx.Config, opts.Target)
	if err != nil {
		return err
	}
	targetStored := opts.Target
	if targetEntry != nil {
		targetStored = targetEntry.ID
	}

	entries, err := jsonlstore.ReadVolume(ctx.MemDir, sourceVol)
	if err != nil {
		return err
	}
	var src *jsonlstore.Entry
	for i := range entries {
		if entries[i].ID == source.ID {
			src = &entries[i]
			break
		}
	}
	if src == nil {
		return fmt.Errorf("source entry %q not found in volume %q", source.ID, sourceVol)
	}

	refIdx := -1
	for i, r := range src.Refs {
		if r.Target == opts.Target || r.Target == targetStored {
			refIdx = i
			break
		}
	}
	if refIdx == -1 {
		for _, t := range src.RefsRemoved {
			if t == opts.Target {
				return fmt.Errorf("[%s] is already unref'd from [%s]", opts.ID, opts.Target)
			}
		}
		return fmt.Errorf("no ref from [%s] to [%s]", opts.ID, opts.Target)
	}

	ref := src.Refs[refIdx]
	if ref.Source == "auto" {
		// Remove bidirectional auto ref and add to refs_removed
		src.Refs = append(src.Refs[:refIdx], src.Refs[refIdx+1:]...)
		src.RefsRemoved = append(src.RefsRemoved, opts.Target)

		// Remove reverse auto ref from target if in same volume
		for i := range entries {
			if entries[i].ID == targetStored {
				newRefs := make([]jsonlstore.Ref, 0, len(entries[i].Refs))
				for _, r := range entries[i].Refs {
					if !(r.Target == source.ID && r.Source == "auto") {
						newRefs = append(newRefs, r)
					}
				}
				entries[i].Refs = newRefs
				entries[i].Updated = jsonlstore.Today()
			}
		}
	} else {
		src.Refs = append(src.Refs[:refIdx], src.Refs[refIdx+1:]...)
	}
	src.Updated = jsonlstore.Today()

	changedIds := []string{source.ID}
	if targetEntry != nil {
		changedIds = append(changedIds, targetEntry.ID)
	}

	if err := jsonlstore.WriteVolume(ctx.MemDir, sourceVol, entries); err != nil {
		return err
	}
	for _, id := range changedIds {
		for i := range entries {
			if entries[i].ID == id {
				jsonlstore.WriteEntryMd(ctx.MemDir, sourceVol, &entries[i])
			}
		}
	}

	hash, _ := jsonlstore.GitCommit(ctx.MemDir, sourceVol,
		fmt.Sprintf("unref: %s ⊥ %s", source.ID, targetStored),
		changedIds)

	refType := "manual"
	if ref.Source == "auto" {
		refType = "auto (bidirectional)"
	}
	fmt.Printf("Unref'd [%s] ⊥ [%s] (%s)\n", opts.ID, opts.Target, refType)
	if hash != "" {
		fmt.Printf("Commit: %s\n", hash)
	}
	return nil
}

// ─── helpers ────────────────────────────────────────────────────────────────

func dedupeStrings(ss []string) []string {
	seen := make(map[string]bool)
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// printJSON marshals v as indented JSON to stdout.
func printJSON(v interface{}) {
	data, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(data))
}

// parseInt is a small helper for flag parsing.
func parseInt(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
