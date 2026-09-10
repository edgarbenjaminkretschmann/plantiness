const dialog = document.querySelector('.search-dialog');
const menuDialog = document.querySelector('.menu-dialog');
const archive = document.querySelector('.archive-grid');
let posts = [];

document.querySelector('.search').addEventListener('click', () => dialog.showModal());
document.querySelector('.close-search').addEventListener('click', () => dialog.close());
document.querySelector('.menu').addEventListener('click', () => menuDialog.showModal());
document.querySelector('.close-menu').addEventListener('click', () => menuDialog.close());
document.querySelectorAll('.menu-dialog nav a').forEach((link) => link.addEventListener('click', () => menuDialog.close()));
document.querySelector('.announcement button').addEventListener('click', (event) => event.currentTarget.parentElement.remove());
document.querySelector('.newsletter form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.textContent = 'Danke!';
  button.disabled = true;
});

const categoryLabel = { recipe: 'REZEPTE', food: 'ERNÄHRUNG & WISSEN', tips: 'TIPPS' };

// The archive grid can hold 50+ flip cards. Giving every one of them a live
// 3D transform context (perspective/preserve-3d) at once is expensive enough
// to freeze the page, so only cards near the viewport get promoted to 3D —
// this bounds how many are "flippable" at a time without limiting the effect.
const flipObserver = new IntersectionObserver(
  (entries) => entries.forEach((entry) => entry.target.classList.toggle('in-view', entry.isIntersecting)),
  { rootMargin: '200px 0px' }
);

const renderArchive = (filter = 'all') => {
  const visible = filter === 'all' ? posts : posts.filter((post) => post.kind === filter);
  archive.innerHTML = visible.map((post) => {
    const back = post.ingredients?.length
      ? post.ingredients.join(' · ')
      : post.excerpt || '';
    return `<a class="archive-item has-photo" href="/${post.slug}/"><div class="flip-inner-v"><div class="archive-photo"><img src="${post.image}" alt="${post.title}" loading="lazy" /></div><div class="archive-overlay"><p class="tag">${categoryLabel[post.kind]}</p><h3>${post.title}</h3><p class="description">${back}</p></div></div></a>`;
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
  if (!card || window.matchMedia('(hover: hover)').matches) return;
  const revealClass = flipCard ? 'flipped' : 'revealed';
  if (!card.classList.contains(revealClass)) {
    event.preventDefault();
    card.classList.add(revealClass);
  }
});

const savedTheme = localStorage.getItem('plantiness-theme') || 'editorial';
const setTheme = (theme) => {
  document.body.dataset.theme = theme === 'editorial' ? '' : theme;
  document.querySelectorAll('.design-switcher button').forEach((button) => button.classList.toggle('active', button.dataset.theme === theme));
  localStorage.setItem('plantiness-theme', theme);
};
setTheme(savedTheme);
document.querySelectorAll('.design-switcher button').forEach((button) => button.addEventListener('click', () => setTheme(button.dataset.theme)));
