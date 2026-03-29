// ─── State ───────────────────────────────────────────────────────────

let sources = [];
let currentCategory = 'all';

// ─── Init ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setDate();
  loadStats();
  loadSources();
});

// ─── Stats ──────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('stat-sources').textContent = data.active_sources || 0;
    document.getElementById('stat-articles').textContent = data.total_articles || 0;
    document.getElementById('stat-today').textContent = data.articles_today || 0;
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

// ─── Load Sources ───────────────────────────────────────────────────

async function loadSources() {
  try {
    const res = await fetch('/api/sources');
    sources = await res.json();
    buildCategoryFilters();
    render();
  } catch (e) {
    console.error('Failed to load sources:', e);
    document.getElementById('empty-state').style.display = 'block';
  }
}

// ─── Build category filters from actual data ────────────────────────

function buildCategoryFilters() {
  const categories = [...new Set(sources.map(s => s.category).filter(Boolean))];
  const filtersEl = document.getElementById('source-filters');

  // Keep the "All" button, add the rest
  categories.sort().forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filter-pill';
    btn.dataset.category = cat;
    btn.textContent = formatCategory(cat);
    filtersEl.appendChild(btn);
  });

  // Attach click handlers
  filtersEl.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      filtersEl.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');
      currentCategory = pill.dataset.category;
      render();
    });
  });
}

// ─── Render ──────────────────────────────────────────────────────────

function render() {
  const gridEl = document.getElementById('sources-grid');
  const emptyEl = document.getElementById('empty-state');

  const filtered = currentCategory === 'all'
    ? sources
    : sources.filter(s => s.category === currentCategory);

  if (filtered.length === 0) {
    gridEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  gridEl.style.display = 'grid';
  emptyEl.style.display = 'none';
  gridEl.innerHTML = '';

  filtered.forEach(source => {
    const card = document.createElement('div');
    card.className = 'source-card';

    const lastScraped = source.last_scraped
      ? timeAgo(source.last_scraped)
      : 'Not yet scraped';

    card.innerHTML = `
      <div class="source-card-header">
        <h3 class="source-card-name">${escapeHtml(source.name)}</h3>
        <span class="source-card-badge" data-cat="${source.category}">${formatCategory(source.category)}</span>
      </div>
      <a class="source-card-url" href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.url)}</a>
      <div class="source-card-meta">
        <span class="pulse"></span>
        Last checked ${lastScraped}
      </div>
    `;
    gridEl.appendChild(card);
  });
}
