package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"stellario/engine/types"
)

// Store wraps a SQLite database for memory entries and graph edges.
type Store struct {
	db *sql.DB
}

// Open opens or creates a SQLite database at the given path.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite3", path+"?_journal_mode=WAL&_foreign_keys=on")
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
		volume     TEXT NOT NULL,
		content    TEXT NOT NULL,
		tags       TEXT NOT NULL DEFAULT '[]',
		keywords   TEXT NOT NULL DEFAULT '[]',
		author     TEXT NOT NULL DEFAULT '',
		frame_type TEXT NOT NULL DEFAULT 'assert',
		active     INTEGER NOT NULL DEFAULT 1,
		created_at TIMESTAMP NOT NULL,
		updated_at TIMESTAMP NOT NULL,
		PRIMARY KEY (id, volume)
	);

	CREATE INDEX IF NOT EXISTS idx_entries_volume ON entries(volume);
	CREATE INDEX IF NOT EXISTS idx_entries_active ON entries(active);
	CREATE INDEX IF NOT EXISTS idx_entries_tags ON entries(tags);

	CREATE TABLE IF NOT EXISTS edges (
		source     TEXT NOT NULL,
		target     TEXT NOT NULL,
		type       TEXT NOT NULL,
		reason     TEXT NOT NULL DEFAULT '',
		created_at TIMESTAMP NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source, type);
	CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target, type);

	CREATE TABLE IF NOT EXISTS entry_history (
		id         TEXT NOT NULL,
		volume     TEXT NOT NULL,
		version    INTEGER NOT NULL,
		content    TEXT NOT NULL,
		tags       TEXT NOT NULL DEFAULT '[]',
		keywords   TEXT NOT NULL DEFAULT '[]',
		frame_type TEXT NOT NULL DEFAULT 'assert',
		revised_at TIMESTAMP NOT NULL,
		message    TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (id, volume, version)
	);

	CREATE TABLE IF NOT EXISTS volume_meta (
		volume     TEXT PRIMARY KEY,
		next_nonce INTEGER NOT NULL DEFAULT 1
	);
	`
	_, err := s.db.Exec(schema)
	return err
}

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
		`INSERT INTO entries (id, volume, content, tags, keywords, author, frame_type, active, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		e.ID, e.Volume, e.Content, tags, keywords, e.Author, string(e.FrameType), e.CreatedAt, e.UpdatedAt,
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
		`INSERT INTO edges (source, target, type, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
		edge.Source, edge.Target, string(edge.Type), edge.Reason, edge.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert edge: %w", err)
	}

	// If supersede, mark target as inactive
	if edge.Type == types.EdgeSupersede {
		_, err = tx.Exec(`UPDATE entries SET active = 0 WHERE id = ?`, edge.Target)
		if err != nil {
			return fmt.Errorf("mark superseded: %w", err)
		}
	}

	return tx.Commit()
}

// GetEntry retrieves a single entry by ID and volume.
func (s *Store) GetEntry(id, volume string) (*types.EntryWithEdges, error) {
	row := s.db.QueryRow(
		`SELECT id, volume, content, tags, keywords, author, frame_type, active, created_at, updated_at
		 FROM entries WHERE id = ? AND volume = ?`,
		id, volume,
	)

	e, err := scanEntry(row)
	if err != nil {
		return nil, err
	}

	outgoing, err := s.getEdgesBySource(e.ID)
	if err != nil {
		return nil, err
	}

	incoming, err := s.getEdgesByTarget(e.ID)
	if err != nil {
		return nil, err
	}

	return &types.EntryWithEdges{Entry: *e, Outgoing: outgoing, Incoming: incoming}, nil
}

// Downstream finds all entries that derive from the given entry (transitively).
// An entry B is "downstream of A" if B has a derive_from edge pointing to A.
// Uses recursive CTE for graph traversal.
func (s *Store) Downstream(id string) ([]string, error) {
	rows, err := s.db.Query(
		`WITH RECURSIVE downstream AS (
			SELECT source FROM edges WHERE target = ? AND type = 'derive_from'
			UNION
			SELECT e.source FROM edges e
			JOIN downstream d ON e.target = d.source
			WHERE e.type = 'derive_from'
		)
		SELECT source FROM downstream`,
		id,
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
// An entry is stale if any entry it derives_from has been superseded (active = 0).
func (s *Store) PropagateSupersede(id string) ([]string, error) {
	rows, err := s.db.Query(
		`WITH RECURSIVE affected AS (
			SELECT e.source FROM edges e
			WHERE e.target = ? AND e.type = 'derive_from'
			UNION
			SELECT ed.source FROM edges ed
			JOIN affected a ON ed.target = a.source
			WHERE ed.type = 'derive_from'
		)
		SELECT source FROM affected`,
		id,
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

// ActiveEntries returns all active entries matching the given tag filter.
func (s *Store) ActiveEntries(volume string, tagFilter string) ([]types.Entry, error) {
	query := `SELECT id, volume, content, tags, keywords, author, frame_type, active, created_at, updated_at
			  FROM entries WHERE active = 1`
	args := []interface{}{}

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

// NextNonce returns and increments the next ID nonce for a volume.
func (s *Store) NextNonce(volume string) (int, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var nonce int
	err = tx.QueryRow(`SELECT COALESCE(next_nonce, 1) FROM volume_meta WHERE volume = ?`, volume).Scan(&nonce)
	if err == sql.ErrNoRows {
		nonce = 1
		_, err = tx.Exec(`INSERT INTO volume_meta (volume, next_nonce) VALUES (?, 2)`, volume)
	} else if err == nil {
		_, err = tx.Exec(`UPDATE volume_meta SET next_nonce = ? WHERE volume = ?`, nonce+1, volume)
	}
	if err != nil {
		return 0, err
	}

	return nonce, tx.Commit()
}

// --- Helpers ---

type scanner interface {
	Scan(dest ...interface{}) error
}

func scanEntry(row scanner) (*types.Entry, error) {
	var e types.Entry
	var tagsJSON, keywordsJSON string
	var activeInt int

	err := row.Scan(
		&e.ID, &e.Volume, &e.Content, &tagsJSON, &keywordsJSON,
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

func (s *Store) getEdgesBySource(id string) ([]types.Edge, error) {
	return s.queryEdges(`SELECT source, target, type, reason, created_at FROM edges WHERE source = ? ORDER BY created_at`, id)
}

func (s *Store) getEdgesByTarget(id string) ([]types.Edge, error) {
	return s.queryEdges(`SELECT source, target, type, reason, created_at FROM edges WHERE target = ? ORDER BY created_at`, id)
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
		if err := rows.Scan(&e.Source, &e.Target, &e.Type, &e.Reason, &e.CreatedAt); err != nil {
			return nil, err
		}
		edges = append(edges, e)
	}
	return edges, rows.Err()
}

func toJSON(arr []string) string {
	if len(arr) == 0 {
		return "[]"
	}
	result := "["
	for i, s := range arr {
		if i > 0 {
			result += ","
		}
		result += `"` + s + `"`
	}
	return result + "]"
}

func fromJSON(s string) []string {
	if s == "" || s == "[]" {
		return nil
	}
	// Simple parser for JSON string arrays
	var result []string
	inStr := false
	current := ""
	for _, c := range s {
		if c == '"' {
			if inStr {
				result = append(result, current)
				current = ""
			}
			inStr = !inStr
		} else if inStr {
			current += string(c)
		}
	}
	return result
}
