package store

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"stellario/engine/types"
)

// Store wraps a SQLite database for memory entries and graph edges.
type Store struct {
	db *sql.DB
}

// DefaultDBPath returns the global default SQLite path.
func DefaultDBPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "stellario.db"
	}
	return filepath.Join(home, ".local", "share", "stellario", "stellario.db")
}

// Open opens or creates a SQLite database at the given path.
func Open(path string) (*Store, error) {
	// Ensure parent directory exists
	if dir := filepath.Dir(path); dir != "" {
		os.MkdirAll(dir, 0755)
	}

	db, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS entries (
		id         TEXT NOT NULL,
		project    TEXT NOT NULL DEFAULT '_default',
		volume     TEXT NOT NULL,
		content    TEXT NOT NULL,
		tags       TEXT NOT NULL DEFAULT '[]',
		keywords   TEXT NOT NULL DEFAULT '[]',
		author     TEXT NOT NULL DEFAULT '',
		frame_type TEXT NOT NULL DEFAULT 'assert',
		active     INTEGER NOT NULL DEFAULT 1,
		created_at TIMESTAMP NOT NULL,
		updated_at TIMESTAMP NOT NULL,
		PRIMARY KEY (id, project, volume)
	);

	CREATE INDEX IF NOT EXISTS idx_entries_project_volume ON entries(project, volume);
	CREATE INDEX IF NOT EXISTS idx_entries_active ON entries(active);
	CREATE INDEX IF NOT EXISTS idx_entries_tags ON entries(tags);

	CREATE TABLE IF NOT EXISTS edges (
		source          TEXT NOT NULL,
		source_project  TEXT NOT NULL DEFAULT '_default',
		target          TEXT NOT NULL,
		target_project  TEXT DEFAULT NULL,
		type            TEXT NOT NULL,
		reason          TEXT NOT NULL DEFAULT '',
		created_at      TIMESTAMP NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_project, source, type);
	CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_project, target, type);

	CREATE TABLE IF NOT EXISTS entry_history (
		id         TEXT NOT NULL,
		project    TEXT NOT NULL DEFAULT '_default',
		volume     TEXT NOT NULL,
		version    INTEGER NOT NULL,
		content    TEXT NOT NULL,
		tags       TEXT NOT NULL DEFAULT '[]',
		keywords   TEXT NOT NULL DEFAULT '[]',
		frame_type TEXT NOT NULL DEFAULT 'assert',
		revised_at TIMESTAMP NOT NULL,
		message    TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (id, project, volume, version)
	);

	CREATE TABLE IF NOT EXISTS volume_meta (
		project      TEXT NOT NULL DEFAULT '_default',
		volume       TEXT NOT NULL,
		next_nonce   INTEGER NOT NULL DEFAULT 1,
		last_synced  TIMESTAMP,
		jsonl_mtime  INTEGER DEFAULT 0,
		jsonl_path   TEXT DEFAULT '',
		PRIMARY KEY (project, volume)
	);

	CREATE TABLE IF NOT EXISTS hint_translations (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		hint       TEXT NOT NULL,
		bid        TEXT,
		translated TEXT NOT NULL,
		applied    INTEGER NOT NULL DEFAULT 1,
		feedback   TEXT DEFAULT NULL,
		created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
	);

	CREATE INDEX IF NOT EXISTS idx_hint_trans_hint ON hint_translations(hint);

	CREATE TABLE IF NOT EXISTS hint_corrections (
		id                    INTEGER PRIMARY KEY AUTOINCREMENT,
		hint                  TEXT NOT NULL,
		bad_translation       TEXT NOT NULL,
		good_translation      TEXT NOT NULL,
		reason                TEXT NOT NULL,
		source_translation_id INTEGER DEFAULT NULL,
		created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
	);

	CREATE INDEX IF NOT EXISTS idx_hint_corrections_hint ON hint_corrections(hint);

	CREATE TABLE IF NOT EXISTS intent_log (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		intent      TEXT NOT NULL,
		query       TEXT NOT NULL DEFAULT '',
		volumes     TEXT NOT NULL DEFAULT '[]',
		tags        TEXT NOT NULL DEFAULT '[]',
		result_count INTEGER NOT NULL DEFAULT 0,
		project     TEXT NOT NULL DEFAULT '_default',
		created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
	);

	CREATE INDEX IF NOT EXISTS idx_intent_log_project ON intent_log(project);
	CREATE INDEX IF NOT EXISTS idx_intent_log_created ON intent_log(created_at);
	`
	_, err := s.db.Exec(schema)
	return err
}

// ── Entry CRUD ──────────────────────────────────────────────────────────────

// CreateEntry inserts a new entry and returns it with computed active state.
func (s *Store) CreateEntry(e types.Entry) (*types.Entry, error) {
	if e.FrameType == "" {
		e.FrameType = types.FrameAssert
	}
	e.Active = true
	now := time.Now().UTC()
	if e.CreatedAt.IsZero() {
		e.CreatedAt = now
	}
	e.UpdatedAt = now

	tags := toJSON(e.Tags)
	keywords := toJSON(e.Keywords)

	_, err := s.db.Exec(
		`INSERT INTO entries (id, project, volume, content, tags, keywords, author, frame_type, active, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		e.ID, e.Project, e.Volume, e.Content, tags, keywords, e.Author, string(e.FrameType), e.CreatedAt, e.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert entry: %w", err)
	}

	return &e, nil
}

