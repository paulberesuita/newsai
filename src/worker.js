export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // API routes
      if (path.startsWith('/api/')) {
        return handleAPI(path, request, env);
      }

      // Article detail pages (SSR for SEO)
      // Support both /article/slug-name and /article/123 (redirect old IDs to slug)
      const articleSlugMatch = path.match(/^\/article\/([a-z0-9-]+)$/);
      if (articleSlugMatch) {
        const param = articleSlugMatch[1];
        // If it's a pure number, look up by ID and redirect to slug
        if (/^\d+$/.test(param)) {
          const article = await env.DB.prepare('SELECT slug FROM articles WHERE id = ?').bind(param).first();
          if (article && article.slug) {
            return Response.redirect(new URL(`/article/${article.slug}`, request.url).toString(), 301);
          }
        }
        return handleArticlePage(param, env);
      }

      // Static assets are served by the [assets] config automatically
      // Worker only receives requests that don't match static files
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScraper(env));
    // Run audit once daily at midnight UTC
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (hour === 0) {
      ctx.waitUntil(runAudit(env));
    }
  }
};

// ─── API ────────────────────────────────────────────────────────────────

async function handleAPI(path, request, env) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // GET /api/articles — latest published articles
  if (path === '/api/articles') {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20') || 20, 1), 50);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0') || 0, 0);
    const category = url.searchParams.get('category');

    let query = 'SELECT id, slug, headline, summary, category, source_name, source_url, published_at FROM articles';
    const params = [];
    const conditions = ["validation_status IN ('passed', 'flagged')"];

    if (category && category !== 'all') {
      conditions.push('category = ?');
      params.push(category);
    }

    query += ' WHERE ' + conditions.join(' AND ');

    query += ' ORDER BY published_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await env.DB.prepare(query).bind(...params).all();
    return new Response(JSON.stringify(results), { headers });
  }

  // GET /api/article/:id
  if (path.match(/^\/api\/article\/\d+$/)) {
    const id = path.split('/').pop();
    const article = await env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
    if (!article) return new Response('{"error":"Not found"}', { status: 404, headers });
    return new Response(JSON.stringify(article), { headers });
  }

  // GET /api/sources
  if (path === '/api/sources') {
    const { results } = await env.DB.prepare('SELECT id, name, url, category, last_scraped FROM sources WHERE active = 1').all();
    return new Response(JSON.stringify(results), { headers });
  }

  // GET /api/stats
  if (path === '/api/stats') {
    const articles = await env.DB.prepare('SELECT COUNT(*) as count FROM articles').first();
    const sources = await env.DB.prepare('SELECT COUNT(*) as count FROM sources WHERE active = 1').first();
    const today = await env.DB.prepare("SELECT COUNT(*) as count FROM articles WHERE published_at >= datetime('now', '-24 hours')").first();
    return new Response(JSON.stringify({
      total_articles: articles.count,
      active_sources: sources.count,
      articles_today: today.count
    }), { headers });
  }

  // POST /api/scrape — manual trigger (optional ?source_id=N for single source)
  if (path === '/api/scrape' && request.method === 'POST') {
    const auth = request.headers.get('Authorization');
    if (!env.SCRAPE_KEY || auth !== `Bearer ${env.SCRAPE_KEY}`) {
      return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    }
    const url = new URL(request.url);
    const sourceId = url.searchParams.get('source_id');
    const result = await runScraper(env, sourceId ? parseInt(sourceId) : null);
    return new Response(JSON.stringify(result), { headers });
  }

  // POST /api/subscribe
  if (path === '/api/subscribe' && request.method === 'POST') {
    try {
      const { email, name } = await request.json();
      if (!email) return new Response('{"error":"Email required"}', { status: 400, headers });
      await env.DB.prepare('INSERT OR IGNORE INTO subscribers (email, name) VALUES (?, ?)').bind(email, name || null).run();
      return new Response('{"success":true}', { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // GET /api/validation/stats — validation summary
  if (path === '/api/validation/stats') {
    const total = await env.DB.prepare('SELECT COUNT(*) as count FROM articles').first();
    const passed = await env.DB.prepare("SELECT COUNT(*) as count FROM articles WHERE validation_status = 'passed'").first();
    const flagged = await env.DB.prepare("SELECT COUNT(*) as count FROM articles WHERE validation_status = 'flagged'").first();
    const failed = await env.DB.prepare("SELECT COUNT(*) as count FROM articles WHERE validation_status = 'failed'").first();
    const broken = await env.DB.prepare("SELECT COUNT(*) as count FROM articles WHERE validation_status = 'broken_link'").first();
    const stale = await env.DB.prepare("SELECT COUNT(*) as count FROM articles WHERE validation_status = 'stale'").first();
    const { results: sourceStats } = await env.DB.prepare(
      'SELECT name, total_scrapes, total_failures, CASE WHEN total_scrapes > 0 THEN ROUND(CAST(total_failures AS REAL) / total_scrapes, 4) ELSE 0 END as failure_rate FROM sources WHERE active = 1'
    ).all();
    return new Response(JSON.stringify({
      total: total.count,
      passed: passed.count,
      flagged: flagged.count,
      failed: failed.count,
      broken_link: broken.count,
      stale: stale.count,
      sources: sourceStats
    }), { headers });
  }

  // POST /api/audit — manually trigger audit
  if (path === '/api/audit' && request.method === 'POST') {
    const auth = request.headers.get('Authorization');
    if (!env.SCRAPE_KEY || auth !== `Bearer ${env.SCRAPE_KEY}`) {
      return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    }
    const result = await runAudit(env);
    return new Response(JSON.stringify(result), { headers });
  }

  return new Response('{"error":"Not found"}', { status: 404, headers });
}

// ─── ARTICLE PAGE (SSR) ────────────────────────────────────────────────

async function handleArticlePage(slug, env) {
  const article = await env.DB.prepare('SELECT * FROM articles WHERE slug = ?').bind(slug).first();

  if (!article) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/html' } });
  }

  const categoryLabels = {
    policy: 'Policy', visa: 'Visa & Green Card', enforcement: 'Enforcement',
    courts: 'Court Rulings', asylum: 'Asylum & Refugees', daca: 'DACA', general: 'Immigration'
  };
  const categoryLabel = categoryLabels[article.category] || 'Immigration';
  const publishedDate = article.published_at ? new Date(article.published_at + (article.published_at.includes('Z') ? '' : 'Z')).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const bodyHtml = renderMarkdownServer(article.body || '');
  const escapedHeadline = escapeHtmlServer(article.headline);
  const escapedSummary = escapeHtmlServer(article.summary);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedHeadline} — NewsAI</title>
  <meta name="description" content="${escapedSummary}">
  <meta property="og:title" content="${escapedHeadline}">
  <meta property="og:description" content="${escapedSummary}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="NewsAI">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapedHeadline}">
  <meta name="twitter:description" content="${escapedSummary}">
  <link rel="canonical" href="https://newsai.tinybuild.workers.dev/article/${article.slug}">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <svg class="grain" width="100%" height="100%">
    <filter id="grain-filter">
      <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#grain-filter)" opacity="0.08"/>
  </svg>

  <header class="masthead">
    <div class="masthead-top">
      <div class="masthead-left"></div>
      <div class="masthead-center">
        <h1 class="masthead-title"><a href="/" class="masthead-title-link">NewsAI</a></h1>
        <p class="masthead-tagline">Immigration News, Written by AI</p>
      </div>
      <div class="masthead-right"></div>
    </div>
    <div class="masthead-rule"></div>
    <nav class="nav">
      <a href="/" class="nav-link">Today's Edition</a>
      <a href="/newsroom" class="nav-link">Newsroom</a>
      <a href="/sources" class="nav-link">Sources</a>
    </nav>
    <div class="masthead-rule thin"></div>
  </header>

  <main class="article-page">
    <div class="article-category-label" data-cat="${article.category}">${categoryLabel}</div>
    <h1 class="article-headline">${escapedHeadline}</h1>
    <div class="article-meta">
      <span class="article-source">${escapeHtmlServer(article.source_name)}</span>
      <span class="article-date">${publishedDate}</span>
    </div>
    <div class="article-rule"></div>
    <div class="article-body">${bodyHtml}</div>
    <div class="article-rule"></div>
    <a class="article-source-link" href="${escapeHtmlServer(article.source_url)}" target="_blank" rel="noopener">Read the original source →</a>
  </main>

  <footer class="footer">
    <div class="footer-rule"></div>
    <p class="footer-text">NewsAI is an experiment in AI journalism. All articles are written by AI agents and should be verified against original sources.</p>
    <p class="footer-sub">Built by <a href="https://tinybuild.studio">TinyBuild Studio</a></p>
  </footer>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=3600' }
  });
}

