// ─── State ───────────────────────────────────────────────────────────

let articles = [];
let offset = 0;
let currentCategory = 'all';
const LIMIT = 20;

// ─── Init ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setDate();
  loadArticles();
  setupFilters();
});

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

    // Show/hide load more
    const wrap = document.getElementById('load-more-wrap');
    wrap.style.display = data.length >= LIMIT ? 'block' : 'none';
  } catch (e) {
    console.error('Failed to load articles:', e);
  }
}

// ─── Render ──────────────────────────────────────────────────────────

function render() {
  const heroEl = document.getElementById('hero-story');
  const gridEl = document.getElementById('stories-grid');
  const emptyEl = document.getElementById('empty-state');
  const edition = document.querySelector('.edition');

  if (articles.length === 0) {
    edition.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  edition.style.display = 'block';
  emptyEl.style.display = 'none';

  // Hero = first article
  const hero = articles[0];
  heroEl.querySelector('.story-category-label').textContent = formatCategory(hero.category);
  heroEl.querySelector('.story-category-label').setAttribute('data-cat', hero.category);
  heroEl.querySelector('.story-headline').textContent = hero.headline;
  heroEl.querySelector('.story-summary').textContent = hero.summary;
  heroEl.querySelector('.story-source').textContent = hero.source_name;
  heroEl.querySelector('.story-time').textContent = timeAgo(hero.published_at);
  heroEl.onclick = () => window.location.href = `/article/${hero.slug || hero.id}`;

  // Grid = rest of articles, in two columns with divider
  const rest = articles.slice(1);
  const mid = Math.ceil(rest.length / 2);
  const leftCol = rest.slice(0, mid);
  const rightCol = rest.slice(mid);

  gridEl.innerHTML = '';

  // Left column
  const leftDiv = document.createElement('div');
  leftDiv.className = 'stories-col';
  leftCol.forEach(a => leftDiv.appendChild(createStoryCard(a)));
  gridEl.appendChild(leftDiv);

  // Vertical divider
  const divider = document.createElement('div');
  divider.className = 'grid-divider';
  gridEl.appendChild(divider);

  // Right column
  const rightDiv = document.createElement('div');
  rightDiv.className = 'stories-col';
  rightCol.forEach(a => rightDiv.appendChild(createStoryCard(a)));
  gridEl.appendChild(rightDiv);
}

function createStoryCard(article) {
  const el = document.createElement('article');
  el.className = 'story';
  el.innerHTML = `
    <div class="story-category-label" data-cat="${article.category}">${formatCategory(article.category)}</div>
    <h3 class="story-headline">${escapeHtml(article.headline)}</h3>
    <p class="story-summary">${escapeHtml(article.summary)}</p>
    <div class="story-meta">
      <span class="story-source">${escapeHtml(article.source_name)}</span>
      <span class="story-time">${timeAgo(article.published_at)}</span>
    </div>
  `;
  el.onclick = () => window.location.href = `/article/${article.slug || article.id}`;
  return el;
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