// AddEdge creates a typed edge between two entries.
// If the edge is a supersede, it marks the target entry as inactive.
func (s *Store) AddEdge(edge types.Edge) error {
	if edge.CreatedAt.IsZero() {
		edge.CreatedAt = time.Now().UTC()
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT INTO edges (source, source_project, target, target_project, type, reason, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		edge.Source, edge.SourceProject, edge.Target, edge.TargetProject, string(edge.Type), edge.Reason, edge.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert edge: %w", err)
	}

	// If supersede, mark target as inactive
	if edge.Type == types.EdgeSupersede {
		_, err = tx.Exec(`UPDATE entries SET active = 0 WHERE id = ? AND (project = ? OR project = '_default')`,
			edge.Target, edge.TargetProject)
		if err != nil {
			return fmt.Errorf("mark superseded: %w", err)
		}
	}

	return tx.Commit()
}

// GetEntry retrieves a single entry by ID and volume within a project.
func (s *Store) GetEntry(id, volume, project string) (*types.EntryWithEdges, error) {
	row := s.db.QueryRow(
		`SELECT id, project, volume, content, tags, keywords, author, frame_type, active, created_at, updated_at
		 FROM entries WHERE id = ? AND project = ? AND volume = ?`,
		id, project, volume,
	)

	e, err := scanEntry(row)
	if err != nil {
		return nil, err
	}

	outgoing, err := s.getEdgesBySource(e.ID, e.Project)
	if err != nil {
		return nil, err
	}

	incoming, err := s.getEdgesByTarget(e.ID, e.Project)
	if err != nil {
		return nil, err
	}

	return &types.EntryWithEdges{Entry: *e, Outgoing: outgoing, Incoming: incoming}, nil
}

// Downstream finds all entries that derive from the given entry (transitively).
func (s *Store) Downstream(id, project string) ([]string, error) {
	rows, err := s.db.Query(
		`WITH RECURSIVE downstream AS (
			SELECT source FROM edges WHERE target = ? AND source_project = ? AND type = 'derive_from'
			UNION
			SELECT e.source FROM edges e
			JOIN downstream d ON e.target = d.source
			WHERE e.source_project = ? AND e.type = 'derive_from'
		)
		SELECT source FROM downstream`,
		id, project, project,
	)
	if err != nil {
		return nil, fmt.Errorf("downstream query: %w", err)
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var target string
		if err := rows.Scan(&target); err != nil {
			return nil, err
		}
		result = append(result, target)
	}
	return result, rows.Err()
}

// PropagateSupersede finds all entries that become stale when the given entry is superseded.
func (s *Store) PropagateSupersede(id, project string) ([]string, error) {
	rows, err := s.db.Query(
		`WITH RECURSIVE affected AS (
			SELECT e.source FROM edges e
			WHERE e.target = ? AND e.source_project = ? AND e.type = 'derive_from'
			UNION
			SELECT ed.source FROM edges ed
			JOIN affected a ON ed.target = a.source
			WHERE ed.source_project = ? AND ed.type = 'derive_from'
		)
		SELECT source FROM affected`,
		id, project, project,
	)
	if err != nil {
		return nil, fmt.Errorf("propagate query: %w", err)
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var source string
		if err := rows.Scan(&source); err != nil {
			return nil, err
		}
		result = append(result, source)
	}
	return result, rows.Err()
}

// ActiveEntries returns all active entries matching the given filters.
func (s *Store) ActiveEntries(project, volume, tagFilter string) ([]types.Entry, error) {
	query := `SELECT id, project, volume, content, tags, keywords, author, frame_type, active, created_at, updated_at
			  FROM entries WHERE active = 1 AND project = ?`
	args := []interface{}{project}

	if volume != "" {
		query += ` AND volume = ?`
		args = append(args, volume)
	}
	if tagFilter != "" {
		query += ` AND tags LIKE ?`
		args = append(args, "%"+tagFilter+"%")
	}
	query += ` ORDER BY created_at DESC`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("active entries query: %w", err)
	}
	defer rows.Close()

	var result []types.Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *e)
	}
	return result, rows.Err()
}