function generateSlug(headline) {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

function escapeHtmlServer(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMarkdownServer(md) {
  if (!md) return '';
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hulo])(.+)$/gm, '<p>$1</p>')
    .replace(/<p><\/p>/g, '')
    .replace(/<p>(<[hulo])/g, '$1')
    .replace(/(<\/[hulo][^>]*>)<\/p>/g, '$1');
}

// ─── VALIDATION ────────────────────────────────────────────────────────

const VALID_CATEGORIES = ['policy', 'visa', 'enforcement', 'courts', 'asylum', 'daca', 'general'];

async function validateArticle(article, rawArticle, source, env) {
  const errors = [];
  const logs = [];

  // 1. Source URL reachability
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(rawArticle.url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'NewsAI/1.0 (Validation Check)' }
    });
    clearTimeout(timeout);
    if (resp.status >= 400) {
      errors.push(`Source URL returned ${resp.status}`);
      logs.push({ check: 'url_reachable', passed: 0, details: `HTTP ${resp.status}` });
    } else {
      logs.push({ check: 'url_reachable', passed: 1, details: `HTTP ${resp.status}` });
    }
  } catch (e) {
    // Don't hard-fail on timeout/network errors during scrape — URL may be temporarily down
    logs.push({ check: 'url_reachable', passed: 1, details: `Request failed: ${e.message} (soft pass)` });
  }

  // 2. Freshness
  if (rawArticle.published_at) {
    const pubDate = new Date(rawArticle.published_at);
    const now = new Date();
    const hoursOld = (now - pubDate) / (1000 * 60 * 60);
    if (hoursOld > 48) {
      errors.push(`Article is ${Math.round(hoursOld)} hours old (max 48)`);
      logs.push({ check: 'freshness', passed: 0, details: `${Math.round(hoursOld)} hours old` });
    } else {
      logs.push({ check: 'freshness', passed: 1, details: `${Math.round(hoursOld)} hours old` });
    }
  } else {
    logs.push({ check: 'freshness', passed: 1, details: 'No published_at date (warning)' });
  }

  // 3. Content quality
  const bodyLen = (article.body || '').length;
  const headlineLen = (article.headline || '').length;
  if (bodyLen < 200) {
    errors.push(`Body too short: ${bodyLen} chars (min 200)`);
    logs.push({ check: 'content_body_length', passed: 0, details: `${bodyLen} chars` });
  } else {
    logs.push({ check: 'content_body_length', passed: 1, details: `${bodyLen} chars` });
  }

  if (headlineLen < 20) {
    errors.push(`Headline too short: ${headlineLen} chars (min 20)`);
    logs.push({ check: 'content_headline_length', passed: 0, details: `${headlineLen} chars` });
  } else {
    logs.push({ check: 'content_headline_length', passed: 1, details: `${headlineLen} chars` });
  }

  if (article.headline && article.summary && article.summary.includes(article.headline)) {
    errors.push('Headline is a substring of summary');
    logs.push({ check: 'content_headline_unique', passed: 0, details: 'Headline is substring of summary' });
  } else {
    logs.push({ check: 'content_headline_unique', passed: 1, details: 'Headline differs from summary' });
  }

  const category = article.category || source.category;
  if (!VALID_CATEGORIES.includes(category)) {
    errors.push(`Invalid category: ${category}`);
    logs.push({ check: 'content_category', passed: 0, details: `Category: ${category}` });
  } else {
    logs.push({ check: 'content_category', passed: 1, details: `Category: ${category}` });
  }

  // 4. Duplicate detection
  try {
    const { results: recentArticles } = await env.DB.prepare(
      "SELECT id, headline FROM articles WHERE published_at >= datetime('now', '-7 days')"
    ).all();

    const newWords = new Set((article.headline || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let isDuplicate = false;
    let dupId = null;

    for (const existing of recentArticles) {
      const existingWords = new Set((existing.headline || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
      if (newWords.size === 0 || existingWords.size === 0) continue;
      const intersection = [...newWords].filter(w => existingWords.has(w));
      const union = new Set([...newWords, ...existingWords]);
      const overlap = intersection.length / union.size;
      if (overlap > 0.7) {
        isDuplicate = true;
        dupId = existing.id;
        break;
      }
    }

    if (isDuplicate) {
      errors.push(`Duplicate of article ${dupId} (>70% word overlap)`);
      logs.push({ check: 'duplicate', passed: 0, details: `Duplicate of article ${dupId}` });
    } else {
      logs.push({ check: 'duplicate', passed: 1, details: `Checked against ${recentArticles.length} recent articles` });
    }
  } catch (e) {
    logs.push({ check: 'duplicate', passed: 1, details: `Check failed: ${e.message} (soft pass)` });
  }

  // 5. Headline accuracy (AI check)
  let flagged = false;
  try {
    const aiResult = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a fact-checking assistant. Compare a rewritten headline against the original. Reply with exactly YES or NO followed by a brief reason.'
        },
        {
          role: 'user',
          content: `Original title: ${rawArticle.title}\nRewritten headline: ${article.headline}\n\nDoes the rewritten headline accurately represent the original? Reply YES or NO with a brief reason.`
        }
      ],
      max_tokens: 100
    });

    const answer = (aiResult.response || '').trim();
    const isAccurate = answer.toUpperCase().startsWith('YES');
    if (!isAccurate) {
      flagged = true;
      logs.push({ check: 'headline_accuracy', passed: 0, details: answer.substring(0, 200) });
    } else {
      logs.push({ check: 'headline_accuracy', passed: 1, details: answer.substring(0, 200) });
    }
  } catch (e) {
    logs.push({ check: 'headline_accuracy', passed: 1, details: `AI check failed: ${e.message} (soft pass)` });
  }

  const valid = errors.length === 0;
  return {
    valid,
    flagged,
    errors,
    logs
  };
}

