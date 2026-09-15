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

// The filter row carries the archive's whole taxonomy. "Rezepte" and "Ernährung"
// are the two roots it actually hangs off — the header nav carries exactly these
// two — and the head row leads with them plus the three the homepage strip
// promotes, which are Rezepte's own favourites. A hairline separates that row
// from the subcategories behind it: the recipe side first, then Ernährung's.
const ROOT_CATEGORIES = ['Rezepte', 'Ernährung'];
const HEAD_CATEGORIES = ['Rezepte', 'Ernährung', 'Sattmacher', 'Für Naschkatzen', 'Frühstück'];
// The rest of the row, in tree order: each head topic's own subcategories follow
// it, so scanning left to right walks the taxonomy rather than a flat list.
const CATEGORY_ORDER = [
  'Rezepte', 'Suppen', 'Vorspeisen', 'Raw Food', 'Aufstriche, Dips & Saucen', 'Snacks',
  'Sattmacher', 'Warme Küche', 'Zum Mitnehmen',
  'Für Naschkatzen', 'Kuchen & Gebäck', 'Eis & Desserts',
  'Frühstück', 'Süßer Start', 'Herzhafter Start',
  'Ernährung', 'Nährstoffe', 'Lebensmittel', 'Tipps', 'Warum vegan?', 'Ernährungsberatung',
];
const CATEGORY_ICONS = {
  'Rezepte': '☘', 'Frühstück': '☀', 'Suppen': '◎', 'Vorspeisen': '◈',
  'Sattmacher': '♨', 'Raw Food': '✿', 'Für Naschkatzen': '♥',
  'Aufstriche, Dips & Saucen': '❁', 'Snacks': '✱',
  'Ernährung': '✽', 'Nährstoffe': '✧', 'Lebensmittel': '❀',
  'Tipps': '❖', 'Warum vegan?': '✤', 'Ernährungsberatung': '✺',
};
const STRIP_ICONS = Object.fromEntries([...document.querySelectorAll('.category-strip a[data-jump]')]
  .map((link) => [link.dataset.jump, link.querySelector('.category-icon')?.textContent.trim()]));
const ALL_TILE = { name: 'all', label: 'Alle Beiträge', icon: '✦' };
const iconFor = (name) => STRIP_ICONS[name] || CATEGORY_ICONS[name] || ALL_TILE.icon;
let counts = {};
let parentOf = {};
let pendingJump = '';
let activeFilter = 'all';
let hoveredHead = '';

const countCategories = () => {
  counts = {};
  posts.forEach((post) => (post.cats || []).forEach((cat) => (counts[cat] = (counts[cat] || 0) + 1)));
};

// Which head topic a subcategory hangs off is not a list to keep in sync: it is
// in the posts. Every "Suppen" post is also a "Rezepte" post, every "Kuchen &
// Gebäck" post a "Für Naschkatzen" one — so a subcategory belongs to whichever
// head topic most of its own posts carry as well. "Kuchen & Gebäck" sits inside
// Rezepte just as completely, so an equal overlap goes to the narrower of the
// two: the innermost head topic that still holds the whole subcategory.
const findParents = () => {
  parentOf = {};
  Object.keys(counts).forEach((name) => {
    if (ROOT_CATEGORIES.includes(name)) return;
    const shared = (head) => posts.filter((post) => (post.cats || []).includes(name) && (post.cats || []).includes(head)).length;
    const [head, overlap] = HEAD_CATEGORIES.filter((candidate) => candidate !== name)
      .map((candidate) => [candidate, shared(candidate)])
      .sort((a, b) => b[1] - a[1] || counts[a[0]] - counts[b[0]])[0];
    if (overlap > counts[name] / 2) parentOf[name] = head;
  });
};

// Pointing at or selecting a head topic strokes every subcategory that hangs off
// it in clay — and a selected subcategory strokes the head topic it came from —
// so the tree behind the flat row of pills is visible while you scan it.
// A phone cannot carry sixteen pills without becoming a wall, so there the row
// pivots: the subcategories on show are the ones under the head topic in play,
// and picking "Alle Beiträge" folds them away again. Above 760px the classes are
// inert — the whole taxonomy stays on screen.
const hasBranch = (name) => Object.values(parentOf).includes(name);

const pivot = () => {
  const open = hasBranch(activeFilter) ? activeFilter : parentOf[activeFilter] || '';
  const rest = filterRow.querySelector('.filter-group.rest');
  if (!rest) return;
  let shown = 0;
  rest.querySelectorAll('button').forEach((button) => {
    const head = parentOf[button.dataset.filter];
    const off = Boolean(head) && head !== open;
    button.classList.toggle('off-pivot', off);
    if (!off) shown += 1;
  });
  filterRow.classList.toggle('pivot-closed', shown === 0);
};