// NextNonce returns and increments the next ID nonce for a volume within a project.
func (s *Store) NextNonce(project, volume string) (int, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var nonce int
	err = tx.QueryRow(
		`SELECT COALESCE(next_nonce, 1) FROM volume_meta WHERE project = ? AND volume = ?`,
		project, volume,
	).Scan(&nonce)
	if err == sql.ErrNoRows {
		nonce = 1
		_, err = tx.Exec(
			`INSERT INTO volume_meta (project, volume, next_nonce) VALUES (?, ?, 2)`,
			project, volume,
		)
	} else if err == nil {
		_, err = tx.Exec(
			`UPDATE volume_meta SET next_nonce = ? WHERE project = ? AND volume = ?`,
			nonce+1, project, volume,
		)
	}
	if err != nil {
		return 0, err
	}

	return nonce, tx.Commit()
}

// ── JSONL Bulk Sync ─────────────────────────────────────────────────────────

// SyncReport summarizes what happened during a sync.
type SyncReport struct {
	Project         string   `json:"project"`
	VolumesChecked  int      `json:"volumes_checked"`
	VolumesSynced   int      `json:"volumes_synced"`
	VolumesSkipped  int      `json:"volumes_skipped"`
	EntriesImported int      `json:"entries_imported"`
	EdgesImported   int      `json:"edges_imported"`
	SyncedVolumes   []string `json:"synced_volumes"`
	Duration        string   `json:"duration"`
}

func (r *SyncReport) Summary() string {
	if r.VolumesSynced == 0 {
		return fmt.Sprintf("all up to date (%d volumes checked)", r.VolumesChecked)
	}
	return fmt.Sprintf("%d/%d volumes synced, %d entries, %d edges imported",
		r.VolumesSynced, r.VolumesChecked, r.EntriesImported, r.EdgesImported)
}

// jsonlEntry mirrors the on-disk format.
type jsonlEntry struct {
	ID        string `json:"id"`
	Volume    string `json:"volume"`
	Content   string `json:"content"`
	Tags      []string `json:"tags"`
	Keywords  []string `json:"keywords"`
	Author    string `json:"author"`
	Created   string `json:"created"`
	Updated   string `json:"updated"`
	Refs      []struct {
		Target string `json:"target"`
		Reason string `json:"reason"`
		Source string `json:"source"`
	} `json:"refs,omitempty"`
	RefsRemoved []string `json:"refs_removed,omitempty"`
}

