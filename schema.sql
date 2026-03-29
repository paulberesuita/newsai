-- Sources: where we scrape from
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  scrape_url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'rss', -- rss, html, api
  category TEXT, -- policy, visa, enforcement, courts, general
  active INTEGER NOT NULL DEFAULT 1,
  last_scraped TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  total_scrapes INTEGER DEFAULT 0,
  total_failures INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw articles before AI processing
CREATE TABLE IF NOT EXISTS raw_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  raw_content TEXT,
  author TEXT,
  published_at TEXT,
  scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

-- Published articles after AI rewriting
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_article_id INTEGER,
  source_id INTEGER NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  image_url TEXT,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  featured INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT DEFAULT 'pending',
  validation_errors TEXT,
  validated_at TEXT,
  FOREIGN KEY (raw_article_id) REFERENCES raw_articles(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

-- Scrape run log
CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  articles_found INTEGER DEFAULT 0,
  articles_processed INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
);

-- Email subscribers
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_articles_validation ON articles(validation_status);
CREATE INDEX IF NOT EXISTS idx_validation_log_article ON validation_log(article_id);

-- Seed immigration news sources
INSERT OR IGNORE INTO sources (name, url, scrape_url, type, category) VALUES
  ('USCIS News', 'https://www.uscis.gov', 'https://www.uscis.gov/news/all-news', 'html', 'policy'),
  ('CBP Newsroom', 'https://www.cbp.gov', 'https://www.cbp.gov/newsroom/national-media-release', 'html', 'enforcement'),
  ('State Dept Travel', 'https://travel.state.gov', 'https://travel.state.gov/content/travel/en/News/intercountry-adoption-news.html', 'html', 'visa'),
  ('DOJ Immigration', 'https://www.justice.gov', 'https://www.justice.gov/eoir/press-releases', 'html', 'courts'),
  ('Reuters Immigration', 'https://www.reuters.com', 'https://www.reuters.com/site-search/?query=immigration&section=United+States', 'html', 'general'),
  ('AP Immigration', 'https://apnews.com', 'https://apnews.com/hub/immigration', 'html', 'general'),
  ('Migration Policy Institute', 'https://www.migrationpolicy.org', 'https://www.migrationpolicy.org/news', 'html', 'policy'),
  ('AILA News', 'https://www.aila.org', 'https://www.aila.org/immigration-news', 'html', 'policy'),
  ('Immigration Impact', 'https://immigrationimpact.com', 'https://immigrationimpact.com', 'html', 'general'),
  ('Boundless News', 'https://www.boundless.com', 'https://www.boundless.com/blog/boundless-weekly-immigration-news/', 'html', 'general');
