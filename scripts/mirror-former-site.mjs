// Mirrors the former WordPress site (plantiness.com) into former-site/ as a
// self-contained static archive: every post, page, category, tag, author and
// pagination screen, in the original uku-theme markup, with its stylesheets,
// scripts, fonts and images pulled into former-site/assets.
//
// Usage: node scripts/mirror-former-site.mjs [--limit=N] [--dry]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "former-site");
const ASSET_DIR = path.join(OUT_DIR, "assets");
const ORIGIN = "https://plantiness.com";
const BASE = "/former-site";
const UA = "Mozilla/5.0 (compatible; plantiness-archive/1.0)";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice(8)) : 500;

// ---------------------------------------------------------------- utilities

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

async function fetchWithRetry(url, { binary = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
      return { body, contentType, finalUrl: res.url };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function mapLimited(items, concurrency, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  });
  await Promise.all(workers);
}

// ------------------------------------------------------------- url grouping

const ASSET_EXT = new Set([
  ".css", ".js", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".avif",
  ".ico", ".woff", ".woff2", ".ttf", ".eot", ".otf", ".mp4", ".webm", ".json",
]);

// WordPress endpoints that have no meaning in a static archive.
const DEAD_PATH = /^\/(wp-json|wp-admin|wp-login\.php|xmlrpc\.php|wp-cron\.php)/;
const DEAD_TAIL = /\/(feed|embed|trackback)\/?$/;

// The footer still links some pages over plain http, and WordPress emits both
// the bare and the www host, so origin equality is too strict here.
function isSameSite(u) {
  return /^(www\.)?plantiness\.com$/.test(u.hostname);
}

function resolve(raw, pageUrl) {
  try {
    return new URL(decodeEntities(raw), pageUrl).href;
  } catch {
    return null;
  }
}

// Returns the raw (entity-preserving) absolute form for assets, so the hashed
// filenames stay stable against the 130 files already in the archive.
function rawAbsolute(raw, pageUrl) {
  try {
    return new URL(raw.trim(), pageUrl).href;
  } catch {
    return null;
  }
}