// SyncFromJSONL imports entries from JSONL files into SQLite.
// Only re-imports volumes whose JSONL mtime changed since last sync.
func (s *Store) SyncFromJSONL(project, stellarioDir string) (*SyncReport, error) {
	start := time.Now()
	report := &SyncReport{Project: project}

	files, err := filepath.Glob(filepath.Join(stellarioDir, "*.jsonl"))
	if err != nil {
		return report, fmt.Errorf("glob jsonl: %w", err)
	}

	// First pass: collect all stale volumes + their data
	type staleVolume struct {
		name    string
		path    string
		mtime   int64
		entries []types.Entry
		edges   []types.Edge
	}
	var staleVolumes []staleVolume

	for _, file := range files {
		base := filepath.Base(file)
		if base == "keywords-index.jsonl" || base == "intent-log.jsonl" || strings.Contains(base, ".track") {
			continue
		}

		info, err := os.Stat(file)
		if err != nil {
			continue
		}
		mtime := info.ModTime().UnixNano()
		volumeName := strings.TrimSuffix(base, ".jsonl")

		report.VolumesChecked++

		// Check if stale
		var storedMtime int64
		err = s.db.QueryRow(
			`SELECT COALESCE(jsonl_mtime, 0) FROM volume_meta WHERE project = ? AND volume = ?`,
			project, volumeName,
		).Scan(&storedMtime)
		if err == nil && storedMtime == mtime {
			report.VolumesSkipped++
			continue
		}

		entries, edges, err := readJSONLForSync(file, volumeName, project)
		if err != nil {
			return report, fmt.Errorf("read %s: %w", base, err)
		}

		staleVolumes = append(staleVolumes, staleVolume{
			name: volumeName, path: file, mtime: mtime,
			entries: entries, edges: edges,
		})
	}

	// Second pass: import all stale volumes in a single transaction.
	// Edges are scoped to this project — other projects' edges are untouched.
	if len(staleVolumes) > 0 {
		tx, err := s.db.Begin()
		if err != nil {
			return report, err
		}
		defer tx.Rollback()

		// Collect all entry IDs being imported (for edge scoping)
		importedIDs := make(map[string]bool)
		for _, sv := range staleVolumes {
			for _, e := range sv.entries {
				importedIDs[e.ID] = true
			}
		}

		// Delete stale entries for each volume
		for _, sv := range staleVolumes {
			_, err = tx.Exec(
				`DELETE FROM entries WHERE project = ? AND volume = ?`,
				project, sv.name,
			)
			if err != nil {
				return report, fmt.Errorf("delete old entries for %s: %w", sv.name, err)
			}
		}

		// Delete all edges for this project (re-import fresh)
		_, err = tx.Exec(`DELETE FROM edges WHERE source_project = ?`, project)
		if err != nil {
			return report, fmt.Errorf("delete old edges: %w", err)
		}

		// Insert all entries
		for _, sv := range staleVolumes {
			for _, e := range sv.entries {
				if e.FrameType == "" {
					e.FrameType = types.FrameAssert
				}
				_, err = tx.Exec(
					`INSERT OR REPLACE INTO entries (id, project, volume, content, tags, keywords, author, frame_type, active, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
					e.ID, e.Project, e.Volume, e.Content, toJSON(e.Tags), toJSON(e.Keywords),
					e.Author, string(e.FrameType), e.CreatedAt, e.UpdatedAt,
				)
				if err != nil {
					return report, fmt.Errorf("insert entry %s: %w", e.ID, err)
				}
			}
		}

		// Insert all edges
		totalEdges := 0
		for _, sv := range staleVolumes {
			for _, edge := range sv.edges {
				if edge.CreatedAt.IsZero() {
					edge.CreatedAt = time.Now().UTC()
				}
				_, err = tx.Exec(
					`INSERT INTO edges (source, source_project, target, target_project, type, reason, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					edge.Source, edge.SourceProject, edge.Target, edge.SourceProject, string(edge.Type), edge.Reason, edge.CreatedAt,
				)
				if err != nil {
					continue
				}
				totalEdges++

				if edge.Type == types.EdgeSupersede {
					_, _ = tx.Exec(`UPDATE entries SET active = 0 WHERE id = ? AND project = ?`, edge.Target, project)
				}
			}
		}

		// Update volume_meta for all synced volumes
		now := time.Now().UTC()
		for _, sv := range staleVolumes {
			// Preserve next_nonce — only update sync tracking fields
			_, err = tx.Exec(
				`INSERT INTO volume_meta (project, volume, next_nonce, last_synced, jsonl_mtime, jsonl_path)
				 VALUES (?, ?, 1, ?, ?, ?)
				 ON CONFLICT(project, volume) DO UPDATE SET last_synced = ?, jsonl_mtime = ?, jsonl_path = ?`,
				project, sv.name, now, sv.mtime, sv.path,
				now, sv.mtime, sv.path,
			)
			if err != nil {
				return report, fmt.Errorf("update volume_meta for %s: %w", sv.name, err)
			}

			report.VolumesSynced++
			report.EntriesImported += len(sv.entries)
			report.SyncedVolumes = append(report.SyncedVolumes, sv.name)
		}
		report.EdgesImported = totalEdges

		if err := tx.Commit(); err != nil {
			return report, fmt.Errorf("commit sync: %w", err)
		}
	}

	report.Duration = time.Since(start).Round(time.Millisecond).String()
	return report, nil
}

// readJSONLForSync reads a single JSONL file and returns entries + inferred edges.
func readJSONLForSync(path, volumeName, project string) ([]types.Entry, []types.Edge, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	var entries []types.Entry
	var edges []types.Edge

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var raw jsonlEntry
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}

		vol := raw.Volume
		if vol == "" {
			vol = volumeName
		}

		entry := types.Entry{
			ID:        raw.ID,
			Project:   project,
			Volume:    vol,
			Content:   raw.Content,
			Tags:      raw.Tags,
			Keywords:  raw.Keywords,
			Author:    raw.Author,
			FrameType: inferFrameTypeSync(raw.Tags),
			Active:    true,
			CreatedAt: parseDateSync(raw.Created),
			UpdatedAt: parseDateSync(raw.Updated),
		}
		entries = append(entries, entry)

		for _, ref := range raw.Refs {
			edgeType := types.EdgeRef
			reasonLower := strings.ToLower(ref.Reason)
			if strings.Contains(reasonLower, "supersed") || strings.Contains(reasonLower, "取代") || strings.Contains(reasonLower, "替代") {
				edgeType = types.EdgeSupersede
			} else if strings.Contains(reasonLower, "validat") || strings.Contains(reasonLower, "验证") {
				edgeType = types.EdgeValidates
			} else if strings.Contains(reasonLower, "deriv") || strings.Contains(reasonLower, "来源") || strings.Contains(reasonLower, "源自") || strings.Contains(reasonLower, "基于") {
				edgeType = types.EdgeDeriveFrom
			} else if strings.Contains(reasonLower, "constrain") || strings.Contains(reasonLower, "约束") {
				edgeType = types.EdgeConstrains
			}

			edges = append(edges, types.Edge{
				Source:        raw.ID,
				SourceProject: project,
				Target:        ref.Target,
				TargetProject: project,
				Type:          edgeType,
				Reason:        ref.Reason,
			})
		}
	}

	return entries, edges, scanner.Err()
}

