const dialog = document.querySelector('.search-dialog');
const menuDialog = document.querySelector('.menu-dialog');
const menuButton = document.querySelector('.menu');
const archive = document.querySelector('.archive-grid');
const filterRow = document.querySelector('.archive-filter');
const archiveEyebrow = document.querySelector('.original-archive .eyebrow');
const archiveTitle = document.querySelector('.original-archive h2');
let posts = [];

document.querySelector('.search').addEventListener('click', () => dialog.showModal());
document.querySelector('.close-search').addEventListener('click', () => dialog.close());

// The menu slides in from the right and back out again. A <dialog> disappears
// the instant close() runs, so the exit slide is played first and the dialog is
// only closed once it has finished.
const MENU_SLIDE_MS = 420; // keep in sync with the .menu-dialog transition in styles.css
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let menuCloseTimer;

const openMenu = () => {
  clearTimeout(menuCloseTimer);
  menuDialog.showModal();
  menuDialog.getBoundingClientRect(); // flush the off-screen position so it becomes the first frame
  menuDialog.classList.add('is-open');
  menuButton.setAttribute('aria-expanded', 'true');
};

const closeMenu = () => {
  if (!menuDialog.open) return;
  menuDialog.classList.remove('is-open');
  menuButton.setAttribute('aria-expanded', 'false');
  clearTimeout(menuCloseTimer);
  menuCloseTimer = setTimeout(() => menuDialog.close(), reduceMotion.matches ? 0 : MENU_SLIDE_MS);
};

menuButton.addEventListener('click', openMenu);
document.querySelector('.close-menu').addEventListener('click', closeMenu);
document.querySelectorAll('.menu-dialog nav a').forEach((link) => link.addEventListener('click', closeMenu));
// Esc and a click beside the panel close it the same animated way.
menuDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeMenu();
});
menuDialog.addEventListener('click', (event) => {
  if (event.target === menuDialog) closeMenu();
});

// A photo that fails to load leaves a quiet empty frame rather than the
// browser's torn broken-image icon. `error` does not bubble, so it is caught on
// the way down the tree.
document.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement) event.target.classList.add('is-broken');
}, true);

// Posts carry their real plantiness.com categories in `cats`. "Rezepte" sits on
// 41 of 54 posts, so the card label prefers the more specific one behind it.
const categoryLabel = (post) => (post.cats || []).find((c) => c !== 'Rezepte') || (post.cats || [])[0] || '';

// Below 760px the cards are laid out flat — photo plus title and teaser side by
// side — so there is nothing hidden to reveal and a tap goes straight to the post.
const isMobileLayout = () => window.matchMedia('(max-width: 760px)').matches;

// The archive grid can hold 50+ flip cards. Giving every one of them a live
// 3D transform context (perspective/preserve-3d) at once is expensive enough
// to freeze the page, so only cards near the viewport get promoted to 3D —
// this bounds how many are "flippable" at a time without limiting the effect.
const flipObserver = new IntersectionObserver(
  (entries) => entries.forEach((entry) => entry.target.classList.toggle('in-view', entry.isIntersecting && !isMobileLayout())),
  { rootMargin: '200px 0px' }
);

const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The filter row is the category strip again: the same four categories, read
// out of the strip itself so the two can never drift apart, with the same icons
// and the same "41 Beiträge" line underneath. Post counts come from the posts.
const STRIP_TILES = [...document.querySelectorAll('.category-strip a[data-jump]')].map((link) => ({
  name: link.dataset.jump,
  icon: link.querySelector('.category-icon')?.textContent || '✦',
}));
const ALL_TILE = { name: 'all', label: 'Alle Beiträge', icon: '✦' };
let counts = {};
let pendingJump = '';
let activeFilter = 'all';

const countCategories = () => {
  counts = {};
  posts.forEach((post) => (post.cats || []).forEach((cat) => (counts[cat] = (counts[cat] || 0) + 1)));
};

const buildFilterRow = () => {
  const tiles = [{ ...ALL_TILE, count: posts.length }];
  STRIP_TILES.filter((tile) => counts[tile.name]).forEach((tile) => tiles.push({ ...tile, label: tile.name, count: counts[tile.name] }));
  // The menu and the search sheet also link categories the strip does not carry
  // ("Suppen", "Nährstoffe" …) — such a jump brings its own tile along, so the
  // active filter is never nameless.
  if (activeFilter !== 'all' && !tiles.some((tile) => tile.name === activeFilter)) {
    tiles.push({ name: activeFilter, label: activeFilter, icon: ALL_TILE.icon, count: counts[activeFilter] || 0 });
  }
  // As long as the same tiles are on show, only the active one is re-marked —
  // the buttons stay put so the lime and the icon can transition across rather
  // than blink into place on a rebuilt row.
  const signature = tiles.map((tile) => tile.name).join('|');
  if (filterRow.dataset.tiles !== signature) {
    filterRow.dataset.tiles = signature;
    filterRow.style.setProperty('--filter-cols', tiles.length);
    filterRow.innerHTML = tiles.map((tile) => `<button data-filter="${escapeHtml(tile.name)}"><span class="category-icon" aria-hidden="true">${tile.icon}</span><span>${escapeHtml(tile.label)}</span><b>${tile.count} Beiträge</b></button>`).join('');
  }
  filterRow.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === activeFilter);
    button.setAttribute('aria-pressed', button.dataset.filter === activeFilter);
  });
};

