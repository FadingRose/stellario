// Package jsonlstore provides read/write operations on stellario's JSONL
// ground-truth format. It mirrors the TS store layer so the Go CLI can
// operate independently without breaking the existing opencode wrapper.
package jsonlstore

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"stellario/engine/config"
)

// Entry matches the on-disk JSONL format used by the TS runtime.
type Entry struct {
	ID          string   `json:"id"`
	Volume      string   `json:"volume"`
	Content     string   `json:"content"`
	Tags        []string `json:"tags,omitempty"`
	Keywords    []string `json:"keywords,omitempty"`
	Author      string   `json:"author"`
	Created     string   `json:"created"`
	Updated     string   `json:"updated"`
	Refs        []Ref    `json:"refs,omitempty"`
	RefsRemoved []string `json:"refs_removed,omitempty"`
	ArchivedAt  string   `json:"archived_at,omitempty"`
	ArchivedReason string `json:"archived_reason,omitempty"`
}

// Ref matches the TS memory ref format.
type Ref struct {
	Target string `json:"target"`
	Reason string `json:"reason"`
	Source string `json:"source"`
}

// VolumeDef is an alias for config.VolumeDef.
type VolumeDef = config.VolumeDef

// Config is an alias for config.StellarioConfig.
type Config = config.StellarioConfig

// ReadVolume reads all entries from a single JSONL volume file.
func ReadVolume(memDir, volume string) ([]Entry, error) {
	path := filepath.Join(memDir, volume+".jsonl")
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Entry{}, nil
		}
		return nil, err
	}
	defer f.Close()

	var entries []Entry
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var e Entry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue // skip malformed lines, matching TS behavior
		}
		entries = append(entries, e)
	}
	return entries, scanner.Err()
}

// WriteVolume writes entries to a JSONL volume file.
func WriteVolume(memDir, volume string, entries []Entry) error {
	path := filepath.Join(memDir, volume+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	for _, e := range entries {
		data, err := json.Marshal(e)
		if err != nil {
			return err
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
		if err := w.WriteByte('\n'); err != nil {
			return err
		}
	}
	return w.Flush()
}

// VolumeIndexEntry represents a row in volumes.jsonl.
type VolumeIndexEntry struct {
	Volume    string `json:"volume"`
	NextNonce int    `json:"next_nonce"`
}

// ReadVolumeIndex reads volumes.jsonl.
func ReadVolumeIndex(memDir string) ([]VolumeIndexEntry, error) {
	path := filepath.Join(memDir, "volumes.jsonl")
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []VolumeIndexEntry{}, nil
		}
		return nil, err
	}
	defer f.Close()

	var idx []VolumeIndexEntry
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var e VolumeIndexEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		idx = append(idx, e)
	}
	return idx, scanner.Err()
}