// LoadGraph loads entries and edges from SQLite for a specific project.
func (s *Store) LoadGraph(project string) ([]types.Entry, []types.Edge, error) {
	rows, err := s.db.Query(
		`SELECT id, project, volume, content, tags, keywords, author, frame_type, active, created_at, updated_at
		 FROM entries WHERE project = ? ORDER BY created_at ASC`,
		project,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("load entries: %w", err)
	}

	var entries []types.Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			rows.Close()
			return nil, nil, err
		}
		entries = append(entries, *e)
	}
	rows.Close()

	edgeRows, err := s.db.Query(
		`SELECT source, source_project, target, target_project, type, reason, created_at
		 FROM edges WHERE source_project = ? ORDER BY created_at ASC`,
		project,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("load edges: %w", err)
	}

	var edges []types.Edge
	for edgeRows.Next() {
		var e types.Edge
		var edgeType string
		if err := edgeRows.Scan(&e.Source, &e.SourceProject, &e.Target, &e.TargetProject, &edgeType, &e.Reason, &e.CreatedAt); err != nil {
			edgeRows.Close()
			return nil, nil, err
		}
		e.Type = types.EdgeType(edgeType)
		edges = append(edges, e)
	}
	edgeRows.Close()

	return entries, edges, nil
}

// ── Intent Log Sync ────────────────────────────────────────────────────────────

