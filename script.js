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

const decode = (html) => {
  const el = document.createElement('textarea');
  el.innerHTML = html;
  return el.value;
};
const categoryFor = (post) => {
  if (post.categories.includes(221)) return 'recipe';
  if (post.categories.includes(230)) return 'tips';
  return 'food';
};
const categoryLabel = (post) => ({ recipe: 'REZEPTE', food: 'ERNÄHRUNG & WISSEN', tips: 'TIPPS' })[categoryFor(post)];
const renderArchive = (filter = 'all') => {
  const visible = filter === 'all' ? posts : posts.filter((post) => categoryFor(post) === filter);
  archive.innerHTML = visible.map((post) => `<a class="archive-item" href="${post.link}" target="_blank" rel="noopener"><div><p class="tag">${categoryLabel(post)}</p><h3>${decode(post.title.rendered)}</h3></div><span class="archive-meta">${new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(new Date(post.date))} &nbsp; →</span></a>`).join('');
};
fetch('https://plantiness.com/wp-json/wp/v2/posts?per_page=100&_fields=date,link,title,categories')
  .then((response) => {
    if (!response.ok) throw new Error('Archiv nicht verfügbar');
    return response.json();
  })
  .then((data) => {
    posts = data;
    renderArchive();
  })
  .catch(() => {
    archive.innerHTML = '<p class="archive-status">Das Archiv konnte gerade nicht geladen werden. <a href="https://plantiness.com/">Zum Original-Archiv →</a></p>';
  });
document.querySelectorAll('.archive-filter button').forEach((button) => button.addEventListener('click', () => {
  document.querySelector('.archive-filter .active').classList.remove('active');
  button.classList.add('active');
  renderArchive(button.dataset.filter);
}));

const savedTheme = localStorage.getItem('plantiness-theme') || 'editorial';
const setTheme = (theme) => {
  document.body.dataset.theme = theme === 'editorial' ? '' : theme;
  document.querySelectorAll('.design-switcher button').forEach((button) => button.classList.toggle('active', button.dataset.theme === theme));
  localStorage.setItem('plantiness-theme', theme);
};
setTheme(savedTheme);
document.querySelectorAll('.design-switcher button').forEach((button) => button.addEventListener('click', () => setTheme(button.dataset.theme)));
