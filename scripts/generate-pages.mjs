// Migrates plantiness.com WordPress posts/pages into static pages using the new site design.
// Usage: node scripts/generate-pages.mjs
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WP = "https://plantiness.com/wp-json/wp/v2";

// Category ids on the source site (matches the classification already used in script.js).
const CAT_RECIPE = 221;
const CAT_TIPS = 230;
const CATEGORY_LABEL = { recipe: "REZEPTE", food: "ERNÄHRUNG & WISSEN", tips: "TIPPS" };
const CATEGORY_ANCHOR = { recipe: "rezepte", food: "wissen", tips: "wissen" };

// Static pages worth migrating. Excludes WP theme-demo/empty pages (ids 154, 306).
const PAGE_IDS = [938, 844, 838, 311, 1542, 1538];

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchAllPosts() {
  const posts = await fetchJSON(
    `${WP}/posts?per_page=100&_fields=id,slug,link,title,date,categories,content,excerpt,featured_media`
  );
  return posts;
}

async function fetchPages(ids) {
  return Promise.all(
    ids.map((id) =>
      fetchJSON(`${WP}/pages/${id}?_fields=id,slug,link,title,content`)
    )
  );
}

const mediaCache = new Map();
async function featuredImage(mediaId) {
  if (!mediaId) return null;
  if (mediaCache.has(mediaId)) return mediaCache.get(mediaId);
  try {
    const media = await fetchJSON(
      `${WP}/media/${mediaId}?_fields=alt_text,media_details,source_url`
    );
    const sizes = media.media_details?.sizes || {};
    const url =
      sizes["uku-featured-big"]?.source_url ||
      sizes.large?.source_url ||
      media.source_url;
    const result = { url, alt: media.alt_text || "" };
    mediaCache.set(mediaId, result);
    return result;
  } catch {
    return null;
  }
}

function classify(post) {
  if (post.categories.includes(CAT_RECIPE)) return "recipe";
  if (post.categories.includes(CAT_TIPS)) return "tips";
  return "food";
}

const decode = (str) =>
  str
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "’")
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ");