type IntentLogEntry struct {
	Intent      string   `json:"intent"`
	Query       string   `json:"query"`
	Volumes     []string `json:"volumes"`
	Tags        []string `json:"tags"`
	ResultCount int      `json:"result_count"`
	CreatedAt   string   `json:"created_at"`
}

// SyncIntentLog imports new intent entries from intent-log.jsonl.
// Unlike entry sync, intent log is append-only — we only insert entries
// with timestamps newer than the latest in the DB.
func (s *Store) SyncIntentLog(project, stellarioDir string) (int, error) {
	intentLogPath := filepath.Join(stellarioDir, "intent-log.jsonl")
	if _, err := os.Stat(intentLogPath); os.IsNotExist(err) {
		return 0, nil // No intent log file
	}

	// Get latest timestamp in DB for this project
	var latestTimestamp string
	row := s.db.QueryRow(
		`SELECT COALESCE(MAX(created_at), '') FROM intent_log WHERE project = ?`,
		project,
	)
	if err := row.Scan(&latestTimestamp); err != nil {
		latestTimestamp = ""
	}

	f, err := os.Open(intentLogPath)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	var toInsert []IntentLogEntry
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var entry IntentLogEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}

		// Skip entries older than or equal to latest in DB
		if entry.CreatedAt <= latestTimestamp {
			continue
		}

		toInsert = append(toInsert, entry)
	}

	if len(toInsert) == 0 {
		return 0, scanner.Err()
	}

	// Insert all new entries
	for _, entry := range toInsert {
		_, err = s.db.Exec(
			`INSERT INTO intent_log (intent, query, volumes, tags, result_count, project, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			entry.Intent, entry.Query, toJSON(entry.Volumes), toJSON(entry.Tags),
			entry.ResultCount, project, entry.CreatedAt,
		)
		if err != nil {
			continue // Skip on error, don't fail the whole sync
		}
	}

	return len(toInsert), scanner.Err()
}

// ── Hint Translation Log ────────────────────────────────────────────────────────

type HintTranslation struct {
	ID         int64  `json:"id"`
	Hint       string `json:"hint"`
	Bid        string `json:"bid,omitempty"`
	Translated string `json:"translated"`
	Applied    bool   `json:"applied"`
	Feedback   string `json:"feedback,omitempty"`
	CreatedAt  string `json:"created_at"`
}

func (s *Store) LogHintTranslation(hint, bid, translated string, applied bool) (int64, error) {
	appliedInt := 0
	if applied {
		appliedInt = 1
	}
	res, err := s.db.Exec(
		`INSERT INTO hint_translations (hint, bid, translated, applied) VALUES (?, ?, ?, ?)`,
		hint, bid, translated, appliedInt,
	)
	if err != nil {
		return 0, fmt.Errorf("log hint translation: %w", err)
	}
	return res.LastInsertId()
}

func (s *Store) RecentHintTranslations(limit int) ([]HintTranslation, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := s.db.Query(
		`SELECT id, hint, bid, translated, applied, COALESCE(feedback, ''), created_at
		 FROM hint_translations ORDER BY created_at DESC LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []HintTranslation
	for rows.Next() {
		var t HintTranslation
		var appliedInt int
		if err := rows.Scan(&t.ID, &t.Hint, &t.Bid, &t.Translated, &appliedInt, &t.Feedback, &t.CreatedAt); err != nil {
			return nil, err
		}
		t.Applied = appliedInt == 1
		result = append(result, t)
	}
	return result, rows.Err()
}

func (s *Store) SetHintFeedback(id int64, feedback string) error {
	_, err := s.db.Exec(`UPDATE hint_translations SET feedback = ? WHERE id = ?`, feedback, id)
	return err
}

// ── Hint Corrections ────────────────────────────────────────────────────────

type HintCorrection struct {
	ID                  int64  `json:"id"`
	Hint                string `json:"hint"`
	BadTranslation      string `json:"bad_translation"`
	GoodTranslation     string `json:"good_translation"`
	Reason              string `json:"reason"`
	SourceTranslationID int64  `json:"source_translation_id,omitempty"`
	CreatedAt           string `json:"created_at"`
}

func (s *Store) AddHintCorrection(c HintCorrection) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO hint_corrections (hint, bad_translation, good_translation, reason, source_translation_id)
		 VALUES (?, ?, ?, ?, ?)`,
		c.Hint, c.BadTranslation, c.GoodTranslation, c.Reason, c.SourceTranslationID,
	)
	if err != nil {
		return 0, fmt.Errorf("add hint correction: %w", err)
	}
	return res.LastInsertId()
}

func (s *Store) AllHintCorrections() ([]HintCorrection, error) {
	rows, err := s.db.Query(
		`SELECT id, hint, bad_translation, good_translation, reason, COALESCE(source_translation_id, 0), created_at
		 FROM hint_corrections ORDER BY created_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []HintCorrection
	for rows.Next() {
		var c HintCorrection
		if err := rows.Scan(&c.ID, &c.Hint, &c.BadTranslation, &c.GoodTranslation, &c.Reason, &c.SourceTranslationID, &c.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

func (s *Store) UpdateHintCorrection(id int64, goodTranslation, reason string) error {
	_, err := s.db.Exec(
		`UPDATE hint_corrections SET good_translation = ?, reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		goodTranslation, reason, id,
	)
	return err
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type scanner interface {
	Scan(dest ...interface{}) error
}

func scanEntry(row scanner) (*types.Entry, error) {
	var e types.Entry
	var tagsJSON, keywordsJSON string
	var activeInt int

	err := row.Scan(
		&e.ID, &e.Project, &e.Volume, &e.Content, &tagsJSON, &keywordsJSON,
		&e.Author, &e.FrameType, &activeInt, &e.CreatedAt, &e.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	e.Tags = fromJSON(tagsJSON)
	e.Keywords = fromJSON(keywordsJSON)
	e.Active = activeInt == 1
	return &e, nil
}

func (s *Store) getEdgesBySource(id, project string) ([]types.Edge, error) {
	return s.queryEdges(
		`SELECT source, source_project, target, target_project, type, reason, created_at
		 FROM edges WHERE source = ? AND source_project = ? ORDER BY created_at`,
		id, project,
	)
}

func (s *Store) getEdgesByTarget(id, project string) ([]types.Edge, error) {
	return s.queryEdges(
		`SELECT source, source_project, target, target_project, type, reason, created_at
		 FROM edges WHERE target = ? AND target_project = ? ORDER BY created_at`,
		id, project,
	)
}

func (s *Store) queryEdges(query string, args ...interface{}) ([]types.Edge, error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var edges []types.Edge
	for rows.Next() {
		var e types.Edge
		var edgeType string
		if err := rows.Scan(&e.Source, &e.SourceProject, &e.Target, &e.TargetProject, &edgeType, &e.Reason, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Type = types.EdgeType(edgeType)
		edges = append(edges, e)
	}
	return edges, rows.Err()
}

// ── JSON helpers (proper escaping, not hand-rolled) ─────────────────────────

func toJSON(arr []string) string {
	b, err := json.Marshal(arr)
	if err != nil {
		return "[]"
	}
	return string(b)
}

func fromJSON(s string) []string {
	if s == "" || s == "[]" {
		return nil
	}
	var arr []string
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		return nil
	}
	return arr
}

// ── Frame inference ────────────────────────────────────────────────────────

func inferFrameTypeSync(tags []string) types.FrameType {
	for _, tag := range tags {
		switch tag {
		case "layer:foundation", "type:scope", "type:trust_assumption", "type:architecture":
			return types.FrameAssert
		case "layer:meta", "type:observation", "type:concern", "type:question":
			return types.FrameAssert
		case "layer:analysis", "type:hypothesis", "type:insight":
			return types.FrameDerive
		case "layer:findings", "type:issue":
			return types.FrameDerive
		case "layer:session", "type:checkpoint", "type:plan":
			return types.FrameCheckpoint
		}
	}
	return types.FrameAssert
}

func parseDateSync(s string) time.Time {
	if len(s) >= 10 {
		t, _ := time.Parse("2006-01-02", s[:10])
		return t
	}
	return time.Time{}
}