function classify(raw, pageUrl) {
  const trimmed = raw.trim();
  if (!trimmed || /^(#|data:|mailto:|tel:|javascript:)/i.test(trimmed)) return { kind: "skip" };
  const abs = resolve(trimmed, pageUrl);
  if (!abs) return { kind: "skip" };
  const u = new URL(abs);
  const ext = path.extname(u.pathname).toLowerCase();
  const asset = { kind: "asset", raw: rawAbsolute(trimmed, pageUrl) };

  // dns-prefetch/preconnect hints point at a bare host, not a file.
  if (u.pathname === "/" && !isSameSite(u)) return { kind: "skip" };
  // Extension-less third parties the theme loads as images.
  if (u.hostname === "fonts.googleapis.com") return asset;
  if (/(^|\.)gravatar\.com$/.test(u.hostname)) return asset;
  if (ASSET_EXT.has(ext)) return asset;

  if (!isSameSite(u)) return { kind: "skip" };
  if (/^\/wp-(content|includes)\//.test(u.pathname)) return asset;
  // Query-addressed pages (?p=123) have no static equivalent.
  if (u.pathname === "/" && u.search) return { kind: "skip" };
  if (DEAD_PATH.test(u.pathname) || DEAD_TAIL.test(u.pathname)) return { kind: "skip" };
  if (u.pathname.includes("/attachment/")) return { kind: "skip" };
  return { kind: "page", u };
}

// Where a mirrored page lives, both on disk and in the rewritten markup.
function pageHref(u) {
  const p = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  return BASE + p + (u.hash || "");
}

function pageFile(u) {
  const segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return path.join(OUT_DIR, ...segments, "index.html");
}

// ------------------------------------------------------------------ assets

const assets = new Map(); // raw absolute url -> public href
const inFlight = new Map();

function assetFilename(rawAbs, contentType) {
  const u = new URL(decodeEntities(rawAbs));
  const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "asset");
  let ext = path.extname(last);
  let stem = ext ? last.slice(0, -ext.length) : last;
  if (!ext) {
    if (/css/.test(contentType)) ext = ".css";
    else if (/javascript/.test(contentType)) ext = ".js";
    else if (/svg/.test(contentType)) ext = ".svg";
    else if (/png/.test(contentType)) ext = ".png";
    else if (/jpe?g/.test(contentType)) ext = ".jpg";
    else ext = ".bin";
  }
  stem = stem.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return `${stem}-${md5(rawAbs).slice(0, 8)}${ext}`;
}

// Stylesheets reference fonts and sprites of their own; those land as siblings
// in assets/, so a bare filename is the right rewrite.
async function localizeCss(css, cssUrl) {
  const mapping = new Map();
  for (const [, , ref] of css.matchAll(INLINE_URL)) {
    if (/^data:/i.test(ref) || mapping.has(ref)) continue;
    const abs = rawAbsolute(ref, cssUrl);
    if (!abs) continue;
    const local = await downloadAsset(abs);
    if (local) mapping.set(ref, path.posix.basename(local));
  }
  return css.replace(INLINE_URL, (m, q, ref) =>
    mapping.has(ref) ? `url(${mapping.get(ref)})` : m,
  );
}

async function downloadAsset(rawAbs) {
  if (!rawAbs) return null;
  if (assets.has(rawAbs)) return assets.get(rawAbs);
  if (inFlight.has(rawAbs)) return inFlight.get(rawAbs);

  const task = (async () => {
    const decoded = decodeEntities(rawAbs);
    const isCss =
      /\.css(\?|$)/i.test(decoded) || new URL(decoded).hostname === "fonts.googleapis.com";

    // When the URL alone fixes the filename, an already-archived file needs no
    // round trip — this is what keeps a re-run from re-downloading 200 MB.
    if (!isCss && path.extname(new URL(decoded).pathname)) {
      const cached = assetFilename(rawAbs, "");
      if (fs.existsSync(path.join(ASSET_DIR, cached))) {
        const href = `${BASE}/assets/${cached}`;
        assets.set(rawAbs, href);
        return href;
      }
    }

    let fetched;
    try {
      fetched = await fetchWithRetry(decoded, { binary: !isCss });
    } catch (err) {
      console.warn(`  ! asset ${rawAbs} — ${err.message}`);
      return null;
    }
    const name = assetFilename(rawAbs, fetched.contentType);
    const href = `${BASE}/assets/${name}`;
    assets.set(rawAbs, href);

    const dest = path.join(ASSET_DIR, name);
    if (isCss) {
      const css = await localizeCss(String(fetched.body), decoded);
      if (!dry) fs.writeFileSync(dest, css);
    } else if (!dry && !fs.existsSync(dest)) {
      fs.writeFileSync(dest, fetched.body);
    }
    return href;
  })();

  inFlight.set(rawAbs, task);
  const result = await task;
  inFlight.delete(rawAbs);
  return result;
}

// -------------------------------------------------------------- html strip

function stripTrackers(html) {
  const cuts = [
    // Cookiebot loader and the gtag consent defaults it drives.
    /<script[^>]*id="Cookiebot"[\s\S]*?<\/script>\n?/g,
    /<script>\s*window\.dataLayer = window\.dataLayer \|\| \[\];[\s\S]*?<\/script>\n?/g,
    /<script>\s*dataLayer = \[\[\]\];\s*<\/script>\n?/g,
    // Google Tag Manager, both halves.
    /<!-- Google Tag Manager -->[\s\S]*?<!-- End Google Tag Manager -->\n?/g,
    /<!-- Google Tag Manager \(noscript\) -->[\s\S]*?<!-- End Google Tag Manager \(noscript\) -->/g,
    // The consent banner gated exactly those trackers and overlays the page.
    /<script[^>]*id=['"]eucookielaw-scripts-js(-extra)?['"][\s\S]*?<\/script>\n?/g,
    /^<!-- Eu Cookie Law [^\n]*\n?/m,
    // The emoji polyfill hardcodes its loader URL inside a JSON blob, so it
    // would keep pulling wp-emoji-release.min.js (and s.w.org sprites) off the
    // live site. It is a shim for browsers that predate emoji rendering.
    /<script type="text\/javascript">\s*window\._wpemojiSettings[\s\S]*?<\/script>\n?/g,
    // Amazon affiliate widgets: cross-site ad frames the removed banner gated.
    /<iframe[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']*amazon-adsystem\.com[^"']*["'][^>]*>\s*<\/iframe>/g,
    // WordPress endpoints that do not exist in a static archive.
    /<link rel="pingback"[^>]*>\n?/g,
    /<link rel="EditURI"[^>]*>\n?/g,
    /<link rel="https:\/\/api\.w\.org\/"[^>]*>\n?/g,
    /<link rel="alternate" type="application\/rss\+xml"[^>]*>\n?/g,
  ];
  let out = html;
  for (const re of cuts) out = out.replace(re, "");
  // An empty theme slot whose zero-byte <img src=""> re-requests the page.
  out = out.replace(
    /<section id="big-footer-feature"[\s\S]*?<\/section><!-- end #big-footer-feature -->\n?/g,
    (m) => (/ src="[^"]+"/.test(m) ? m : ""),
  );
  return out;
}

// ---------------------------------------------------------------- rewriting

const URL_ATTRS = /\b(href|src|poster|data-src|data-lazy-src|data-thumb)\s*=\s*(["'])([^"']*)\2/g;
const SRCSET_ATTRS = /\b(srcset|imagesrcset|data-srcset)\s*=\s*(["'])([^"']*)\2/g;
const INLINE_URL = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g;

function collectUrls(html, pageUrl) {
  const found = new Map();
  const add = (raw) => {
    if (!raw || found.has(raw)) return;
    const c = classify(raw, pageUrl);
    if (c.kind !== "skip") found.set(raw, c);
  };
  for (const [, , , value] of html.matchAll(URL_ATTRS)) add(value);
  for (const [, , , value] of html.matchAll(SRCSET_ATTRS)) {
    for (const entry of value.split(",")) add(entry.trim().split(/\s+/)[0]);
  }
  for (const [, , ref] of html.matchAll(INLINE_URL)) {
    if (!/^data:/i.test(ref)) add(ref);
  }
  return found;
}

function rewriteOne(raw, pageUrl) {
  const c = classify(raw, pageUrl);
  if (c.kind === "asset") return assets.get(c.raw) ?? raw;
  if (c.kind === "page") return pageHref(c.u);
  return raw;
}

function rewriteHtml(html, pageUrl) {
  let out = html.replace(
    URL_ATTRS,
    (m, attr, q, value) => `${attr}=${q}${rewriteOne(value, pageUrl)}${q}`,
  );
  out = out.replace(SRCSET_ATTRS, (m, attr, q, value) => {
    const rewritten = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [url, ...rest] = entry.split(/\s+/);
        return [rewriteOne(url, pageUrl), ...rest].join(" ");
      })
      .join(", ");
    return `${attr}=${q}${rewritten}${q}`;
  });
  out = out.replace(INLINE_URL, (m, q, ref) =>
    /^data:/i.test(ref) ? m : `url(${q}${rewriteOne(ref, pageUrl)}${q})`,
  );
  return out;
}

// The archive duplicates the live articles, so it must not compete with them
// in search results, and every canonical must point at the archived copy.
function fixSeo(html, u) {
  const self = `${ORIGIN}${pageHref(u).replace(/#.*$/, "")}`;
  let out = html.replace(
    /<meta name="robots" content="[^"]*"\s*\/?>/,
    '<meta name="robots" content="noindex, follow" />',
  );
  if (!/name="robots"/.test(out)) {
    out = out.replace(/<title>/, '<meta name="robots" content="noindex, follow" />\n<title>');
  }
  return out.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${self}$2`);
}

// -------------------------------------------------------------------- crawl

const queue = ["/"];
const seen = new Set(["/"]);
const written = [];
const redirects = [];

function enqueue(u) {
  const key = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  if (seen.has(key) || seen.size >= LIMIT) return;
  seen.add(key);
  queue.push(key);
}

function writeRedirect(fromPath, toHref) {
  const dest = pageFile(new URL(ORIGIN + fromPath));
  if (!dry) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      `<!DOCTYPE html>
<html lang="de-DE">
<head>
<meta charset="UTF-8">
<meta name="robots" content="noindex, follow" />
<meta http-equiv="refresh" content="0; url=${toHref}">
<link rel="canonical" href="${ORIGIN}${toHref}" />
<title>Weitergeleitet</title>
</head>
<body><p><a href="${toHref}">Weiter zum Beitrag</a></p></body>
</html>
`,
    );
  }
  redirects.push([fromPath, toHref]);
  console.log(`    ${fromPath} -> ${toHref}`);
}

async function mirrorPage(pathname) {
  const pageUrl = ORIGIN + pathname;
  let fetched;
  try {
    fetched = await fetchWithRetry(pageUrl);
  } catch (err) {
    console.warn(`! page ${pathname} — ${err.message}`);
    return;
  }
  if (!/text\/html/.test(fetched.contentType)) return;

  // Renamed posts keep serving their old permalink as a redirect. Mirror that
  // as a redirect too, rather than archiving the article twice.
  const finalUrl = new URL(fetched.finalUrl);
  const finalPath = finalUrl.pathname.endsWith("/") ? finalUrl.pathname : `${finalUrl.pathname}/`;
  if (isSameSite(finalUrl) && finalPath !== pathname) {
    enqueue(finalUrl);
    writeRedirect(pathname, pageHref(finalUrl));
    return;
  }

  const html = stripTrackers(fetched.body);
  const refs = collectUrls(html, pageUrl);

  const assetRefs = [...refs.values()].filter((c) => c.kind === "asset");
  await mapLimited(assetRefs, 6, (c) => downloadAsset(c.raw));
  for (const c of refs.values()) if (c.kind === "page") enqueue(c.u);

  const dest = pageFile(new URL(pageUrl));
  if (!dry) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fixSeo(rewriteHtml(html, pageUrl), new URL(pageUrl)));
  }
  written.push(path.relative(ROOT, dest).replace(/\\/g, "/"));
  console.log(`${String(written.length).padStart(3)} ${pathname}`);
}

// Link-following alone misses anything the theme does not surface — a page
// dropped from the menu is still part of the site — so seed from WordPress's
// own index of posts and pages first.
async function seedFromWordPress() {
  for (const type of ["posts", "pages"]) {
    try {
      const { body } = await fetchWithRetry(
        `${ORIGIN}/wp-json/wp/v2/${type}?per_page=100&status=publish&_fields=link`,
      );
      for (const item of JSON.parse(body)) {
        const u = new URL(item.link);
        if (isSameSite(u)) enqueue(u);
      }
    } catch (err) {
      console.warn(`! seed ${type} — ${err.message}`);
    }
  }
}

if (!dry) fs.mkdirSync(ASSET_DIR, { recursive: true });
await seedFromWordPress();
while (queue.length) await mirrorPage(queue.shift());

console.log(`\npages: ${written.length}`);
console.log(`redirects: ${redirects.length}`);
console.log(`assets: ${assets.size}`);
