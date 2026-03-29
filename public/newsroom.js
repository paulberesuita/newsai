// ─── State ───────────────────────────────────────────────────────────

let articles = [];
let offset = 0;
let currentCategory = 'all';
let searchQuery = '';
const LIMIT = 30;

// ─── Init ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setDate();
  loadStats();
  loadArticles();
  setupFilters();
  setupSearch();
});

// ─── Stats ──────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('stat-total').textContent = data.total_articles || 0;
    document.getElementById('stat-sources').textContent = data.active_sources || 0;
    document.getElementById('stat-today').textContent = data.articles_today || 0;
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

// ─── Load Articles ───────────────────────────────────────────────────

async function loadArticles(append = false) {
  try {
    const params = new URLSearchParams({ limit: LIMIT, offset });
    if (currentCategory !== 'all') params.set('category', currentCategory);

    const res = await fetch(`/api/articles?${params}`);
    const data = await res.json();

    if (!append) {
      articles = data;
      offset = 0;
    } else {
      articles = [...articles, ...data];
    }

    render();

    const wrap = document.getElementById('load-more-wrap');
    wrap.style.display = data.length >= LIMIT ? 'block' : 'none';
  } catch (e) {
    console.error('Failed to load articles:', e);
  }
}

// ─── Render ──────────────────────────────────────────────────────────

function render() {
  const listEl = document.getElementById('newsroom-list');
  const emptyEl = document.getElementById('empty-state');

  // Filter by search query
  const filtered = searchQuery
    ? articles.filter(a =>
        a.headline.toLowerCase().includes(searchQuery) ||
        (a.summary && a.summary.toLowerCase().includes(searchQuery)) ||
        (a.source_name && a.source_name.toLowerCase().includes(searchQuery))
      )
    : articles;

  if (filtered.length === 0) {
    listEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  listEl.style.display = 'block';
  emptyEl.style.display = 'none';
  listEl.innerHTML = '';

  filtered.forEach(article => {
    const el = document.createElement('article');
    el.className = 'newsroom-item';
    el.innerHTML = `
      <div class="newsroom-item-left">
        <div class="story-category-label" data-cat="${article.category}">${formatCategory(article.category)}</div>
        <h3 class="story-headline">${escapeHtml(article.headline)}</h3>
        <p class="story-summary">${escapeHtml(article.summary)}</p>
        <div class="story-meta">
          <span class="story-source">${escapeHtml(article.source_name)}</span>
          <span class="story-time">${timeAgo(article.published_at)}</span>
        </div>
      </div>
    `;
    el.onclick = () => window.location.href = `/article/${article.slug || article.id}`;
    listEl.appendChild(el);
  });
}

// ─── Filters ─────────────────────────────────────────────────────────

function setupFilters() {
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');
      currentCategory = pill.dataset.category;
      offset = 0;
      loadArticles();
    });
  });

  document.getElementById('btn-load-more').addEventListener('click', () => {
    offset += LIMIT;
    loadArticles(true);
  });
}

// ─── Search ─────────────────────────────────────────────────────────

function setupSearch() {
  let debounceTimer;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = e.target.value.toLowerCase().trim();
      render();
    }, 200);
  });
}