async function checkSourceHealth(source, success, env) {
  try {
    if (success) {
      await env.DB.prepare(
        "UPDATE sources SET total_scrapes = total_scrapes + 1, consecutive_failures = 0 WHERE id = ?"
      ).bind(source.id).run();
    } else {
      await env.DB.prepare(
        "UPDATE sources SET total_scrapes = total_scrapes + 1, total_failures = total_failures + 1, consecutive_failures = consecutive_failures + 1 WHERE id = ?"
      ).bind(source.id).run();

      // Check if we should warn
      const updated = await env.DB.prepare('SELECT consecutive_failures FROM sources WHERE id = ?').bind(source.id).first();
      if (updated && updated.consecutive_failures >= 3) {
        console.warn(`Source ${source.name} (id=${source.id}) has ${updated.consecutive_failures} consecutive failures`);
      }
    }
  } catch (e) {
    console.error(`Failed to update source health for ${source.name}:`, e.message);
  }
}

async function logValidation(articleId, logs, env) {
  for (const log of logs) {
    try {
      await env.DB.prepare(
        'INSERT INTO validation_log (article_id, check_name, passed, details) VALUES (?, ?, ?, ?)'
      ).bind(articleId, log.check, log.passed ? 1 : 0, log.details || null).run();
    } catch (e) {
      console.error(`Failed to log validation check ${log.check}:`, e.message);
    }
  }
}