// Strips WordPress editor cruft that doesn't fit the new design: inline color
// spans, affiliate ad iframes, empty paragraphs, WP comment markers.
function cleanContent(html) {
  return html
    .replace(/<!--\s*more\s*-->/g, "")
    .replace(/<p>\s*<center>[\s\S]*?<\/center>\s*<\/p>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    // Pinterest's old "Save" bookmarklet injected floating <span> buttons
    // (marker: its signature z-index 8675309) that got saved directly into
    // the post content next to nearly every image — pure UI cruft, not text.
    .replace(/<span[^>]*z-index:\s*8675309[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<span[^>]*>/gi, "")
    .replace(/<\/span>/gi, "")
    .replace(/<p>(\s|&nbsp;)*<\/p>/gi, "")
    .replace(/ style="[^"]*"/gi, "")
    .replace(/ class="wp-block-heading"/gi, "")
    // Inline WP media images embedded in the post body. The old WordPress
    // host no longer serves /wp-content (plantiness.com now points at this
    // static site, whose edge blocks that path), so these would just be
    // broken images — drop them rather than link-rot every post.
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, (m) => (/wp-content/i.test(m) ? "" : m))
    .replace(/<p>\s*<img[^>]*wp-content[^>]*\/?>\s*<\/p>/gi, "")
    .replace(/http:\/\/plantiness\.com\//g, "/")
    .replace(/https:\/\/plantiness\.com\//g, "/")
    .trim();
}

function splitBlocks(html) {
  const re = /<(h2|h3|p|ul|ol)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
  return html.match(re) || [];
}

function textOf(block) {
  return decode(block.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim());
}

function listItems(block) {
  return [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) =>
    decode(m[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim())
  );
}

// Heuristic split of recipe HTML into intro / ingredient groups / steps, based
// on the heading wording the original site consistently used. Anything after
// the steps that doesn't fit (Tipps, Aufbewahrung, …) is kept as a trailing
// "extra" block rather than discarding the whole parse. Falls back to null
// (render as plain prose) only when no ingredients or no steps were found.
function parseRecipe(html) {
  const blocks = splitBlocks(html);
  const intro = [];
  const groups = [];
  const steps = [];
  const extra = [];
  let mode = "intro";
  let currentGroup = null;
  let extraTitle = null;

  for (const block of blocks) {
    const tag = block.match(/^<(\w+)/)[1];
    const text = textOf(block);
    if (tag === "h2" || tag === "h3") {
      if (/zubereitung|anleitung|so geht|schritt/i.test(text)) {
        mode = "steps";
        continue;
      }
      if (/brauchst|zutaten|d[au] brauchst/i.test(text)) {
        mode = "ingredients";
        currentGroup = { title: text.replace(/:$/, ""), items: [] };
        groups.push(currentGroup);
        continue;
      }
      if (mode === "intro") continue; // unrelated heading before the recipe proper, ignore
      mode = "extra";
      extraTitle = text;
      extra.push({ title: extraTitle, items: [] });
      continue;
    }
    if (mode === "intro" && tag === "p") {
      intro.push(block);
    } else if (mode === "ingredients") {
      if (tag === "ul" || tag === "ol") {
        currentGroup.items.push(...listItems(block));
      } else if (tag === "p" && text) {
        currentGroup.items.push(text);
      }
    } else if (mode === "steps") {
      if (tag === "ol" || tag === "ul") {
        steps.push(...listItems(block));
      } else if (tag === "p" && text) {
        steps.push(text.replace(/^\d+[.)]\s*/, ""));
      }
    } else if (mode === "extra") {
      const bucket = extra[extra.length - 1];
      if (tag === "ul" || tag === "ol") bucket.items.push(...listItems(block));
      else if (text) bucket.items.push(text);
    }
  }

  if (!groups.length || !steps.length) return null;
  return { intro: intro.join("\n"), groups, steps, extra: extra.filter((e) => e.items.length) };
}

function pageHead(title, description) {
  return `<meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeAttr(description)}" />
    <title>${escapeHtml(title)} — Plantiness</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Playfair+Display:ital,wght@0,600;0,700;0,800;1,600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/styles.css" />`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(decode(str).replace(/<[^>]+>/g, "").slice(0, 155));
}

function siteHeader() {
  return `<div class="announcement">Kostenloses E-Book: <a href="/#newsletter">7 Tage einfach vegan</a><button aria-label="Hinweis schließen">×</button></div>
    <header class="site-header">
      <a class="logo" href="/" aria-label="Plantiness Startseite">plantiness<span>.</span></a>
      <nav aria-label="Hauptnavigation">
        <a href="/#rezepte">Rezepte</a><a href="/#wissen">Wissen</a><a href="/#ueber-uns">Über uns</a>
      </nav>
      <div class="header-actions"><button class="search" aria-label="Suche öffnen">⌕</button><a class="pill small" href="/#newsletter">Newsletter <span>↗</span></a></div>
      <button class="menu" aria-label="Menü öffnen" aria-expanded="false"><i></i><i></i></button>
    </header>`;
}

function siteFooter() {
  return `<footer><a class="logo" href="/">plantiness<span>.</span></a><p>gesund vegan genießen,<br />jeden Tag ein bisschen mehr.</p><div class="footer-links"><a href="/#rezepte">Rezepte</a><a href="/#wissen">Wissen</a><a href="https://www.instagram.com/plantiness/">Instagram</a><a href="/impressum/">Impressum</a></div><span class="copyright">© 2026 Plantiness</span></footer>
    <dialog class="menu-dialog"><div class="menu-panel"><button class="close-menu" aria-label="Menü schließen">×</button><a class="logo" href="/">plantiness<span>.</span></a><p class="eyebrow">MENÜ</p><nav><a href="/#rezepte">Rezepte <span>→</span></a><a href="/#wissen">Ernährung & Wissen <span>→</span></a><a href="/#original-archiv">Alle Beiträge <span>→</span></a><a href="/#newsletter">Newsletter <span>→</span></a></nav><div class="menu-categories"><a href="/#rezepte">Frühstück</a><a href="/#rezepte">Suppen</a><a href="/#rezepte">Dips & Saucen</a><a href="/#rezepte">Naschkatzen</a></div></div></dialog>
    <dialog class="search-dialog"><button class="close-search" aria-label="Suche schließen">×</button><p class="eyebrow">WONACH SUCHST DU?</p><input autofocus placeholder="Rezepte, Zutaten, Themen …" /><div>Beliebt: <a href="#">Pasta</a> · <a href="#">Frühstück</a> · <a href="#">Schnell & einfach</a></div></dialog>
    <script src="/script.js"></script>`;
}

function relatedSection(current, all) {
  const pool = all.filter((p) => p !== current && p.kind === current.kind);
  const picks = pool.sort(() => Math.random() - 0.5).slice(0, 3);
  if (!picks.length) return "";
  return `<section class="related section related-section">
      <div class="section-heading"><div><p class="eyebrow">WEITERLESEN</p><h2>Das könnte dir<br /><em>auch schmecken.</em></h2></div></div>
      <div class="recipe-grid">
        ${picks
          .map(
            (p) => `<article class="recipe-card"><a href="/${p.slug}/"><div class="flip-card"><div class="flip-inner"><div class="image-frame"><img src="${p.image?.url || FALLBACK_IMG}" alt="${escapeAttr(p.image?.alt || p.title)}" /></div><div class="flip-back"><p class="tag">${CATEGORY_LABEL[p.kind]}</p><h3>${escapeHtml(p.title)}</h3></div></div></div></a></article>`
          )
          .join("")}
      </div>
    </section>`;
}

const FALLBACK_IMG =
  "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=1200&q=80";

function pageShell({ title, description, body }) {
  return `<!doctype html>
<html lang="de">
  <head>
    ${pageHead(title, description)}
  </head>
  <body>
    ${siteHeader()}
    <main>
      ${body}
    </main>
    ${siteFooter()}
  </body>
</html>
`;
}

function breadcrumb(kind, title) {
  const anchor = CATEGORY_ANCHOR[kind];
  return `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">plantiness</a><span>/</span><a href="/#${anchor}">${CATEGORY_LABEL[kind]}</a><span>/</span><span>${escapeHtml(title)}</span></nav>`;
}

function dateLabel(iso) {
  return new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(new Date(iso));
}

function renderRecipePost(post, all) {
  const parsed = parseRecipe(post.cleanBody);
  const img = post.image?.url || FALLBACK_IMG;
  const imgAlt = post.image?.alt || post.title;

  if (!parsed) return renderArticlePost(post, all);

  const ingredientsHtml = parsed.groups
    .map(
      (g) => `<div class="post-ingredients-group"><h3>${escapeHtml(g.title)}</h3><ul>${g.items
        .map((i) => `<li>${escapeHtml(i)}</li>`)
        .join("")}</ul></div>`
    )
    .join("");

  const body = `<article class="post-page" data-kind="recipe">
        <div class="post-hero">
          ${breadcrumb("recipe", post.title)}
          <p class="tag">REZEPTE · ${dateLabel(post.date)}</p>
          <h1>${escapeHtml(post.title)}</h1>
        </div>
        <div class="post-image"><img src="${img}" alt="${escapeAttr(imgAlt)}" /></div>
        <div class="post-layout has-ingredients">
          <div class="post-body">${parsed.intro}</div>
          <aside class="post-ingredients"><h2>Zutaten</h2>${ingredientsHtml}</aside>
        </div>
        <div class="post-steps">
          <h2>Zubereitung</h2>
          <ol>${parsed.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
        </div>
        ${
          parsed.extra.length
            ? `<div class="post-layout"><div class="post-body">${parsed.extra
                .map(
                  (e) =>
                    `<h3>${escapeHtml(e.title)}</h3><p>${e.items.map(escapeHtml).join(" ")}</p>`
                )
                .join("")}</div></div>`
            : ""
        }
        <p class="post-source">Ursprünglich veröffentlicht auf <a href="${post.link}">plantiness.com</a>.</p>
      </article>
      ${relatedSection(post, all)}`;

  return pageShell({
    title: post.title,
    description: textOf(cleanContent(post.excerpt || post.cleanBody)).slice(0, 155),
    body,
  });
}

function renderArticlePost(post, all) {
  const img = post.image?.url || FALLBACK_IMG;
  const imgAlt = post.image?.alt || post.title;
  const body = `<article class="post-page" data-kind="${post.kind}">
        <div class="post-hero">
          ${breadcrumb(post.kind, post.title)}
          <p class="tag">${CATEGORY_LABEL[post.kind]} · ${dateLabel(post.date)}</p>
          <h1>${escapeHtml(post.title)}</h1>
        </div>
        <div class="post-image"><img src="${img}" alt="${escapeAttr(imgAlt)}" /></div>
        <div class="post-layout">
          <div class="post-body">${post.cleanBody}</div>
        </div>
        <p class="post-source">Ursprünglich veröffentlicht auf <a href="${post.link}">plantiness.com</a>.</p>
      </article>
      ${relatedSection(post, all)}`;

  return pageShell({
    title: post.title,
    description: textOf(cleanContent(post.excerpt || post.cleanBody)).slice(0, 155),
    body,
  });
}

function renderStaticPage(page) {
  let body = page.cleanBody;
  // The contact page embeds a WordPress Contact Form 7 form, which can't
  // function on a static host without a backend. Swap it for a mailto CTA.
  if (page.slug === "kontakt") {
    body = body.replace(/<div class="wpcf7[\s\S]*$/, "");
    body += `<p><a class="pill" href="mailto:hallo@plantiness.com">Schreib mir <span>→</span></a></p>`;
  }
  const html = `<article class="post-page static-page" data-kind="page">
        <div class="post-hero">
          <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">plantiness</a><span>/</span><span>${escapeHtml(page.title)}</span></nav>
          <h1>${escapeHtml(page.title)}</h1>
        </div>
        <div class="post-layout">
          <div class="post-body">${body}</div>
        </div>
      </article>`;
  return pageShell({
    title: page.title,
    description: textOf(page.cleanBody).slice(0, 155),
    body: html,
  });
}

async function writePage(slug, html) {
  const dir = path.join(ROOT, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), html, "utf8");
}

async function main() {
  console.log("Fetching posts…");
  const rawPosts = await fetchAllPosts();
  console.log(`Fetching ${rawPosts.length} featured images…`);
  const posts = [];
  for (const raw of rawPosts) {
    const image = await featuredImage(raw.featured_media);
    posts.push({
      slug: raw.slug,
      link: raw.link,
      title: decode(raw.title.rendered),
      date: raw.date,
      kind: classify(raw),
      excerpt: raw.excerpt.rendered,
      cleanBody: cleanContent(raw.content.rendered),
      image,
    });
  }

  console.log("Fetching static pages…");
  const rawPages = await fetchPages(PAGE_IDS);
  const pages = rawPages.map((raw) => ({
    slug: raw.slug,
    title: decode(raw.title.rendered),
    cleanBody: cleanContent(raw.content.rendered),
  }));

  console.log("Rendering & writing pages…");
  for (const post of posts) {
    const html =
      post.kind === "recipe" ? renderRecipePost(post, posts) : renderArticlePost(post, posts);
    await writePage(post.slug, html);
  }
  for (const page of pages) {
    await writePage(page.slug, renderStaticPage(page));
  }

  console.log(`Done: ${posts.length} posts + ${pages.length} pages written.`);

  // Emit a manifest the homepage's archive script can consume without
  // hitting the old WordPress API live on every visit. Includes enough per
  // post (image, plus ingredients or an excerpt) for the archive grid's
  // flip cards to render without fetching each post page.
  const manifest = posts
    .map((p) => {
      const parsed = p.kind === "recipe" ? parseRecipe(p.cleanBody) : null;
      const ingredients = parsed
        ? parsed.groups.flatMap((g) => g.items).slice(0, 3)
        : [];
      const entry = { slug: p.slug, title: p.title, date: p.date, kind: p.kind, image: p.image?.url || FALLBACK_IMG };
      if (ingredients.length) entry.ingredients = ingredients;
      else entry.excerpt = textOf(cleanContent(p.excerpt || p.cleanBody)).slice(0, 155);
      return entry;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  await mkdir(path.join(ROOT, "data"), { recursive: true });
  await writeFile(
    path.join(ROOT, "data", "posts.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
  console.log("Wrote data/posts.json manifest.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