// "Alle Beiträge" → "Alle <em>Beiträge.</em>", "Für Naschkatzen" → "Für <em>Naschkatzen.</em>"
const headline = (name) => {
  const cut = name.lastIndexOf(' ');
  const safe = escapeHtml(name);
  return cut === -1 ? `<em>${safe}.</em>` : `${escapeHtml(name.slice(0, cut))} <em>${escapeHtml(name.slice(cut + 1))}.</em>`;
};

// Restarts a CSS entrance animation on an element that is already in the page.
const replayEntrance = (element) => {
  element.classList.remove('swap');
  void element.offsetWidth; // let the browser notice the class is gone
  element.classList.add('swap');
};

// Only the cards a visitor can plausibly have on screen cascade in; the tail of
// a 54-post archive appears without animating, which keeps the work on a phone
// to a handful of elements no matter how big the filter's result is.
const CASCADE_LIMIT = 18;

const renderArchive = (filter = 'all') => {
  const visible = filter === 'all' ? posts : posts.filter((post) => (post.cats || []).includes(filter));
  archiveEyebrow.textContent = filter === 'all'
    ? `ALLE ${posts.length} BEITRÄGE`
    : `${visible.length} ${visible.length === 1 ? 'BEITRAG' : 'BEITRÄGE'}`;
  archiveTitle.innerHTML = headline(filter === 'all' ? 'Alle Beiträge' : filter);
  replayEntrance(archiveEyebrow);
  replayEntrance(archiveTitle);
  archive.innerHTML = visible.map((post, index) => {
    // The teaser is the post's own excerpt; a recipe's first ingredients are
    // kept as a second line, since they say a lot about the dish at a glance.
    const teaser = post.excerpt || '';
    const hint = (post.ingredients || [])
      .filter((item) => item.length <= 42) // skip the odd whole-dressing-recipe entry
      .slice(0, 3)
      .join(' · ');
    return `<a class="archive-item has-photo${index < CASCADE_LIMIT ? ' enter' : ''}" style="--i:${index}" href="/${post.slug}/"><div class="flip-inner-v"><div class="archive-photo"><img src="${post.image}" alt="${post.title}" loading="lazy" /></div><div class="archive-overlay"><p class="tag">${categoryLabel(post).toUpperCase()}</p><h3>${post.title}</h3><p class="description">${teaser}</p>${hint ? `<p class="archive-hint">${hint}</p>` : ''}</div></div></a>`;
  }).join('');
  archive.querySelectorAll('.archive-item.has-photo').forEach((el) => flipObserver.observe(el));
};

const applyFilter = (filter) => {
  activeFilter = filter;
  buildFilterRow();
  renderArchive(filter);
};

if (archive) {
  fetch('/data/posts.json')
    .then((response) => {
      if (!response.ok) throw new Error('Archiv nicht verfügbar');
      return response.json();
    })
    .then((data) => {
      posts = data;
      countCategories();
      applyFilter(counts[pendingJump] ? pendingJump : 'all');
      pendingJump = '';
    })
    .catch(() => {
      archive.innerHTML = '<p class="archive-status">Das Archiv konnte gerade nicht geladen werden.</p>';
    });

  filterRow.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) applyFilter(button.dataset.filter);
  });
}

document.addEventListener('click', (event) => {
  const flipCard = event.target.closest('.recipe-card');
  const photoCard = event.target.closest('.archive-item.has-photo');
  const card = flipCard || photoCard;
  if (!card || isMobileLayout() || window.matchMedia('(hover: hover)').matches) return;
  const revealClass = flipCard ? 'flipped' : 'revealed';
  if (!card.classList.contains(revealClass)) {
    event.preventDefault();
    card.classList.add(revealClass);
  }
});


// Category links elsewhere on the page (strip, menu, search) jump to the archive
// and apply their category as the active filter. A click that lands before the
// archive has loaded is remembered and applied once it does.
document.querySelectorAll('[data-jump]').forEach((link) => link.addEventListener('click', () => {
  const wanted = link.dataset.jump;
  if (!posts.length) pendingJump = wanted;
  else if (counts[wanted]) applyFilter(wanted);
  menuDialog.open && closeMenu();
  dialog.open && dialog.close();
}));