const paintRelations = () => {
  const head = hoveredHead || (hasBranch(activeFilter) ? activeFilter : '');
  const headOfActive = hoveredHead ? '' : parentOf[activeFilter];
  filterRow.classList.toggle('has-head', head !== '');
  filterRow.querySelectorAll('button').forEach((button) => {
    const name = button.dataset.filter;
    const related = (head !== '' && parentOf[name] === head) || name === headOfActive;
    button.classList.toggle('related', related && name !== activeFilter);
  });
};

// Only the leading pills carry an icon — it is what marks the main tier apart,
// and sixteen clay glyphs in a row of pills would be noise.
const pill = (tile) => `<button data-filter="${escapeHtml(tile.name)}">${tile.icon ? `<span class="category-icon" aria-hidden="true">${tile.icon}</span>` : ''}<span>${escapeHtml(tile.label)}</span><b>${tile.count}</b></button>`;

// Picking a head topic runs its branch open: the subcategories under it rise
// into place one after the other, so it is visible — not just readable — which
// pills belong to it. Hovering only strokes them; the run is for the click.
const openBranch = () => {
  const head = hasBranch(activeFilter) ? activeFilter : parentOf[activeFilter] || '';
  const pills = [...filterRow.querySelectorAll('.filter-group.rest button')];
  pills.forEach((button) => button.classList.remove('opening'));
  if (!head || reduceMotion.matches) return;
  void filterRow.offsetWidth; // let the browser notice the class is gone
  pills.filter((button) => parentOf[button.dataset.filter] === head)
    .forEach((button, index) => {
      button.style.setProperty('--n', index);
      button.classList.add('opening');
    });
};

const buildFilterRow = () => {
  // Every category that is actually on a post gets a pill, so a jump from the
  // menu or the search sheet always lands on one that is already in the row.
  const rank = (name) => CATEGORY_ORDER.indexOf(name) + 1 || CATEGORY_ORDER.length + 1;
  const named = Object.keys(counts).sort((a, b) => rank(a) - rank(b) || counts[b] - counts[a]);
  const main = [{ ...ALL_TILE, count: posts.length },
    ...HEAD_CATEGORIES.filter((name) => counts[name]).map((name) => ({ name, label: name, icon: iconFor(name), count: counts[name] }))];
  const rest = named.filter((name) => !HEAD_CATEGORIES.includes(name))
    .map((name) => ({ name, label: name, icon: '', count: counts[name] }));
  // As long as the same pills are on show, only the active one is re-marked —
  // the buttons stay put so the ink fill can transition across rather than blink
  // into place on a rebuilt row.
  const signature = [...main, ...rest].map((tile) => tile.name).join('|');
  if (filterRow.dataset.tiles !== signature) {
    filterRow.dataset.tiles = signature;
    filterRow.innerHTML = `<div class="filter-group main">${main.map(pill).join('')}</div>`
      + `<div class="filter-group rest">${rest.map(pill).join('')}</div>`;
  }
  filterRow.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === activeFilter);
    button.setAttribute('aria-pressed', button.dataset.filter === activeFilter);
  });
  paintRelations();
  pivot();
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
  const previous = activeFilter;
  activeFilter = filter;
  buildFilterRow();
  if (filter !== previous) openBranch();
  renderArchive(filter);
};

if (archive) {
  // `no-cache` revalidates instead of trusting the browser's heuristic freshness:
  // the manifest has an old Last-Modified, so a plain fetch can serve a copy
  // from weeks ago and the whole filter row is then built from stale categories.
  fetch('/data/posts.json', { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error('Archiv nicht verfügbar');
      return response.json();
    })
    .then((data) => {
      posts = data;
      countCategories();
      findParents();
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

  // Moving onto any other pill, or off the row entirely, drops the preview.
  const trackHead = (event) => {
    const button = event.target.closest('button');
    const head = button && hasBranch(button.dataset.filter) ? button.dataset.filter : '';
    setHead(head);
  };
  const setHead = (head) => {
    if (head === hoveredHead) return;
    hoveredHead = head;
    paintRelations();
  };
  filterRow.addEventListener('pointerover', trackHead);
  filterRow.addEventListener('focusin', trackHead);
  filterRow.addEventListener('pointerleave', () => setHead(''));
  filterRow.addEventListener('focusout', () => setHead(''));
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
