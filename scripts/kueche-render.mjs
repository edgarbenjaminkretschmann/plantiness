// Page rendering for the /new/ subsection. Consumes the structured recipes
// produced by kueche-build.mjs and writes the static pages.
//
// Every page is complete without JavaScript: quantities are rendered at the
// recipe's own portion count, and kueche.js only takes over the scaling.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Safe to drop inside a <script> block: the closing-tag sequence is neutered.
const jsonScript = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

const FONTS =
  "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Playfair+Display:ital,wght@0,600;0,700;0,800;1,600&display=swap";

function head(title, description, canonical) {
  return [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />',
    `<meta name="description" content="${escHtml(String(description).slice(0, 180))}" />`,
    `<link rel="canonical" href="${escHtml(canonical)}" />`,
    `<title>${escHtml(title)}</title>`,
    '<link rel="preconnect" href="https://fonts.googleapis.com" />',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
    `<link href="${FONTS}" rel="stylesheet" />`,
    '<link rel="stylesheet" href="/new/kueche.css" />',
  ].join("\n    ");
}

// Every page under /new carries the same switch, thrown to the Küche side.
// Flicking it leaves for the matching page on the normal site: a recipe goes to
// its own post, everything else to the homepage.
const chrome = (websiteHref) => `<header class="k-header">
      <div class="k-header-inner">
        <a class="k-logo" href="/new/">plantiness<span>.</span><b>K&uuml;che</b></a>
        <nav>
          <a class="k-switch" href="${websiteHref}" aria-label="Zur normalen Website wechseln" title="Zur normalen Website wechseln">
            <span class="k-switch-track" aria-hidden="true"><i></i></span>
            <span class="k-switch-label"><b>K&uuml;che</b><em>Website</em></span>
          </a>
          <a class="cart-link" href="/new/einkaufsliste/">Einkaufsliste <span class="cart-count" data-empty="1"></span></a>
        </nav>
      </div>
    </header>`;

const FOOTER = `<footer class="k-footer">
      <div class="wrap">
        <a href="/">plantiness.com</a>
        <a href="/new/">Alle Rezepte</a>
        <a href="/new/einkaufsliste/">Einkaufsliste</a>
        <a href="/ueber-plantiness/">&Uuml;ber Plantiness</a>
        <a href="/impressum/">Impressum</a>
        <p class="note">Plantiness K&uuml;che &mdash; Portionsrechner, Kochmodus und Einkaufsliste f&uuml;r die Rezepte von
          plantiness.com. Mengen werden automatisch umgerechnet und sinnvoll gerundet; beim Kochen bitte mit
          Augenma&szlig; nachjustieren.</p>
      </div>
    </footer>`;

const page = (pageKind, title, description, canonical, body, websiteHref = "/") =>
  `<!doctype html>
<html lang="de">
  <head>
    ${head(title, description, canonical)}
  </head>
  <body data-page="${pageKind}">
    ${chrome(websiteHref)}
${body}
    ${FOOTER}
    <script src="/new/kueche.js"></script>
  </body>
</html>
`;

/* ------------------------------------------------------------ index page */

function renderIndex(list) {
  const ingredients = list.reduce((n, r) => n + r.groups.reduce((m, g) => m + g.items.length, 0), 0);
  const steps = list.reduce((n, r) => n + r.steps.length, 0);

  const body = `    <main>
      <section class="k-hero">
        <div class="wrap">
          <p class="eyebrow">PLANTINESS K&Uuml;CHE</p>
          <h1>Kochen, nicht<br /><em>nur lesen.</em></h1>
          <p class="lead">Jedes Rezept mit Portionsrechner, Schritt-f&uuml;r-Schritt-Kochmodus und Einkaufsliste.
            Stell die Portionen ein &mdash; alle Mengen rechnen sich mit.</p>
          <p class="stats"><span><b>${list.length}</b> Rezepte</span><span><b>${ingredients}</b> Zutaten</span><span><b>${steps}</b> Schritte</span><span>Suche auch nach Zutaten</span></p>
        </div>
      </section>

      <div class="wrap">
        <div class="k-tools">
          <div class="search-field">
            <input id="search" type="search" placeholder="Rezept oder Zutat suchen &hellip;" autocomplete="off" aria-label="Rezepte und Zutaten durchsuchen" />
            <span class="icon" aria-hidden="true">&#9906;</span>
          </div>
          <p class="search-hint">Tipp: Suche nach einer Zutat, z.&nbsp;B. &bdquo;Cashew&ldquo;, &bdquo;Gr&uuml;nkohl&ldquo; oder &bdquo;Kichererbsen&ldquo;.</p>
          <div class="chips" id="chips" role="group" aria-label="Nach Kategorie filtern"></div>
        </div>
        <div class="recipe-grid" id="recipe-grid" aria-live="polite"></div>
      </div>
    </main>`;

  return page(
    "index",
    "Plantiness Küche — Rezepte mit Portionsrechner & Kochmodus",
    "Alle veganen Rezepte von Plantiness mit Portionsrechner, Kochmodus und Einkaufsliste.",
    "https://plantiness.com/new/",
    body
  );
}

