// One-off audit script: compares local generated pages against the real
// plantiness.com content, flags text drift and stock-image placeholders.
// Not part of the site build; safe to delete after use.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const LEGAL_OR_UTILITY = new Set([
  "kontakt",
  "impressum",
  "datenschutzerklaerung",
  "ueber-plantiness",
  "fast-geschafft",
  "vielen-dank-fuer-deine-anmeldung",
]);

function listSlugs() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(ROOT, name, "index.html")))
    .filter((name) => !LEGAL_OR_UTILITY.has(name));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchReal(slug) {
  const url = `https://www.plantiness.com/${slug}/`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; plantiness-audit/1.0)" },
  });
  const html = await res.text();
  return { url, status: res.status, html };
}

function extractBetween(html, startMarker) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return null;
  // Walk forward counting div depth to find the matching closing </div>
  let i = html.indexOf(">", startIdx) + 1;
  let depth = 1;
  const divOpen = /<div\b/gi;
  const divClose = /<\/div>/gi;
  let cursor = i;
  while (depth > 0) {
    const nextOpen = html.indexOf("<div", cursor);
    const nextClose = html.indexOf("</div>", cursor);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      cursor = nextOpen + 4;
    } else {
      depth--;
      cursor = nextClose + 6;
      if (depth === 0) {
        return html.slice(i, nextClose);
      }
    }
  }
  return null;
}

function stripToText(html) {
  return html
    .replace(/<span[^>]*>/gi, "")
    .replace(/<\/span>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, "-")
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/(?:Merken\s*)+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractOgImage(html) {
  const m = html.match(/<meta property="og:image" content="([^"]+)"/);
  return m ? m[1] : null;
}

function extractTitle(html) {
  const m = html.match(/<meta property="og:title" content="([^"]+)"/);
  return m ? m[1] : null;
}

function extractCategory(html) {
  // e.g. class="post-683 post type-post ... category-rezepte category-sattmacher ..."
  const m = html.match(/<article[^>]*class="([^"]*)"/);
  if (!m) return [];
  return [...m[1].matchAll(/category-([a-z0-9-]+)/g)].map((x) => x[1]);
}

async function main() {
  const slugs = listSlugs();
  const report = [];
  for (const slug of slugs) {
    const localPath = path.join(ROOT, slug, "index.html");
    const localHtml = fs.readFileSync(localPath, "utf8");
    const localBodyMatch = localHtml.match(
      /<div class="post-body">([\s\S]*?)<\/div>\s*<\/div>\s*(?:<p class="post-source")/
    );
    const localBodyText = localBodyMatch ? stripToText(localBodyMatch[1]) : null;
    const localImageMatch = localHtml.match(
      /<div class="post-image"><img src="([^"]+)"/
    );
    const localImage = localImageMatch ? localImageMatch[1] : null;
    const isStock = localImage ? localImage.includes("images.unsplash.com") : false;

    let entry = { slug, localImage, isStock };
    try {
      const { url, status, html } = await fetchReal(slug);
      entry.realUrl = url;
      entry.realStatus = status;
      if (status !== 200) {
        entry.error = `HTTP ${status}`;
      } else {
        const realContent = extractBetween(html, '<div id="entry-content" class="entry-content">');
        entry.realBodyText = realContent ? stripToText(realContent) : null;
        entry.realImage = extractOgImage(html);
        entry.realTitle = extractTitle(html);
        entry.realCategories = extractCategory(html);
        entry.textMatches = entry.realBodyText && localBodyText
          ? entry.realBodyText === localBodyText
          : null;
        if (!entry.textMatches && entry.realBodyText && localBodyText) {
          entry.localBodyTextSnippet = localBodyText.slice(0, 200);
          entry.realBodyTextSnippet = entry.realBodyText.slice(0, 200);
        }
      }
    } catch (e) {
      entry.error = String(e);
    }
    report.push(entry);
    console.error(`checked ${slug}`);
    await sleep(250);
  }
  fs.writeFileSync(
    path.join(ROOT, "scripts", "audit-report.json"),
    JSON.stringify(report, null, 2)
  );
  console.error("done");
}

main();