// WriteVolumeIndex writes volumes.jsonl.
func WriteVolumeIndex(memDir string, idx []VolumeIndexEntry) error {
	path := filepath.Join(memDir, "volumes.jsonl")
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	for _, e := range idx {
		data, err := json.Marshal(e)
		if err != nil {
			return err
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
		if err := w.WriteByte('\n'); err != nil {
			return err
		}
	}
	return w.Flush()
}

// FindEntry searches for an entry by ID across all volumes + archived.
// Accepts display IDs ("active:01") and short IDs ("a01").
func FindEntry(memDir string, cfg *Config, id string) (*Entry, string, error) {
	// Display ID: "volume:number"
	if strings.Contains(id, ":") {
		parts := strings.SplitN(id, ":", 2)
		volume := parts[0]
		storedSuffix := parts[1]
		entries, err := ReadVolume(memDir, volume)
		if err != nil {
			return nil, "", err
		}
		for i := range entries {
			if stripStarSuffix(entries[i].ID)[1:] == storedSuffix {
				return &entries[i], volume, nil
			}
		}
		// Check archived
		entries, err = ReadVolume(memDir, "archived")
		if err == nil {
			for i := range entries {
				if stripStarSuffix(entries[i].ID)[1:] == storedSuffix {
					return &entries[i], "archived", nil
				}
			}
		}
		return nil, "", nil
	}

	// Short ID: search volumes in priority order, then archived.
	candidate := volumeFromID(id, cfg)
	order := []string{}
	seen := map[string]bool{}
	if candidate != "" {
		order = append(order, candidate)
		seen[candidate] = true
	}
	for v := range cfg.Volumes {
		if !seen[v] {
			order = append(order, v)
			seen[v] = true
		}
	}
	order = append(order, "archived")

	for _, volume := range order {
		entries, err := ReadVolume(memDir, volume)
		if err != nil {
			continue
		}
		for i := range entries {
			if idMatch(entries[i].ID, id) {
				return &entries[i], volume, nil
			}
		}
	}
	return nil, "", nil
}

// GenerateNextId returns the next ID for a volume.
// Scratch profiles get a short hash ID; stable profiles get a sequential ID.
// In the device-relative model, IDs carry NO star suffix.
func GenerateNextId(memDir string, volume string, cfg *Config, star string) (string, error) {
	def, ok := cfg.Volumes[volume]
	if !ok || def == nil {
		return "", fmt.Errorf("unknown volume %q", volume)
	}

	prefix := volumePrefix(volume, cfg)

	// Scratch profiles use hash IDs.
	if def.Profile == config.ProfileScratch {
		return generateShortHashId(prefix), nil
	}

	// Try nonce index first.
	if nonce, ok := bumpNonce(memDir, volume); ok {
		return fmt.Sprintf("%s%s", prefix, nonceStr(nonce, prefix)), nil
	}

	// Fallback: scan max numeric ID (strip star suffix for comparison).
	entries, _ := ReadVolume(memDir, volume)
	archived, _ := ReadVolume(memDir, "archived")
	entries = append(entries, archived...)
	max := 0
	for _, e := range entries {
		base := stripStarSuffix(e.ID)
		if !strings.HasPrefix(base, prefix) {
			continue
		}
		num, err := strconv.Atoi(base[len(prefix):])
		if err == nil && num > max {
			max = num
		}
	}
	return fmt.Sprintf("%s%s", prefix, nonceStr(max+1, prefix)), nil
}

func generateShortHashId(prefix string) string {
	b := make([]byte, 4)
	for i := range b {
		b[i] = byte('a' + rand.Intn(26))
	}
	return prefix + string(b)
}

func bumpNonce(memDir, volume string) (int, bool) {
	idx, err := ReadVolumeIndex(memDir)
	if err != nil {
		return 0, false
	}
	for i := range idx {
		if idx[i].Volume == volume {
			nonce := idx[i].NextNonce
			idx[i].NextNonce++
			_ = WriteVolumeIndex(memDir, idx)
			return nonce, true
		}
	}
	return 0, false
}

func nonceStr(n int, prefix string) string {
	// Pad to at least 2 digits for sequential IDs.
	return fmt.Sprintf("%0*d", max(2, len(prefix)), n)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// CanWrite checks if an agent can write to a volume.
func CanWrite(agent string, volume string, cfg *Config) bool {
	def, ok := cfg.Volumes[volume]
	if !ok || def == nil {
		return false
	}
	if def.Profile == config.ProfileFrozen || def.Profile == config.ProfileAppend {
		return false
	}
	if len(def.Boundaries.Write) == 0 {
		return true
	}
	for _, a := range def.Boundaries.Write {
		if a == "all" || a == agent {
			return true
		}
	}
	return false
}

// CanRead checks if an agent can read a volume.
func CanRead(agent string, volume string, cfg *Config) bool {
	def, ok := cfg.Volumes[volume]
	if !ok || def == nil {
		return false
	}
	if len(def.Boundaries.Read) == 0 {
		return true
	}
	for _, a := range def.Boundaries.Read {
		if a == "all" || a == agent {
			return true
		}
	}
	return false
}

// CanRevise reports whether a volume allows revisions.
func CanRevise(volume string, cfg *Config) bool {
	def, ok := cfg.Volumes[volume]
	if !ok || def == nil {
		return false
	}
	return def.Profile == config.ProfileMutable || def.Profile == config.ProfileWorkspace || def.Profile == config.ProfileScratch
}

// CanForget reports whether a volume allows archiving entries.
func CanForget(volume string, cfg *Config) bool {
	def, ok := cfg.Volumes[volume]
	if !ok || def == nil {
		return false
	}
	return def.Profile != config.ProfileFrozen && def.Profile != config.ProfileAppend
}

// FormatEntryMdForTrack formats an entry as markdown for git tracking.
func FormatEntryMdForTrack(e *Entry) string {
	return fmt.Sprintf("# %s\n\n%s\n\ntags: %s\nkeywords: %s\nauthor: %s\ncreated: %s\nupdated: %s\n",
		e.ID,
		e.Content,
		strings.Join(e.Tags, " · "),
		strings.Join(e.Keywords, " · "),
		e.Author,
		e.Created,
		e.Updated,
	)
}

// WriteEntryMd writes a per-entry markdown file for git tracking.
func WriteEntryMd(memDir, volume string, e *Entry) error {
	dir := filepath.Join(memDir, ".track", volume)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	path := filepath.Join(dir, e.ID+".md")
	return os.WriteFile(path, []byte(FormatEntryMdForTrack(e)), 0644)
}

// RemoveEntryMd removes a per-entry markdown file.
func RemoveEntryMd(memDir, volume, id string) error {
	path := filepath.Join(memDir, ".track", volume, id+".md")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// GitCommit stages the volume JSONL and per-entry track files, commits, and
// attempts a silent push. It returns the short commit hash or "" if skipped.
func GitCommit(memDir, volume, message string, entryIds []string) (string, error) {
	if !IsGitRepo(memDir) {
		return "", nil
	}
	files := []string{volume + ".jsonl"}
	for _, id := range entryIds {
		files = append(files, filepath.Join(".track", volume, id+".md"))
	}
	if err := runGit(memDir, append([]string{"add", "-A"}, files...)...); err != nil {
		return "", err
	}
	if err := runGit(memDir, "commit", "-m", message); err != nil {
		return "", err
	}
	hash, err := gitOutput(memDir, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "", err
	}
	// Fire-and-forget push
	_ = runGit(memDir, "push", "origin", "HEAD")
	return strings.TrimSpace(hash), nil
}

// GitLogEntry returns the git log for a specific entry's track file.
func GitLogEntry(memDir, volume, id string, limit int) (string, error) {
	if !IsGitRepo(memDir) {
		return "", nil
	}
	path := filepath.Join(".track", volume, id+".md")
	out, err := gitOutput(memDir, "log", "--oneline", fmt.Sprintf("-%d", limit), "--", path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// IsGitRepo reports whether memDir is inside a git repo.
func IsGitRepo(memDir string) bool {
	_, err := gitOutput(memDir, "rev-parse", "--git-dir")
	return err == nil
}

// Today returns today's date in stellario format (YYYY-MM-DD).
func Today() string {
	return time.Now().UTC().Format("2006-01-02")
}

// NowISO returns the current ISO timestamp.
func NowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// helpers

func runGit(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}

func gitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	return string(out), err
}

func stripStarSuffix(id string) string {
	if i := strings.LastIndex(id, "."); i > 0 {
		return id[:i]
	}
	return id
}

func volumePrefix(volume string, cfg *Config) string {
	if def, ok := cfg.Volumes[volume]; ok && def != nil && def.IDPrefix != "" {
		return def.IDPrefix
	}
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

func volumeFromID(id string, cfg *Config) string {
	if id == "" {
		return ""
	}
	for name, def := range cfg.Volumes {
		if def == nil {
			continue
		}
		prefix := def.IDPrefix
		if prefix == "" {
			prefix = string(name[0])
		}
		if strings.HasPrefix(id, prefix) {
			return name
		}
	}
	return ""
}

func idMatch(storedID, query string) bool {
	// Strip star suffix from stored ID before comparing.
	base := stripStarSuffix(storedID)
	return base == query || storedID == query
}

func parseIdNumber(id string) (int, error) {
	base := stripStarSuffix(id)
	// Find numeric suffix starting after prefix.
	i := 0
	for i < len(base) && !isDigit(base[i]) {
		i++
	}
	if i >= len(base) {
		return 0, fmt.Errorf("no number in id")
	}
	return strconv.Atoi(base[i:])
}

func isDigit(b byte) bool {
	return b >= '0' && b <= '9'
}
