import { ORIGIN, esc, fechaLarga, portadaPage, edicionesPage, sitemapXml, notFoundPage, edicionMarkdown, llmsTxt, noticiaPage, noticiaMarkdown, noticiaPath } from './pages.js';
import { handleMCP } from './mcp.js';
import { getFechas, getFecha, insertFechas, getProximas, calendarioPage, fechaPage, calendarioIcs, calendarioMarkdown, fechasEmailHtml, fechaPath } from './fechas.js';
import { getHerramientas, getHerramienta, upsertHerramienta, herramientasPage, herramientaPage, herramientaMarkdown, herramientasMarkdown, herramientaPath } from './herramientas.js';

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// iCalendar: text/calendar so phones offer "add to calendar"; the feed itself
// is what webcal:// subscribes to.
const icsResponse = (body, filename = 'diario-migrante-calendario.ics') => new Response(body, {
  headers: {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `inline; filename="${filename}"`,
    'Cache-Control': 'public, max-age=1800'
  }
});

const htmlResponse = (body, status = 200, maxAge = 300) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=${maxAge}` }
});

// The markdown twins are for agents, not search: noindex, and each one names
// its HTML canonical so Google never files them as duplicates.
const mdResponse = (body, canonical, maxAge = 900) => new Response(body, {
  headers: {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': `public, max-age=${maxAge}`,
    'X-Robots-Tag': 'noindex',
    'Link': `<${canonical}>; rel="canonical"`
  }
});

export default {
  // The daily send: 8:30 AM ET first pass, with a 10 AM ET sweep in case the
  // 7 AM routine ran late. The edition_sends guard makes the retry free.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendEditionToSubscribers(env).then(r => console.log('edition send:', JSON.stringify(r))));
  },

  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (url.hostname === 'www.diariomigrante.com' || url.protocol === 'http:') {
        return Response.redirect(`${ORIGIN}${path}${url.search}`, 301);
      }

      // MCP — the paper as a tool for agents (src/mcp.js)
      if (path === '/mcp') {
        return handleMCP(request, env, { getPortadaData, getEditions, subscribeEmail, getNoticia });
      }

      // API routes
      if (path.startsWith('/api/')) {
        return handleAPI(path, request, env);
      }

      // Today's front-page photo at a stable URL (for social share previews)
      if (path === '/portada.jpg') {
        const a = await env.DB.prepare(
          "SELECT image_url FROM articles WHERE image_url IS NOT NULL ORDER BY published_at DESC LIMIT 1"
        ).first();
        if (!a?.image_url?.startsWith('/img/')) return new Response('Not found', { status: 404 });
        const obj = await env.BUCKET.get(a.image_url.slice(1));
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }

      // Generated article art, stored in R2
      if (path.startsWith('/img/')) {
        const obj = await env.BUCKET.get(path.slice(1));
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
        });
      }

      // ─── Server-rendered pages (the stories live in the HTML so search
      // engines actually read the paper) ───────────────────────────────

      // Legacy dated-portada links → the permanent edition page
      if (path === '/' && url.searchParams.get('date')) {
        return Response.redirect(`${ORIGIN}/edicion/${url.searchParams.get('date')}`, 301);
      }

      if (path === '/') {
        const data = await getPortadaData(env, null);
        const { prev } = data.empty ? { prev: null } : await getEditionNeighbors(env, data.date);
        return htmlResponse(portadaPage(data, { home: true, prev }));
      }

      // ─── Agent surface: markdown editions + llms.txt ─────────────────

      const edicionMd = path.match(/^\/edicion\/(\d{4}-\d{2}-\d{2})\.md$/);
      if (edicionMd || path === '/portada.md') {
        const data = await getPortadaData(env, edicionMd ? edicionMd[1] : null);
        if (!data || data.empty || !data.featured?.length) {
          return new Response('No existe esa edición. El índice: https://diariomigrante.com/api/editions\n', {
            status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
        return mdResponse(edicionMarkdown(data), edicionMd ? `${ORIGIN}/edicion/${edicionMd[1]}` : `${ORIGIN}/`);
      }

      // ─── Each story on its own sheet: /noticia/:id/:slug (+ .md twin) ──

      const noticiaMd = path.match(/^\/noticia\/(\d+)(?:\/[^/]*)?\.md$/);
      if (noticiaMd) {
        const a = await getNoticia(env, noticiaMd[1]);
        if (!a) return new Response('No existe esa noticia.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        return mdResponse(noticiaMarkdown(a), `${ORIGIN}${noticiaPath(a)}`);
      }

      const noticia = path.match(/^\/noticia\/(\d+)(?:\/([^/]*))?\/?$/);
      if (noticia) {
        const a = await getNoticia(env, noticia[1]);
        if (!a) return htmlResponse(notFoundPage(), 404);
        const canon = noticiaPath(a);
        if (path !== canon) return Response.redirect(`${ORIGIN}${canon}`, 301);
        const day = a.published_at.slice(0, 10);
        const { results: others } = await env.DB.prepare(
          'SELECT id, headline, headline_es, source_name FROM articles WHERE date(published_at) = ? AND id != ? ORDER BY published_at DESC'
        ).bind(day, a.id).all();
        return htmlResponse(noticiaPage(a, { others }), 200, 3600);
      }

      // ─── El calendario (src/fechas.js) ──────────────────────────────

      if (path === '/calendario' || path === '/calendario/') {
        if (path.endsWith('/')) return Response.redirect(`${ORIGIN}/calendario`, 301);
        return htmlResponse(calendarioPage(await getFechas(env, { desde: daysAgo(120) })), 200, 900);
      }
      if (path === '/calendario.md') {
        return mdResponse(calendarioMarkdown(await getFechas(env, { desde: daysAgo(120) })), `${ORIGIN}/calendario`);
      }
      if (path === '/calendario.ics') {
        return icsResponse(calendarioIcs(await getFechas(env, { desde: daysAgo(60) })));
      }
      const fechaIcs = path.match(/^\/calendario\/(\d+)(?:\/[^/]*)?\.ics$/);
      if (fechaIcs) {
        const f = await getFecha(env, fechaIcs[1]);
        if (!f) return new Response('No existe esa fecha.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        return icsResponse(calendarioIcs([f], { nombre: f.title }), `diario-migrante-${f.id}.ics`);
      }
      const fecha = path.match(/^\/calendario\/(\d+)(?:\/([^/]*))?\/?$/);
      if (fecha) {
        const f = await getFecha(env, fecha[1]);
        if (!f) return htmlResponse(notFoundPage(), 404);
        const canon = fechaPath(f);
        if (path !== canon) return Response.redirect(`${ORIGIN}${canon}`, 301);
        const mes = f.day.slice(0, 7);
        const mismasMes = await getFechas(env, { desde: `${mes}-01`, hasta: `${mes}-31` });
        return htmlResponse(fechaPage(f, { mismasMes }), 200, 1800);
      }

      // ─── Las herramientas (src/herramientas.js) ─────────────────────

      if (path === '/herramientas' || path === '/herramientas/') {
        if (path.endsWith('/')) return Response.redirect(`${ORIGIN}/herramientas`, 301);
        return htmlResponse(herramientasPage(await getHerramientas(env)), 200, 900);
      }
      if (path === '/herramientas.md') {
        return mdResponse(herramientasMarkdown(await getHerramientas(env)), `${ORIGIN}/herramientas`);
      }
      const herrMd = path.match(/^\/herramientas\/([a-z0-9-]+)\.md$/);
      if (herrMd) {
        const h = await getHerramienta(env, herrMd[1]);
        if (!h) return new Response('No existe esa herramienta.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        return mdResponse(herramientaMarkdown(h), `${ORIGIN}${herramientaPath(h)}`);
      }
      const herr = path.match(/^\/herramientas\/([a-z0-9-]+)(\/?)$/);
      if (herr) {
        if (herr[2]) return Response.redirect(`${ORIGIN}/herramientas/${herr[1]}`, 301);
        const h = await getHerramienta(env, herr[1]);
        if (!h) return htmlResponse(notFoundPage(), 404);
        return htmlResponse(herramientaPage(h, { otras: await getHerramientas(env) }), 200, 1800);
      }

      if (path === '/llms.txt') {
        return new Response(llmsTxt(await getEditions(env)), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
        });
      }

      const edicion = path.match(/^\/edicion\/(\d{4}-\d{2}-\d{2})(\/?)$/);
      if (edicion) {
        if (edicion[2]) return Response.redirect(`${ORIGIN}/edicion/${edicion[1]}`, 301);
        const data = await getPortadaData(env, edicion[1]);
        if (!data || data.empty || !data.featured?.length) return htmlResponse(notFoundPage(), 404);
        const { prev, next } = await getEditionNeighbors(env, data.date);
        return htmlResponse(portadaPage(data, { home: false, prev, next }), 200, 3600);
      }

      if (path === '/ediciones' || path === '/ediciones/') {
        if (path.endsWith('/')) return Response.redirect(`${ORIGIN}/ediciones`, 301);
        return htmlResponse(edicionesPage(await getEditions(env)));
      }

      if (path === '/sitemap.xml') {
        const { results: arts } = await env.DB.prepare(
          'SELECT id, headline, headline_es, date(published_at) AS day FROM articles ORDER BY published_at DESC'
        ).all();
        const { results: fechas } = await env.DB.prepare(
          "SELECT id, title, updated_at FROM fechas WHERE status != 'cancelada' ORDER BY day DESC"
        ).all();
        return new Response(sitemapXml(await getEditions(env), arts, fechas, await getHerramientas(env)), {
          headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
        });
      }

      // Everything else (style.css, app.js, /registro, robots.txt…) is a
      // static asset — run_worker_first hands us the request, we hand it on.
      return env.ASSETS.fetch(request);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// ─── The tiny-events hub ───────────────────────────────────────────────
// Studio-wide event collector; events land in the #tiny-events Slack channel
// as they happen and in Paul's end-of-day digest. Fire-and-forget — a hub
// outage never breaks the paper.

const EVENTS_URL = 'https://tiny-events.tinybuild.workers.dev/api/event';

async function postEvent(env, { type, title, body, url }) {
  if (!env.EVENTS_TOKEN) return;
  try {
    await fetch(EVENTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EVENTS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: 'diariomigrante', type, title, body, url }),
    });
  } catch (e) {
    console.error('event post failed:', e);
  }
}

// ─── API ────────────────────────────────────────────────────────────────

function checkAuth(request, env) {
  const key = request.headers.get('X-API-Key');
  if (!key) return false;
  // SCRAPE_KEY is the daily routine's credential; ADMIN_KEY is the local ops
  // credential (stored in the Mac's Keychain as `diariomigrante-admin`).
  return (!!env.SCRAPE_KEY && key === env.SCRAPE_KEY) || (!!env.ADMIN_KEY && key === env.ADMIN_KEY);
}

async function handleAPI(path, request, env) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // GET /api/articles — latest published articles (optional ?date=YYYY-MM-DD for one edition)
  if (path === '/api/articles') {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const category = url.searchParams.get('category');
    const date = url.searchParams.get('date');

    const clauses = [];
    const params = [];

    if (category && category !== 'all') {
      clauses.push('category = ?');
      params.push(category);
    }
    if (date) {
      clauses.push('date(published_at) = ?');
      params.push(date);
    }

    let query = 'SELECT * FROM articles';
    if (clauses.length) query += ' WHERE ' + clauses.join(' AND ');
    query += ' ORDER BY published_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await env.DB.prepare(query).bind(...params).all();
    return new Response(JSON.stringify(results), { headers });
  }

  // GET /api/portada — one edition in the D1 design's shape: the five that matter + the rest.
  if (path === '/api/portada') {
    const data = await getPortadaData(env, new URL(request.url).searchParams.get('date'));
    return new Response(JSON.stringify(data), { headers });
  }

  // GET /api/editions — one row per day that has articles, newest first.
  if (path === '/api/editions') {
    return new Response(JSON.stringify(await getEditions(env)), { headers });
  }

  // GET /api/article/:id
  if (path.match(/^\/api\/article\/\d+$/)) {
    const id = path.split('/').pop();
    const article = await env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
    if (!article) return new Response('{"error":"Not found"}', { status: 404, headers });
    return new Response(JSON.stringify(article), { headers });
  }

  // GET /api/fechas — the calendar as JSON (?desde=&hasta=, defaults: last 30 days onward)
  if (path === '/api/fechas' && request.method === 'GET') {
    const u = new URL(request.url);
    const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
    const desde = ok(u.searchParams.get('desde')) || daysAgo(30);
    const hasta = ok(u.searchParams.get('hasta'));
    const rows = await getFechas(env, { desde, hasta });
    return new Response(JSON.stringify(rows.map(f => ({
      id: f.id, day: f.day, title: f.title, detail: f.detail, kind: f.kind, country: f.country, status: f.status,
      article_id: f.article_id, source_name: f.source_name, source_url: f.source_url,
      url: `${ORIGIN}${fechaPath(f)}`, ics: `${ORIGIN}/calendario/${f.id}.ics`
    }))), { headers });
  }

  // POST /api/fechas — add dates {fechas:[{day,title,detail,kind,country,article_id,source_name,source_url}]}
  if (path === '/api/fechas' && request.method === 'POST') {
    if (!checkAuth(request, env)) return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    try {
      const body = await request.json();
      const items = Array.isArray(body.fechas) ? body.fechas : [];
      const r = await insertFechas(items, env);
      return new Response(JSON.stringify({ success: true, received: items.length, ...r }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // POST /api/fechas/:id — correct a date (any of day, title, detail, kind, country, status)
  const fechaEdit = path.match(/^\/api\/fechas\/(\d+)$/);
  if (fechaEdit && request.method === 'POST') {
    if (!checkAuth(request, env)) return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    const body = await request.json().catch(() => ({}));
    const sets = [];
    const binds = [];
    for (const k of ['day', 'title', 'detail', 'kind', 'country', 'status', 'source_name', 'source_url', 'article_id']) {
      if (body[k] !== undefined) { sets.push(`${k} = ?`); binds.push(body[k]); }
    }
    if (!sets.length) return new Response('{"error":"nothing to update"}', { status: 400, headers });
    sets.push("updated_at = datetime('now')");
    const r = await env.DB.prepare(`UPDATE fechas SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, fechaEdit[1]).run();
    return new Response(JSON.stringify({ success: true, changed: r.meta.changes }), { headers });
  }

  // GET /api/herramientas — the reference pages (no body); GET /api/herramientas/:slug — one with its markdown body
  if (path === '/api/herramientas' && request.method === 'GET') {
    const items = await getHerramientas(env);
    return new Response(JSON.stringify(items.map(h => ({ ...h, url: `${ORIGIN}${herramientaPath(h)}`, md: `${ORIGIN}${herramientaPath(h)}.md` }))), { headers });
  }
  const herrApi = path.match(/^\/api\/herramientas\/([a-z0-9-]+)$/);
  if (herrApi && request.method === 'GET') {
    const h = await getHerramienta(env, herrApi[1]);
    if (!h) return new Response('{"error":"Not found"}', { status: 404, headers });
    return new Response(JSON.stringify({ ...h, url: `${ORIGIN}${herramientaPath(h)}` }), { headers });
  }

  // POST /api/herramientas/:slug — the weekly routine (or ops) rewrites a page:
  // {title, intro, body (markdown), source_name, source_url, checked_at}
  if (herrApi && request.method === 'POST') {
    if (!checkAuth(request, env)) return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    try {
      const body = await request.json();
      const h = await upsertHerramienta(env, herrApi[1], body);
      await postEvent(env, { title: `Herramienta actualizada — ${h.title}`, body: `revisada el ${h.checked_at}`, url: `${ORIGIN}${herramientaPath(h)}` });
      return new Response(JSON.stringify({ success: true, slug: h.slug, title: h.title, checked_at: h.checked_at, url: `${ORIGIN}${herramientaPath(h)}` }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers });
    }
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

  // POST /api/ingest — accepts pre-researched, pre-written articles from an external agent
  // (the daily research routine). Dedupes by source_url.
  if (path === '/api/ingest' && request.method === 'POST') {
    if (!checkAuth(request, env)) {
      return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    }
    try {
      const body = await request.json();
      const items = Array.isArray(body.articles) ? body.articles : [];
      const result = await ingestArticles(items, env);
      const notes = [];
      if (result.skipped) notes.push(`${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped`);
      if (result.errors.length) notes.push(`${result.errors.length} failed`);
      await postEvent(env, {
        type: !result.inserted && result.errors.length ? 'error' : 'event',
        title: `Morning ingest — ${result.inserted} new stor${result.inserted === 1 ? 'y' : 'ies'}`,
        body: notes.join(' · ') || null,
        url: 'https://diariomigrante.com',
      });
      return new Response(JSON.stringify(result), { headers });
    } catch (e) {
      await postEvent(env, { type: 'error', title: 'Ingest crashed', body: e.message });
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // POST /api/backfill-images — generate art for articles missing it (?force=1 regenerates all)
  if (path === '/api/backfill-images' && request.method === 'POST') {
    if (!checkAuth(request, env)) {
      return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    }
    const params = new URL(request.url).searchParams;
    const force = params.get('force') === '1';
    const date = params.get('date');

    const clauses = [];
    const binds = [];
    if (!force) clauses.push('image_url IS NULL');
    if (date) { clauses.push('date(published_at) = ?'); binds.push(date); }
    let q = 'SELECT id, headline, image_url FROM articles';
    if (clauses.length) q += ' WHERE ' + clauses.join(' AND ');

    const { results } = await env.DB.prepare(q).bind(...binds).all();
    let generated = 0;
    const errors = [];
    for (const row of results) {
      try {
        const url = await generateArticleImage(row.headline, env, null, {
          field: ART_FIELDS[generated % ART_FIELDS.length]
        });
        await env.DB.prepare('UPDATE articles SET image_url = ? WHERE id = ?').bind(url, row.id).run();
        if (row.image_url?.startsWith('/img/')) {
          await env.BUCKET.delete(row.image_url.slice(1));
        }
        generated++;
      } catch (e) {
        errors.push({ id: row.id, error: e.message });
      }
    }
    return new Response(JSON.stringify({ success: true, pipeline: 'cartoon-editorial', targeted: results.length, generated, errors }), { headers });
  }

  // POST /api/subscribe
  if (path === '/api/subscribe' && request.method === 'POST') {
    try {
      const { email, name } = await request.json();
      if (!email) return new Response('{"error":"Email required"}', { status: 400, headers });
      const r = await subscribeEmail(env, email, name);
      if (!r.ok) return new Response('{"error":"Invalid email"}', { status: 400, headers });
      return new Response('{"success":true}', { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // GET/POST /api/unsubscribe — HMAC-tokened link from the email footer.
  // GET shows a tiny Spanish page; POST is the one-click header flow.
  if (path === '/api/unsubscribe') {
    const u = new URL(request.url);
    const email = (u.searchParams.get('email') || '').trim().toLowerCase();
    const t = u.searchParams.get('t') || '';
    const expect = email ? await unsubToken(email, env.UNSUB_SECRET || env.ADMIN_KEY) : '';
    if (!email || t !== expect) {
      return new Response('Enlace inválido.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const r = await env.DB.prepare('UPDATE subscribers SET active = 0 WHERE lower(email) = ? AND active = 1').bind(email).run();
    if (r.meta.changes > 0) {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE active = 1').first();
      await postEvent(env, { type: 'subscriber', title: 'Unsubscribed', body: `${email} — ${n.n} left` });
    }
    if (request.method === 'POST') return new Response(null, { status: 200 });
    return new Response(unsubPageHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // POST /api/send-edition — email today's edition to subscribers now (admin;
  // {force} re-sends; {to} sends a test copy to one address only, guard untouched)
  if (path === '/api/send-edition' && request.method === 'POST') {
    if (!checkAuth(request, env)) {
      return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    }
    const body = await request.json().catch(() => ({}));
    const result = await sendEditionToSubscribers(env, { force: !!body.force, to: body.to || null });
    return new Response(JSON.stringify(result), { headers });
  }

  return new Response('{"error":"Not found"}', { status: 404, headers });
}

// Shared by /api/subscribe and the MCP suscribir tool.
async function subscribeEmail(env, email, name = null) {
  const addr = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) || addr.length > 254) {
    return { ok: false };
  }
  const r = await env.DB.prepare('INSERT OR IGNORE INTO subscribers (email, name) VALUES (?, ?)')
    .bind(addr, name ? String(name).slice(0, 120) : null).run();
  if (r.meta.changes > 0) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE active = 1').first();
    await postEvent(env, { type: 'subscriber', title: 'New subscriber', body: `${addr} — ${n.n} active` });
  }
  return { ok: true, nuevo: r.meta.changes > 0, email: addr };
}

// ─── EDITION DATA (shared by the API and the server-rendered pages) ────

// Lazily translates missing Spanish fields via Gemini and caches them in D1.
async function getPortadaData(env, date) {
  if (!date) {
    const latest = await env.DB.prepare('SELECT date(published_at) AS day FROM articles ORDER BY published_at DESC LIMIT 1').first();
    if (!latest) return { empty: true };
    date = latest.day;
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM articles WHERE date(published_at) = ? ORDER BY published_at DESC'
  ).bind(date).all();

  let translateError = null;
  const missing = results.filter(a => !a.headline_es || !a.summary_es).slice(0, 20);
  if (missing.length) {
    try { await translateArticles(missing, env); } catch (e) { translateError = e.message; }
  }

  const featured = results.slice(0, 5);
  const ids = new Set(featured.map(a => a.id));
  return {
    date,
    total: results.length,
    image: featured.find(a => a.image_url)?.image_url || null,
    featured,
    resto: results.filter(a => !ids.has(a.id)),
    ...(translateError ? { translate_error: translateError } : {})
  };
}

// The editions either side of a day, for prev/next links.
async function getEditionNeighbors(env, day) {
  const prev = await env.DB.prepare('SELECT date(published_at) AS day FROM articles WHERE date(published_at) < ? ORDER BY published_at DESC LIMIT 1').bind(day).first();
  const next = await env.DB.prepare('SELECT date(published_at) AS day FROM articles WHERE date(published_at) > ? ORDER BY published_at ASC LIMIT 1').bind(day).first();
  return { prev: prev?.day || null, next: next?.day || null };
}

// One story, with its Spanish headline, summary and body filled in (and
// cached) the first time anyone asks for it.
async function getNoticia(env, id) {
  const artId = parseInt(id);
  if (!artId) return null;
  const a = await env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(artId).first();
  if (!a) return null;
  if (!a.headline_es || !a.summary_es) {
    try { await translateArticles([a], env); } catch (e) { console.log('translate story failed:', e.message); }
  }
  if (!a.body_es && a.body) {
    try { await translateBody(a, env); } catch (e) { console.log('translate body failed:', e.message); }
  }
  return a;
}

// One row per day that has articles, newest first, each carrying its lead
// headline (Spanish when cached) for the índice.
async function getEditions(env) {
  const { results } = await env.DB.prepare(
    `SELECT date(a.published_at) AS day, COUNT(*) AS count,
       (SELECT COALESCE(b.headline_es, b.headline) FROM articles b
        WHERE date(b.published_at) = date(a.published_at)
        ORDER BY b.published_at DESC LIMIT 1) AS lead
     FROM articles a GROUP BY date(a.published_at) ORDER BY day DESC`
  ).all();
  return results;
}

// ─── HOUSE STYLE ───────────────────────────────────────────────────────
// The paper's style sheet, shared by every line of Spanish the Worker still
// writes (email subject, legacy translations). The daily routine carries the
// same sheet, so a story reads the same whoever wrote it.
const ESTILO =
  'Español latinoamericano neutro, trato de usted. ' +
  'Fechas en palabras: "6 de septiembre", "el 1 de septiembre de 2026", nunca "Sept. 6" ni "9/6". ' +
  '"Estados Unidos" con todas sus letras, nunca "U.S." ni "EE. UU.". ' +
  'Siglas: en la primera mención el nombre en español y la sigla entre paréntesis, por ejemplo ' +
  '"el Servicio de Inmigración y Control de Aduanas (ICE)", "el Departamento de Seguridad Nacional (DHS)", ' +
  '"el Servicio de Ciudadanía e Inmigración (USCIS)"; después solo la sigla. ' +
  'Lugares en su forma española cuando existe: Nueva York, Filadelfia, Indianápolis, Carolina del Norte, Luisiana. ' +
  'Cifras con coma de millar (50,000); montos como "5,130 dólares"; porcentajes como "12%". ' +
  'Nunca "ilegal" para una persona: "sin papeles" o "indocumentado". "Green card" se queda en inglés; "cita de control" para check-in; "redada" para raid. ' +
  'Sin guiones largos, sin comillas tipográficas, con signos de apertura ¿ y ¡.';

// ─── SPANISH TRANSLATION (Gemini, cached in D1) ────────────────────────

// The story body (markdown, written in English by the morning routine) into
// Spanish, once, cached on the row as body_es. Mutates `a` in place.
async function translateBody(a, env) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const prompt =
    'Traduce este texto de una nota de noticias de inmigración al español, para un periódico serio. ' +
    'Claro y directo, cifras y nombres propios intactos, sin anglicismos innecesarios. Libro de estilo: ' + ESTILO + ' ' +
    'Conserva exactamente la estructura markdown (encabezados con ##, viñetas con -, párrafos) y traduce también los ' +
    'encabezados, con estos nombres: "Datos clave", "Contexto", "Qué significa esto", "Qué hacer ahora". ' +
    'Devuelve SOLO el markdown traducido, sin comentarios.\n\n' + a.body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: controller.signal
      }
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const j = await res.json();
    const text = (j.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().replace(/^```(?:markdown)?\s*|\s*```$/g, '').trim();
    if (text.length < 40) throw new Error('empty translation');
    await env.DB.prepare('UPDATE articles SET body_es = ? WHERE id = ?').bind(text, a.id).run();
    a.body_es = text;
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function translateArticles(items, env) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const payload = items.map(a => ({ id: a.id, headline: a.headline, summary: a.summary }));
  const prompt =
    'Traduce estos titulares y resúmenes de noticias de inmigración al español, para un periódico serio. ' +
    'Claro y directo, cifras y nombres propios intactos, sin anglicismos innecesarios. Libro de estilo: ' + ESTILO + ' ' +
    'En titulares y resúmenes las siglas van solas, sin expandir. ' +
    'Los titulares además se condensan al traducir: máximo 12 palabras, recorta el relleno y las ' +
    'subordinadas sin perder el hecho principal ni el actor. ' +
    'Devuelve SOLO un arreglo JSON con la forma [{"id": 1, "headline_es": "...", "summary_es": "..."}].\n\n' +
    JSON.stringify(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        }),
        signal: controller.signal
      }
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const j = await res.json();
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned no text');
    const translations = JSON.parse(text);

    for (const t of translations) {
      if (!t.id || !t.headline_es || !t.summary_es) continue;
      await env.DB.prepare('UPDATE articles SET headline_es = ?, summary_es = ? WHERE id = ?')
        .bind(t.headline_es, t.summary_es, t.id).run();
      const row = items.find(a => a.id === t.id);
      if (row) { row.headline_es = t.headline_es; row.summary_es = t.summary_es; }
    }
  } finally {
    clearTimeout(timer);
  }
}

// ─── ARTICLE ART (Nano Banana 2, stored in R2) ─────────────────────────

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// One flat background field per image, rotated story to story so the portada
// never comes out monochrome.
const ART_FIELDS = ['saturated blue', 'saturated orange', 'saturated yellow', 'saturated green', 'dusty rose'];

async function generateArticleImage(headline, env, providedScene = null, opts = {}) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const model = opts.model || 'gemini-3.1-flash-image';
  const aspect = opts.aspect || '1:1';
  const field = opts.field || ART_FIELDS[Math.floor(Math.random() * ART_FIELDS.length)];

  // The routine art-directs each story (image_concept). Without one (backfills,
  // manual ingests), the model invents the scene itself.
  const scene = providedScene?.trim().replace(/^["']|["']$/g, '')
    || `a single symbolic deadpan scene of your own invention that captures the story behind this news headline: "${headline}"`;

  const prompt = `Flat cartoon illustration with clean vector lines, thick black outlines, flat bold colors, ` +
    `deadpan absurd character design. Faces are extremely simplified: tiny dot eyes, small flat expressionless mouth, ` +
    `no eyebrows, no nose or a single short line for a nose, smooth rounded heads. Characters are a natural mix of ` +
    `people, some light-skinned, some tan, some dark-skinned, with varied hair. Editorial illustration style like ` +
    `Jean Jullien and Andy Rementer, one flat ${field} background color, no gradients, no shading: ${scene}. ` +
    `The artwork fills the entire image edge to edge, no paper border, no frame, no mat, not a photo of a poster. ` +
    `Not corporate flat vector, not clip art, not a children's book style. ` +
    `Absolutely no logos, no text, no letters, no numbers anywhere.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { imageConfig: { aspectRatio: aspect } }
        }),
        signal: controller.signal
      }
    );
    if (!res.ok) throw new Error(`Nano Banana ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const j = await res.json();
    for (const c of j.candidates || []) {
      for (const p of c.content?.parts || []) {
        if (p.inlineData?.data) {
          const mime = p.inlineData.mimeType || 'image/png';
          const key = `img/${crypto.randomUUID()}.${mime.includes('jpeg') ? 'jpg' : 'png'}`;
          await env.BUCKET.put(key, base64ToBytes(p.inlineData.data), { httpMetadata: { contentType: mime } });
          return `/${key}`;
        }
      }
    }
    throw new Error('Nano Banana returned no image');
  } finally {
    clearTimeout(timer);
  }
}

// ─── INGEST (external agent submissions) ───────────────────────────────

async function findOrCreateSource(item, env) {
  const origin = item.source_url ? new URL(item.source_url).origin : null;
  const name = item.source_name || origin || 'Unknown source';

  const existing = origin
    ? await env.DB.prepare('SELECT id FROM sources WHERE url = ?').bind(origin).first()
    : await env.DB.prepare('SELECT id FROM sources WHERE name = ?').bind(name).first();
  if (existing) return existing.id;

  const created = await env.DB.prepare(
    "INSERT INTO sources (name, url, scrape_url, type, category, active) VALUES (?, ?, ?, 'agent', ?, 1) RETURNING id"
  ).bind(name, origin || name, origin || name, item.category || 'general').first();
  return created.id;
}

async function ingestArticles(items, env) {
  let inserted = 0;
  let skipped = 0;
  let fechas = 0;
  const errors = [];
  // Art budget: five drawings per edition (Paul, 2026-08-12). The first five
  // stories get one each; on bigger days the rest run text-only.
  let artCount = 0;

  for (const item of items) {
    try {
      // Since 2026-09-08 the routine writes the story in Spanish (headline_es,
      // summary_es, body_es) and sends a short English headline + summary for
      // the agent surface and the art. An English body is optional now; the
      // old English-only payload still works and gets translated at read time.
      const bodyEs = typeof item.body_es === 'string' ? item.body_es.trim() : '';
      const bodyEn = typeof item.body === 'string' ? item.body.trim() : '';
      if (!item.source_url || !item.headline || !item.summary || (!bodyEs && !bodyEn)) {
        errors.push({ source_url: item.source_url || null, error: 'missing required field (source_url, headline, summary, and body_es or body)' });
        continue;
      }
      if (bodyEs && bodyEs.length < 200) {
        errors.push({ source_url: item.source_url, error: 'body_es too short' });
        continue;
      }

      const existing = await env.DB.prepare('SELECT id FROM raw_articles WHERE url = ?').bind(item.source_url).first();
      if (existing) {
        skipped++;
        continue;
      }

      const sourceId = await findOrCreateSource(item, env);

      let imageUrl = item.image_url || null;
      if (!imageUrl && artCount < 5) {
        try {
          imageUrl = await generateArticleImage(item.headline, env, item.image_concept || null, {
            field: ART_FIELDS[artCount % ART_FIELDS.length]
          });
          artCount++;
        } catch (e) {
          console.error('Image generation failed:', e.message);
        }
      }

      const raw = await env.DB.prepare(
        'INSERT INTO raw_articles (source_id, title, url, raw_content, published_at, processed) VALUES (?, ?, ?, ?, ?, 1) RETURNING id'
      ).bind(sourceId, item.headline, item.source_url, item.summary, item.published_at || null).first();

      const art = await env.DB.prepare(
        `INSERT INTO articles (raw_article_id, source_id, headline, summary, body, headline_es, summary_es, body_es, category, source_name, source_url, image_url, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now'))) RETURNING id`
      ).bind(
        raw.id, sourceId, item.headline, item.summary, bodyEn,
        item.headline_es?.trim() || null, item.summary_es?.trim() || null, bodyEs || null,
        item.category || 'general', item.source_name || 'Unknown', item.source_url, imageUrl, item.published_at || null
      ).first();

      inserted++;

      // The story's dates go on the calendar, linked back to the story.
      if (Array.isArray(item.fechas) && item.fechas.length) {
        try {
          const r = await insertFechas(item.fechas, env, { article: { id: art.id, source_name: item.source_name || null, source_url: item.source_url } });
          fechas += r.inserted;
        } catch (e) {
          console.error('fechas insert failed:', e.message);
        }
      }
    } catch (e) {
      errors.push({ source_url: item.source_url || null, error: e.message });
    }
  }

  return { success: true, received: items.length, inserted, skipped, fechas, errors };
}

// ─── EMAIL SUBSCRIPTION (Resend) ───────────────────────────────────────
// The morning edition goes to every active subscriber, once per day. An
// edition that already went out never goes again (edition_sends guards it),
// and a day with no subscribers stays unsent so the first person to sign up
// still gets today's paper.
//
// From resend.dev until diariomigrante.com is verified on Resend; flip
// EMAIL_FROM in wrangler.toml when it is.

const FALLBACK_FROM = 'Diario Migrante <onboarding@resend.dev>';
const REPLY_TO = 'paul.beresuita@gmail.com';

async function unsubToken(email, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(email.trim().toLowerCase()));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// The email IS the paper: no card, white sheet edge to edge, the same folio
// rules, blackletter masthead (PNG — email clients can't load the font), and
// hairline-divided stories like the portada.
function editionEmailHtml({ fecha, featured, unsubUrl, fechasHtml = '' }) {
  const SERIF = "'Newsreader', Georgia, 'Times New Roman', serif";
  const SANS = "'Libre Franklin', -apple-system, Helvetica, Arial, sans-serif";

  const storiesHtml = featured.map((a, i) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${i > 0 ? `<tr><td class="hair" style="border-top:1px solid #C9C6C0;font-size:0;line-height:0;padding-top:24px;">&nbsp;</td></tr>` : `<tr><td class="ink" style="padding:0 0 10px;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;color:#171512;">LO QUE IMPORTA HOY</td></tr>`}
    <tr><td class="ink" style="font-family:${SERIF};font-size:${i === 0 ? 26 : 19}px;line-height:1.25;font-weight:700;color:#171512;">${a.source_url ? `<a class="ink" href="${esc(a.source_url)}" style="color:#171512;text-decoration:none;">${esc(a.headline_es || a.headline)}</a>` : esc(a.headline_es || a.headline)}</td></tr>
    <tr><td class="body" style="padding:8px 0 0;font-family:${SERIF};font-size:15.5px;line-height:1.65;color:#3A3733;">${esc(a.summary_es || a.summary)}</td></tr>
    <tr><td class="dim" style="padding:8px 0 0;font-family:${SANS};font-size:11px;letter-spacing:1.5px;color:#6E6961;">${a.source_url ? `<a class="dim" href="${esc(a.source_url)}" style="color:#6E6961;text-decoration:none;">LEER EN ${esc((a.source_name || '').toUpperCase())} &#8599;</a>` : esc((a.source_name || '').toUpperCase())}</td></tr>
    ${a.image_url ? `<tr><td style="padding:14px 0 24px;"><img src="${ORIGIN}${a.image_url}" alt="" width="600" height="600" style="display:block;width:100%;max-width:600px;height:auto;"></td></tr>` : `<tr><td style="font-size:0;line-height:0;padding-bottom:24px;">&nbsp;</td></tr>`}
  </table>`).join('\n');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
  .m-oscuro { display: none; }
  @media only screen and (max-width: 640px) {
    .outer { padding: 24px 14px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bodybg { background-color: #161615 !important; }
    .ink { color: #f0efe9 !important; }
    .body { color: #d6d4cc !important; }
    .dim { color: #8f8d85 !important; }
    .hair { border-color: #2e2d2a !important; }
    .rule { background-color: #f0efe9 !important; }
    .folio { border-color: #f0efe9 !important; }
    .m-claro { display: none !important; }
    .m-oscuro { display: block !important; }
  }
  [data-ogsc] .ink { color: #f0efe9 !important; }
  [data-ogsc] .body { color: #d6d4cc !important; }
  [data-ogsc] .dim { color: #8f8d85 !important; }
  [data-ogsc] .hair { border-color: #2e2d2a !important; }
  [data-ogsc] .rule { background-color: #f0efe9 !important; }
  [data-ogsc] .folio { border-color: #f0efe9 !important; }
  [data-ogsc] .m-claro { display: none !important; }
  [data-ogsc] .m-oscuro { display: block !important; }
</style>
</head>
<body class="bodybg" style="margin:0;padding:0;background-color:#FFFFFF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bodybg" style="background-color:#FFFFFF;">
<tr><td align="center" class="outer" style="padding:32px 20px 40px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <tr><td class="folio" style="border-top:1px solid #171512;border-bottom:1px solid #171512;padding:8px 2px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="ink" style="font-family:${SANS};font-size:10px;font-weight:600;letter-spacing:1.5px;color:#171512;">NOTICIAS DE INMIGRACI&Oacute;N</td>
      <td class="ink" align="right" style="font-family:${SANS};font-size:10px;font-weight:600;letter-spacing:1.5px;color:#171512;">${esc(fecha)}</td>
    </tr></table>
  </td></tr>

  <tr><td align="center" style="padding:22px 0 18px;">
    <img class="m-claro" src="${ORIGIN}/masthead-tinta.png" alt="Diario Migrante" width="330" height="50" style="display:block;width:330px;max-width:80%;height:auto;">
    <img class="m-oscuro" src="${ORIGIN}/masthead-papel.png" alt="Diario Migrante" width="330" height="50" style="width:330px;max-width:80%;height:auto;">
  </td></tr>

  <tr><td>
    <div class="rule" style="height:3px;background-color:#171512;font-size:0;line-height:0;">&nbsp;</div>
    <div class="rule" style="height:1px;background-color:#171512;margin-top:3px;font-size:0;line-height:0;">&nbsp;</div>
  </td></tr>

  <tr><td style="padding-top:26px;">
${storiesHtml}
  </td></tr>
${fechasHtml ? `
  <tr><td>${fechasHtml}
  </td></tr>` : ''}

  <tr><td class="hair" style="border-top:1px solid #C9C6C0;padding-top:16px;" align="center">
    <p class="dim" style="margin:0;font-family:${SANS};font-size:10px;letter-spacing:1.5px;color:#8A857D;">DIARIO MIGRANTE &middot; GRATIS, CADA MA&Ntilde;ANA A LAS 7</p>
    <p class="body" style="margin:16px 0 0;font-family:${SERIF};font-size:15px;color:#3A3733;">La edici&oacute;n completa: <a class="ink" href="${ORIGIN}" style="color:#171512;">diariomigrante.com</a></p>
    <p class="dim" style="margin:12px 0 0;font-family:${SANS};font-size:11px;line-height:1.6;color:#6E6961;">Recibes este correo porque te suscribiste en diariomigrante.com. Si ya no lo quieres, <a class="dim" href="${unsubUrl}" style="color:#6E6961;">cancela aqu&iacute;</a>.</p>
  </td></tr>

  <tr><td style="height:48px;font-size:0;line-height:0;">&nbsp;</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function unsubPageHtml() {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Listo — Diario Migrante</title></head>
<body style="margin:0;background:#FFFFFF;color:#171512;font-family:Georgia,serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
<div style="text-align:center;padding:40px;">
<div style="font-size:26px;font-weight:700;">Diario Migrante</div>
<p style="font-size:17px;color:#3A3733;margin:18px 0 0;">Listo. Ya no te escribimos.<br>Si cambias de opinión, la portada siempre está en <a href="${ORIGIN}" style="color:#171512;">diariomigrante.com</a>.</p>
</div>
</body></html>`;
}

// Headlines run long; the inbox wants a short line. Gemini compresses the lead
// story into a few words, and a plain word-trim of the headline covers any failure.
async function generateEmailSubject(lead, env) {
  const headline = lead.headline_es || lead.headline || 'La edición de hoy';
  const fallback = headline.split(/\s+/).slice(0, 9).join(' ');
  if (!env.GEMINI_API_KEY) return fallback;

  const prompt =
    'Escribe el asunto de correo para la edición de hoy de un diario serio de noticias de inmigración en español. ' +
    'Máximo 8 palabras. Directo y concreto, cifras y nombres propios intactos, sin punto final, sin comillas, ' +
    'sin dos puntos, sin emojis, sin sensacionalismo. Siglas solas, sin expandir. Libro de estilo: ' + ESTILO + ' ' +
    'Devuelve SOLO el asunto.\n\n' +
    `Noticia principal:\nTitular: ${headline}\nResumen: ${lead.summary_es || lead.summary || ''}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: controller.signal
      }
    );
    if (!res.ok) return fallback;
    const j = await res.json();
    const text = (j.candidates?.[0]?.content?.parts?.[0]?.text || '')
      .trim().replace(/^["'«]|["'»]$/g, '').replace(/\.$/, '').trim();
    if (!text || text.includes('\n') || text.split(/\s+/).length > 10 || text.length > 90) return fallback;
    return text;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function sendEditionToSubscribers(env, { force = false, to = null } = {}) {
  if (!env.RESEND_API_KEY) return { sent: 0, reason: 'RESEND_API_KEY not set' };

  const latest = await env.DB.prepare('SELECT date(published_at) AS day FROM articles ORDER BY published_at DESC LIMIT 1').first();
  if (!latest) return { sent: 0, reason: 'no editions' };
  const day = latest.day;

  // A test send (`to`) never consults or writes the once-per-day guard.
  const guard = await env.DB.prepare('SELECT sent_at FROM edition_sends WHERE day = ?').bind(day).first();
  if (guard?.sent_at && !force && !to) return { sent: 0, reason: `edition ${day} already sent` };

  const { results: articles } = await env.DB.prepare(
    'SELECT * FROM articles WHERE date(published_at) = ? ORDER BY published_at DESC'
  ).bind(day).all();
  if (!articles.length) return { sent: 0, reason: 'empty edition' };

  const missing = articles.filter(a => !a.headline_es || !a.summary_es).slice(0, 20);
  if (missing.length) { try { await translateArticles(missing, env); } catch (e) { console.log('translate before send failed:', e.message); } }
  for (const a of articles) {
    if (!a.body_es && a.body) { try { await translateBody(a, env); } catch (e) { console.log('translate body before send failed:', e.message); } }
  }

  const featured = articles.slice(0, 5);
  const fecha = fechaLarga(day);
  const lead = featured[0];
  const subject = (await generateEmailSubject(lead, env)).slice(0, 150);

  // Edition number = how many days have published up to this one (same count
  // the portada shows).
  const ed = await env.DB.prepare(
    'SELECT COUNT(DISTINCT date(published_at)) AS n FROM articles WHERE date(published_at) <= ?'
  ).bind(day).first();
  const edicion = ed?.n || 1;

  const subs = to
    ? [{ email: String(to).trim().toLowerCase() }]
    : (await env.DB.prepare('SELECT email FROM subscribers WHERE active = 1').all()).results;
  if (!subs.length) return { sent: 0, reason: 'no subscribers' };

  // "Esta semana vence": the calendar's next seven days ride under the stories.
  let fechasHtml = '';
  try { fechasHtml = fechasEmailHtml(await getProximas(env, 7)); } catch (e) { console.log('fechas strip failed:', e.message); }

  const from = env.EMAIL_FROM || FALLBACK_FROM;
  const emails = [];
  for (const s of subs) {
    const t = await unsubToken(s.email, env.UNSUB_SECRET || env.ADMIN_KEY);
    const unsubUrl = `${ORIGIN}/api/unsubscribe?email=${encodeURIComponent(s.email.trim().toLowerCase())}&t=${t}`;
    emails.push({
      from,
      to: [s.email],
      reply_to: REPLY_TO,
      subject,
      html: editionEmailHtml({ fecha, featured, unsubUrl, fechasHtml }),
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  }

  let sent = 0;
  const errors = [];
  for (let i = 0; i < emails.length; i += 100) {
    const batch = emails.slice(i, i + 100);
    const r = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    const b = await r.json().catch(() => ({}));
    if (r.ok) sent += batch.length;
    else errors.push({ status: r.status, detail: b });
  }

  if (sent && !to) {
    await env.DB.prepare("INSERT OR REPLACE INTO edition_sends (day, sent_at, recipients) VALUES (?, datetime('now'), ?)")
      .bind(day, sent).run();
    await postEvent(env, {
      title: `Edición Nº ${edicion} sent — ${sent} subscriber${sent === 1 ? '' : 's'}`,
      body: subject,
      url: 'https://diariomigrante.com',
    });
  }
  if (errors.length && !to) {
    await postEvent(env, { type: 'error', title: 'Edition send hit Resend errors', body: JSON.stringify(errors).slice(0, 500) });
  }
  return { sent, day, subject, subscribers: subs.length, ...(errors.length ? { errors } : {}) };
}
