const dialog = document.querySelector('.search-dialog');
const menuDialog = document.querySelector('.menu-dialog');
const archive = document.querySelector('.archive-grid');
let posts = [];

document.querySelector('.search').addEventListener('click', () => dialog.showModal());
document.querySelector('.close-search').addEventListener('click', () => dialog.close());
document.querySelector('.menu').addEventListener('click', () => menuDialog.showModal());
document.querySelector('.close-menu').addEventListener('click', () => menuDialog.close());
document.querySelectorAll('.menu-dialog nav a').forEach((link) => link.addEventListener('click', () => menuDialog.close()));

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

const renderArchive = (filter = 'all') => {
  const visible = filter === 'all' ? posts : posts.filter((post) => (post.cats || []).includes(filter));
  archive.innerHTML = visible.map((post) => {
    // The teaser is the post's own excerpt; a recipe's first ingredients are
    // kept as a second line, since they say a lot about the dish at a glance.
    const teaser = post.excerpt || '';
    const hint = (post.ingredients || [])
      .filter((item) => item.length <= 42) // skip the odd whole-dressing-recipe entry
      .slice(0, 3)
      .join(' · ');
    return `<a class="archive-item has-photo" href="/${post.slug}/"><div class="flip-inner-v"><div class="archive-photo"><img src="${post.image}" alt="${post.title}" loading="lazy" /></div><div class="archive-overlay"><p class="tag">${categoryLabel(post).toUpperCase()}</p><h3>${post.title}</h3><p class="description">${teaser}</p>${hint ? `<p class="archive-hint">${hint}</p>` : ''}</div></div></a>`;
  }).join('');
  archive.querySelectorAll('.archive-item.has-photo').forEach((el) => flipObserver.observe(el));
};
fetch('/data/posts.json')
  .then((response) => {
    if (!response.ok) throw new Error('Archiv nicht verfügbar');
    return response.json();
  })
  .then((data) => {
    posts = data;
    renderArchive();
  })
  .catch(() => {
    archive.innerHTML = '<p class="archive-status">Das Archiv konnte gerade nicht geladen werden.</p>';
  });
document.querySelectorAll('.archive-filter button').forEach((button) => button.addEventListener('click', () => {
  document.querySelector('.archive-filter .active').classList.remove('active');
  button.classList.add('active');
  renderArchive(button.dataset.filter);
}));

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
// and apply their category as the active filter.
document.querySelectorAll('[data-jump]').forEach((link) => link.addEventListener('click', () => {
  const target = [...document.querySelectorAll('.archive-filter button')]
    .find((button) => button.dataset.filter === link.dataset.jump);
  if (target) target.click();
  menuDialog.open && menuDialog.close();
  dialog.open && dialog.close();
}));
