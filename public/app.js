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
  setupModal();
});

// ─── Date ────────────────────────────────────────────────────────────

function setDate() {
  const el = document.getElementById('current-date');
  const now = new Date();
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  el.textContent = now.toLocaleDateString('en-US', options);
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
  heroEl.onclick = () => openArticle(hero);

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
  el.onclick = () => openArticle(article);
  return el;
}

// ─── Filters ─────────────────────────────────────────────────────────

function setupFilters() {
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
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

// ─── Modal ───────────────────────────────────────────────────────────

function setupModal() {
  const overlay = document.getElementById('modal-overlay');
  const closeBtn = document.getElementById('modal-close');

  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.classList.remove('open');
  });
}

function openArticle(article) {
  document.getElementById('modal-category').textContent = formatCategory(article.category);
  document.getElementById('modal-headline').textContent = article.headline;
  document.getElementById('modal-source').textContent = article.source_name;
  document.getElementById('modal-time').textContent = timeAgo(article.published_at);
  document.getElementById('modal-body').innerHTML = renderMarkdown(article.body);
  document.getElementById('modal-source-link').href = article.source_url;
  document.getElementById('modal-overlay').classList.add('open');
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatCategory(cat) {
  const labels = {
    policy: 'Policy',
    visa: 'Visa & Green Card',
    enforcement: 'Enforcement',
    courts: 'Court Rulings',
    asylum: 'Asylum & Refugees',
    daca: 'DACA',
    general: 'Immigration'
  };
  return labels[cat] || 'Immigration';
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderMarkdown(md) {
  if (!md) return '';
  return md
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Unordered lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // Paragraphs
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hulo])(.+)$/gm, '<p>$1</p>')
    // Clean up
    .replace(/<p><\/p>/g, '')
    .replace(/<p>(<[hulo])/g, '$1')
    .replace(/(<\/[hulo][^>]*>)<\/p>/g, '$1');
}