// ─── AUDIT ─────────────────────────────────────────────────────────────

async function runAudit(env) {
  const results = { broken_links: 0, stale: 0, deleted: 0, sources_disabled: 0 };

  try {
    // 1. Broken link check — articles from last 30 days, max 20
    const { results: recentArticles } = await env.DB.prepare(
      "SELECT id, source_url FROM articles WHERE published_at >= datetime('now', '-30 days') AND validation_status IN ('passed', 'flagged') ORDER BY published_at DESC LIMIT 20"
    ).all();

    for (const article of recentArticles) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(article.source_url, {
          method: 'HEAD',
          signal: controller.signal,
          headers: { 'User-Agent': 'NewsAI/1.0 (Link Audit)' }
        });
        clearTimeout(timeout);
        if (resp.status >= 400) {
          await env.DB.prepare(
            "UPDATE articles SET validation_status = 'broken_link', validated_at = datetime('now') WHERE id = ?"
          ).bind(article.id).run();
          results.broken_links++;
        }
      } catch (e) {
        // Network errors are not necessarily broken links, skip
      }
    }

    // 2. Stale cleanup
    // Delete articles older than 60 days
    const deleted = await env.DB.prepare(
      "DELETE FROM articles WHERE published_at < datetime('now', '-60 days')"
    ).run();
    results.deleted = deleted.meta.changes || 0;

    // Mark articles older than 30 days as stale
    const staled = await env.DB.prepare(
      "UPDATE articles SET validation_status = 'stale', validated_at = datetime('now') WHERE published_at < datetime('now', '-30 days') AND validation_status IN ('passed', 'flagged')"
    ).run();
    results.stale = staled.meta.changes || 0;

    // 3. Source health report
    const { results: sources } = await env.DB.prepare(
      'SELECT id, name, total_scrapes, total_failures FROM sources WHERE active = 1 AND total_scrapes > 0'
    ).all();

    for (const source of sources) {
      const failureRate = source.total_failures / source.total_scrapes;
      if (failureRate > 0.5) {
        await env.DB.prepare('UPDATE sources SET active = 0 WHERE id = ?').bind(source.id).run();
        console.warn(`Disabled source ${source.name} (id=${source.id}): failure rate ${(failureRate * 100).toFixed(1)}%`);
        results.sources_disabled++;
      }
    }
  } catch (e) {
    console.error('Audit error:', e.message);
    results.error = e.message;
  }

  console.log('Audit completed:', JSON.stringify(results));
  return results;
}