/* --------------------------------------------------------- recipe pages */

const GLYPHS = [
  [0.125, "⅛"],
  [0.25, "¼"],
  [1 / 3, "⅓"],
  [0.5, "½"],
  [2 / 3, "⅔"],
  [0.75, "¾"],
];

// Mirrors fmtNumber() in kueche.js: weights and volumes never take a vulgar
// fraction, only counts and spoon measures do.
const DECIMAL_UNITS = new Set(["g", "ml", "kg", "l"]);

function fmtQty(value, unit) {
  if (DECIMAL_UNITS.has(unit)) return String(Math.round(value * 100) / 100).replace(".", ",");
  const whole = Math.floor(value + 1e-9);
  const frac = value - whole;
  for (const [v, glyph] of GLYPHS) if (Math.abs(frac - v) < 0.02) return (whole ? whole : "") + glyph;
  if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
  return String(Math.round(value * 100) / 100).replace(".", ",");
}

// Cuts at a sentence end where possible, otherwise at a word boundary, so the
// hero intro never breaks mid-word.
function trim(text, max) {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentence > max * 0.5) return window.slice(0, sentence + 1);
  return window.slice(0, window.lastIndexOf(" ")).replace(/[,;:]$/, "") + "…";
}

// Mirrors formatItem() in kueche.js at scale factor 1.
function renderItem(item) {
  const bits = [];
  if (item.approx) bits.push("ca.");
  if (item.qty != null)
    bits.push(fmtQty(item.qty, item.unit) + (item.qtyTo != null ? "–" + fmtQty(item.qtyTo, item.unit) : ""));
  if (item.size) bits.push(item.size);
  if (item.unit) bits.push(item.unit);
  const lead = bits.join(" ");

  let html = "";
  if (item.prefix) {
    html = `${escHtml(item.prefix)} von <span class="qty">${escHtml(lead)}</span> ${escHtml(item.name)}`;
  } else {
    if (lead) html += `<span class="qty">${escHtml(lead)}</span> `;
    html += escHtml(item.name);
  }
  if (item.optional) html += ' <span class="flag">optional</span>';
  if (item.note) html += `<span class="note">${escHtml(item.note)}</span>`;
  return html;
}

// Google reads this for rich results (photo, ingredients, yield) in search.
function recipeJsonLd(r) {
  return {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: r.title,
    image: [`https://plantiness.com${r.hero}`],
    description: r.excerpt || r.intro.slice(0, 200),
    author: { "@type": "Person", name: "Anni" },
    datePublished: r.date,
    recipeYield: `${r.servings.count} ${r.servings.label}`,
    recipeCategory: r.cats.find((c) => c !== "Rezepte") || "Hauptgericht",
    suitableForDiet: "https://schema.org/VeganDiet",
    recipeIngredient: r.groups.flatMap((g) => g.items.map((i) => i.raw)),
    recipeInstructions: r.steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, text: s })),
  };
}

