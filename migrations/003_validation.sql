-- Add validation fields to articles
ALTER TABLE articles ADD COLUMN validation_status TEXT DEFAULT 'pending';
ALTER TABLE articles ADD COLUMN validation_errors TEXT;
ALTER TABLE articles ADD COLUMN validated_at TEXT;

-- Add source health tracking to sources
ALTER TABLE sources ADD COLUMN consecutive_failures INTEGER DEFAULT 0;
ALTER TABLE sources ADD COLUMN total_scrapes INTEGER DEFAULT 0;
ALTER TABLE sources ADD COLUMN total_failures INTEGER DEFAULT 0;

-- Validation log for audit trail
CREATE TABLE IF NOT EXISTS validation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER,
  check_name TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_articles_validation ON articles(validation_status);
CREATE INDEX IF NOT EXISTS idx_validation_log_article ON validation_log(article_id);