// ─── SCRAPER ────────────────────────────────────────────────────────────

async function runScraper(env, singleSourceId = null) {
  const run = await env.DB.prepare(
    "INSERT INTO scrape_runs (status) VALUES ('running') RETURNING id"
  ).first();
  const runId = run.id;

  let totalFound = 0;
  let totalProcessed = 0;

  try {
    // Get active sources
    let sourceQuery = 'SELECT * FROM sources WHERE active = 1';
    const sourceParams = [];
    if (singleSourceId) {
      sourceQuery += ' AND id = ?';
      sourceParams.push(singleSourceId);
    }
    const { results: sources } = await env.DB.prepare(sourceQuery).bind(...sourceParams).all();

    for (const source of sources) {
      let scrapeSuccess = false;
      try {
        const articles = await scrapeSource(source, env);
        totalFound += articles.length;
        scrapeSuccess = articles.length > 0;

        for (const article of articles) {
          // Check for duplicates in raw_articles
          const existing = await env.DB.prepare(
            'SELECT id FROM raw_articles WHERE url = ?'
          ).bind(article.url).first();

          if (!existing) {
            // Insert raw article
            const raw = await env.DB.prepare(
              'INSERT INTO raw_articles (source_id, title, url, raw_content, author, published_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
            ).bind(source.id, article.title, article.url, article.content, article.author || null, article.published_at || null).first();

            // Process with AI
            const processed = await processArticle(article, source, env);
            if (processed) {
              // Validate before publishing
              const validation = await validateArticle(processed, article, source, env);
              const slug = generateSlug(processed.headline);

              if (validation.valid) {
                // Determine status: flagged by AI headline check or passed
                const status = validation.flagged ? 'flagged' : 'passed';
                await env.DB.prepare(
                  'INSERT INTO articles (raw_article_id, source_id, headline, summary, body, category, source_name, source_url, image_url, slug, validation_status, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
                ).bind(raw.id, source.id, processed.headline, processed.summary, processed.body, processed.category || source.category, source.name, article.url, processed.image_url || null, slug, status).run();

                // Log validation checks
                const inserted = await env.DB.prepare('SELECT id FROM articles WHERE raw_article_id = ?').bind(raw.id).first();
                if (inserted) {
                  await logValidation(inserted.id, validation.logs, env);
                }

                await env.DB.prepare('UPDATE raw_articles SET processed = 1 WHERE id = ?').bind(raw.id).run();
                totalProcessed++;
              } else {
                // Validation failed — log but don't publish
                console.warn(`Article failed validation: ${processed.headline} — ${validation.errors.join(', ')}`);

                // Still insert with failed status for tracking
                await env.DB.prepare(
                  'INSERT INTO articles (raw_article_id, source_id, headline, summary, body, category, source_name, source_url, image_url, slug, validation_status, validation_errors, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'failed\', ?, datetime(\'now\'))'
                ).bind(raw.id, source.id, processed.headline, processed.summary, processed.body, processed.category || source.category, source.name, article.url, processed.image_url || null, slug, JSON.stringify(validation.errors)).run();

                const inserted = await env.DB.prepare('SELECT id FROM articles WHERE raw_article_id = ?').bind(raw.id).first();
                if (inserted) {
                  await logValidation(inserted.id, validation.logs, env);
                }

                await env.DB.prepare('UPDATE raw_articles SET processed = 1 WHERE id = ?').bind(raw.id).run();
              }
            }
          }
        }

        // Update last_scraped
        await env.DB.prepare("UPDATE sources SET last_scraped = datetime('now') WHERE id = ?").bind(source.id).run();
      } catch (e) {
        console.error(`Error scraping ${source.name}:`, e.message);
      }

      // Track source health
      await checkSourceHealth(source, scrapeSuccess, env);
    }

    await env.DB.prepare(
      "UPDATE scrape_runs SET completed_at = datetime('now'), articles_found = ?, articles_processed = ?, status = 'completed' WHERE id = ?"
    ).bind(totalFound, totalProcessed, runId).run();

    return { success: true, found: totalFound, processed: totalProcessed };
  } catch (e) {
    await env.DB.prepare(
      "UPDATE scrape_runs SET completed_at = datetime('now'), status = 'failed' WHERE id = ?"
    ).bind(runId).run();
    return { success: false, error: e.message };
  }
}