function renderRecipe(r) {
  const groups = r.groups
    .map((g, gi) => {
      const items = g.items
        .map(
          (item, i) =>
            `<li data-index="${i}"><label><input type="checkbox" /><span class="txt">${renderItem(
              item
            )}</span></label></li>`
        )
        .join("");
      return `<div class="ing-group" data-group="${gi}">
              ${g.title ? `<h3>${escHtml(g.title)}</h3>` : ""}
              <ul class="ing-list">${items}</ul>
            </div>`;
    })
    .join("\n            ");

  const steps = r.steps.map((s) => `<li><p data-timers>${escHtml(s)}</p></li>`).join("\n              ");

  const notes = r.notes.length
    ? `<div class="notes-box"><strong>Aus dem Originalrezept</strong>${r.notes
        .map((n) => `<p>${escHtml(n)}</p>`)
        .join("")}</div>`
    : "";

  const portionNote = r.servings.assumed
    ? `<p class="portion-note">Basis: ${r.servings.count} ${escHtml(
        r.servings.label
      )} &mdash; gesch&auml;tzt, das Originalrezept nennt keine Menge</p>`
    : `<p class="portion-note">Originalrezept: ${r.servings.count} ${escHtml(r.servings.label)}</p>`;

  const category = r.cats.find((c) => c !== "Rezepte") || "Rezept";

  const body = `    <main>
      <section class="r-hero">
        <div class="copy">
          <p class="crumbs"><a href="/new/">K&uuml;che</a> &nbsp;/&nbsp; ${escHtml(category)}</p>
          <h1>${escHtml(r.title)}</h1>
          ${r.intro ? `<p class="intro">${escHtml(trim(r.intro, 260))}</p>` : ""}
        </div>
        <div class="shot"><img src="${escHtml(r.hero)}" alt="${escHtml(r.title)}" /></div>
      </section>

      <div class="portion-bar">
        <div class="portion-inner">
          <div class="stepper">
            <button id="servings-minus" type="button" aria-label="Weniger Portionen">&minus;</button>
            <span class="value" id="servings-value" aria-live="polite">${r.servings.count}<small>${escHtml(
    r.servings.label
  )}</small></span>
            <button id="servings-plus" type="button" aria-label="Mehr Portionen">+</button>
          </div>
          <button class="btn ghost" id="servings-reset" type="button" hidden>Zur&uuml;cksetzen</button>
          ${portionNote}
          <div class="portion-actions">
            <button class="btn" id="add-to-list" type="button">&#43; <span>Auf die Einkaufsliste</span></button>
            <button class="btn primary" id="start-cook" type="button">&#9654; Kochmodus</button>
          </div>
        </div>
      </div>

      <div class="wrap">
        <div class="r-body">
          <aside class="ing-panel">
            <h2>Zutaten</h2>
            <p class="eyebrow" style="margin:6px 0 0">Zum Abhaken</p>
            ${groups}
          </aside>
          <div class="steps">
            <h2>Zubereitung</h2>
            <ol>
              ${steps}
            </ol>
            ${notes}
            <p class="source-note">Originalrezept: <a href="/${escHtml(r.slug)}/">${escHtml(
    r.title
  )}</a> auf plantiness.com</p>
          </div>
        </div>
      </div>
    </main>
    <script type="application/json" id="recipe-data">${jsonScript(r)}</script>
    <script type="application/ld+json">${jsonScript(recipeJsonLd(r))}</script>`;

  return page(
    "recipe",
    `${r.title} — Plantiness Küche`,
    r.excerpt || r.intro,
    `https://plantiness.com/new/rezept/${r.slug}/`,
    body,
    `/${r.slug}/`
  );
}

/* ---------------------------------------------------- shopping list page */

function renderList() {
  const body = `    <main class="wrap list-page">
      <p class="eyebrow">PLANTINESS K&Uuml;CHE</p>
      <h1 style="font-size:clamp(34px,5vw,54px)">Einkaufs<em>liste.</em></h1>
      <p style="color:#587067;max-width:52ch;margin:16px 0 30px">Zutaten aus allen gew&auml;hlten Rezepten &mdash;
        zusammengefasst, nach Regal sortiert und auf deine Portionen gerechnet.</p>
      <div class="basket" id="basket"></div>
      <div class="list-actions" id="list-actions" hidden>
        <button class="btn" id="copy-list" type="button">Teilen / kopieren</button>
        <button class="btn ghost" id="print-list" type="button">Drucken</button>
        <button class="btn ghost" id="clear-list" type="button">Liste leeren</button>
      </div>
      <div id="list-root" aria-live="polite"></div>
    </main>`;

  return page(
    "list",
    "Einkaufsliste — Plantiness Küche",
    "Deine Einkaufsliste aus allen gewählten Plantiness-Rezepten, zusammengefasst und nach Regal sortiert.",
    "https://plantiness.com/new/einkaufsliste/",
    body
  );
}

/* ------------------------------------------------------------------ write */

export async function renderAll(recipes, OUT) {
  await writeFile(path.join(OUT, "index.html"), renderIndex(recipes), "utf8");

  await mkdir(path.join(OUT, "einkaufsliste"), { recursive: true });
  await writeFile(path.join(OUT, "einkaufsliste", "index.html"), renderList(), "utf8");

  for (const r of recipes) {
    const dir = path.join(OUT, "rezept", r.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), renderRecipe(r), "utf8");
  }

  return recipes.length;
}
