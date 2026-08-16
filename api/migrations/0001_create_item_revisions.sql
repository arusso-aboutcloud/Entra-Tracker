-- Phase 3: revision store, write-path only. No read endpoints consume this
-- yet (Phase 4/5). One row per genuine change to a tracked item, not one
-- row per item per build -- see writeRevisions() in worker.js.

CREATE TABLE IF NOT EXISTS item_revisions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id             TEXT NOT NULL,
  observed_at         TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  title               TEXT,
  category            TEXT,
  status              TEXT,
  deadline            TEXT,
  deadline_confidence TEXT,
  announced_date      TEXT,
  service_category    TEXT,
  changed_fields      TEXT NOT NULL DEFAULT '[]'
);

-- Makes "latest revision for item_id" (the only read this phase performs, to
-- decide whether a new row is needed) cheap. Tiebreaks on `id` (the
-- autoincrement PK), not `observed_at`: two rows CAN share an observed_at
-- (verified live during Phase 3 development -- a retried write after a
-- dropped connection produced exactly this), and `id` is the only column
-- guaranteed unique and monotonically insertion-ordered.
CREATE INDEX IF NOT EXISTS idx_item_revisions_item_id_id
  ON item_revisions (item_id, id DESC);