async function scrapeSource(source, env) {
  const articles = [];

  try {
    const response = await fetch(source.scrape_url, {
      headers: {
        'User-Agent': 'NewsAI/1.0 (Immigration News Aggregator)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      console.error(`Failed to fetch ${source.name}: ${response.status}`);
      return articles;
    }

    const html = await response.text();

    // Use Workers AI to extract articles from the page
    const extraction = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        {
          role: 'system',
          content: `You are a news article extractor. Given HTML content from a news page, extract article listings. Return a JSON array of objects with these fields: title, url (absolute URL), published_at (ISO date if found), author (if found), content (brief excerpt or description if available). Only return immigration-related articles. Return ONLY valid JSON, no other text. If no articles found, return [].`
        },
        {
          role: 'user',
          content: `Extract immigration news articles from this page. The source base URL is ${source.url}. Make all URLs absolute.\n\nHTML (first 8000 chars):\n${html.substring(0, 8000)}`
        }
      ],
      max_tokens: 2000
    });

    try {
      const text = extraction.response.trim();
      // Find JSON array in response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        articles.push(...parsed.slice(0, 10)); // Max 10 per source
      }
    } catch (e) {
      console.error(`Failed to parse AI extraction for ${source.name}:`, e.message);
    }
  } catch (e) {
    console.error(`Scrape error for ${source.name}:`, e.message);
  }

  return articles;
}

async function processArticle(article, source, env) {
  try {
    const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        {
          role: 'system',
          content: `You are an immigration news editor. Your job is to take raw news content and produce a clear, informative article for immigrants and immigration professionals.

Your editorial voice:
- Authoritative but accessible — explain what matters and why
- Always include "What this means" — practical implications for real people
- No sensationalism — immigrants rely on accurate information
- Clear, direct sentences — your readers may not be native English speakers
- Include relevant context — reference related policies, timelines, or history when helpful

Return a JSON object with these fields:
- headline: Clear, informative headline (max 100 chars). Lead with what changed or what's new.
- summary: 2-3 sentence summary of the key facts and impact (max 300 chars)
- body: Full article in markdown (300-600 words). Structure: key facts → context → what this means for affected groups → what to do next (if applicable)
- category: One of: policy, visa, enforcement, courts, asylum, daca, general
- image_url: null (we don't generate images)

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Rewrite this immigration news article:\n\nTitle: ${article.title}\nSource: ${source.name}\nContent: ${(article.content || article.title).substring(0, 3000)}`
        }
      ],
      max_tokens: 1500
    });

    const text = result.response.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error(`AI processing error:`, e.message);
  }
  return null;
}
