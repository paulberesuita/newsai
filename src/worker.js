export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // API routes
      if (path.startsWith('/api/')) {
        return handleAPI(path, request, env);
      }

      // Static assets are served by the [assets] config automatically
      // Worker only receives requests that don't match static files
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScraper(env));
  }
};

// ─── API ────────────────────────────────────────────────────────────────

async function handleAPI(path, request, env) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // GET /api/articles — latest published articles
  if (path === '/api/articles') {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const category = url.searchParams.get('category');

    let query = 'SELECT * FROM articles';
    const params = [];

    if (category && category !== 'all') {
      query += ' WHERE category = ?';
      params.push(category);
    }

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

  return new Response('{"error":"Not found"}', { status: 404, headers });
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
      try {
        const articles = await scrapeSource(source, env);
        totalFound += articles.length;

        for (const article of articles) {
          // Check for duplicates
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
              await env.DB.prepare(
                'INSERT INTO articles (raw_article_id, source_id, headline, summary, body, category, source_name, source_url, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
              ).bind(raw.id, source.id, processed.headline, processed.summary, processed.body, processed.category || source.category, source.name, article.url, processed.image_url || null).run();

              await env.DB.prepare('UPDATE raw_articles SET processed = 1 WHERE id = ?').bind(raw.id).run();
              totalProcessed++;
            }
          }
        }

        // Update last_scraped
        await env.DB.prepare("UPDATE sources SET last_scraped = datetime('now') WHERE id = ?").bind(source.id).run();
      } catch (e) {
        console.error(`Error scraping ${source.name}:`, e.message);
      }
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
