package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// HFPick is one Hugging Face download the user started: what to fetch, pinned at a revision.
type HFPick struct {
	ID       string // "hf:<owner>/<repo>:<quant>"
	Repo     string // "owner/repo"
	Revision string // 40-hex commit sha
	Quant    string
	Files    []HFPickFile
	Created  time.Time
}

// HFPickFile is one file of a pick.
type HFPickFile struct {
	Name      string `json:"name"` // base name on disk
	Path      string `json:"path"` // path inside the repo
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

// HFPicks lists every pick, oldest first (then by id). A row whose files don't decode is skipped: the caller
// validates the rest.
func (s *Store) HFPicks(ctx context.Context) ([]HFPick, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT id, repo, revision, quant, files, created FROM hf_picks ORDER BY created, id`)
	if err != nil {
		return nil, fmt.Errorf("hf picks: %w", err)
	}
	defer rows.Close()
	var picks []HFPick
	for rows.Next() {
		var p HFPick
		var files string
		var created int64
		if err := rows.Scan(&p.ID, &p.Repo, &p.Revision, &p.Quant, &files, &created); err != nil {
			return nil, fmt.Errorf("hf picks: %w", err)
		}
		if json.Unmarshal([]byte(files), &p.Files) != nil {
			continue
		}
		p.Created = time.UnixMilli(created)
		picks = append(picks, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("hf picks: %w", err)
	}
	return picks, nil
}

// SaveHFPick inserts p, or replaces the row with its id.
func (s *Store) SaveHFPick(ctx context.Context, p HFPick) error {
	if s.readOnly != nil {
		return ErrReadOnly
	}
	files, err := json.Marshal(p.Files)
	if err != nil {
		return fmt.Errorf("save hf pick: %w", err)
	}
	_, err = s.writer().ExecContext(ctx, `INSERT INTO hf_picks (id, repo, revision, quant, files, created)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET repo = excluded.repo, revision = excluded.revision, quant = excluded.quant,
		files = excluded.files, created = excluded.created`,
		p.ID, p.Repo, p.Revision, p.Quant, string(files), p.Created.UnixMilli())
	if err != nil {
		return fmt.Errorf("save hf pick: %w", err)
	}
	return nil
}

// DeleteHFPick removes the row; no row is not an error.
func (s *Store) DeleteHFPick(ctx context.Context, id string) error {
	if s.readOnly != nil {
		return ErrReadOnly
	}
	if _, err := s.writer().ExecContext(ctx, `DELETE FROM hf_picks WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete hf pick: %w", err)
	}
	return nil
}
