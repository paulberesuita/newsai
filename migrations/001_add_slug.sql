-- Add slug column to articles
ALTER TABLE articles ADD COLUMN slug TEXT;

-- Create index for fast slug lookups
CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug);
