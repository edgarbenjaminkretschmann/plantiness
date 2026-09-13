// Rebuilds each local post page from the real plantiness.com content:
// downloads the real hero/thumb images and replaces generated body text
// with the real article text (cleaned of WP/Pinterest widget artifacts).
// Run with: node scripts/rebuild-content.mjs [--only=slug1,slug2] [--dry]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const IMAGES_DIR = path.join(ROOT, "images", "originals");

const LEGAL_OR_UTILITY = new Set([
  "kontakt",
  "impressum",
  "datenschutzerklaerung",
  "ueber-plantiness",
  "fast-geschafft",
  "vielen-dank-fuer-deine-anmeldung",
]);

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;

function listSlugs() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(ROOT, name, "index.html")))
    .filter((name) => !LEGAL_OR_UTILITY.has(name))
    .filter((name) => !only || only.has(name));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; plantiness-rebuild/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function downloadImage(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; plantiness-rebuild/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for image ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!dry) fs.writeFileSync(destPath, buf);
  return buf.length;
}

function extractBetween(html, startMarker) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return null;
  let i = html.indexOf(">", startIdx) + 1;
  let depth = 1;
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
      if (depth === 0) return html.slice(i, nextClose);
    }
  }
  return null;
}

function parseSrcset(srcset) {
  if (!srcset) return [];
  return srcset.split(",").map((part) => {
    const [url, w] = part.trim().split(/\s+/);
    return { url, width: parseInt(w) || 0 };
  });
}

function pickClosest(candidates, targetWidth) {
  if (!candidates.length) return null;
  return candidates.reduce((best, c) =>
    Math.abs(c.width - targetWidth) < Math.abs(best.width - targetWidth) ? c : best
  );
}

function findHeroImageTag(html, ogImageFilenameNoExt) {
  // Find the <img> tag whose src contains the og:image base filename
  // (handles the featured-image block, which sits outside entry-content).
  const re = /<img[^>]*src="([^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].includes(ogImageFilenameNoExt)) {
      return m[0];
    }
  }
  return null;
}

function extractAttr(tag, attr) {
  const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
  return m ? m[1] : null;
}

function cleanBodyHtml(rawContent) {
  let html = rawContent;

  // Drop Pinterest "Merken" hover-save button widgets (decorative UI chrome,
  // not editorial content) - they're pairs of absolutely-positioned spans.
  html = html.replace(/<span style="[^"]*">1<\/span><span style="[^"]*">Merken<\/span>/g, "");
  html = html.replace(/<span[^>]*>Merken<\/span>/g, "");
  html = html.replace(/<span style="[^"]*background-image: url\(data:image\/svg[^"]*"><\/span>/g, "");

  // Unwrap the ubiquitous WP inline gray-text span wrapper.
  html = html.replace(/<span style="color: #808080;">/g, "");
  // Unwrap any other inline-style spans we didn't explicitly handle (keep text).
  html = html.replace(/<span style="[^"]*">/g, "");
  html = html.replace(/<\/span>/g, "");

  // Convert <figure>...<figcaption>TEXT</figcaption></figure> blocks into a
  // plain paragraph with just the caption text (template has no inline-image
  // support yet); drop figures with no caption entirely.
  html = html.replace(/<figure[^>]*>([\s\S]*?)<\/figure>/g, (_all, inner) => {
    const capMatch = inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/);
    if (!capMatch) return "";
    const text = capMatch[1].replace(/<[^>]+>/g, "").trim();
    return text ? `<p><em>${text}</em></p>` : "";
  });

  // Rewrite internal plantiness.com links to relative paths.
  html = html.replace(
    /href="https?:\/\/(?:www\.)?plantiness\.com\/([a-z0-9-]+)\/?"/g,
    'href="/$1/"'
  );

  // Drop empty paragraphs / stray whitespace-only elements.
  html = html.replace(/<p>\s*<\/p>/g, "");
  html = html.replace(/<p><\/p>/g, "");

  // Collapse excess blank lines.
  html = html.replace(/\n{2,}/g, "\n").trim();

  return html;
}

async function processSlug(slug, crossRefs) {
  const localPath = path.join(ROOT, slug, "index.html");
  let localHtml = fs.readFileSync(localPath, "utf8");

  const realUrl = `https://www.plantiness.com/${slug}/`;
  const realHtml = await fetchText(realUrl);

  const ogImageMatch = realHtml.match(/<meta property="og:image" content="([^"]+)"/);
  const ogImage = ogImageMatch ? ogImageMatch[1] : null;

  const entryContent = extractBetween(realHtml, '<div id="entry-content" class="entry-content">');
  if (!entryContent) {
    console.error(`  [skip] no entry-content found for ${slug}`);
    return;
  }

  let heroUrl = null;
  let thumbUrl = null;
  let heroExt = ".jpg";

  if (ogImage) {
    const filename = ogImage.split("/").pop().split("?")[0];
    const base = filename.replace(/\.[a-z]+$/i, "");
    const ext = path.extname(filename) || ".jpg";
    heroExt = ext;
    const imgTag = findHeroImageTag(realHtml, base);
    if (imgTag) {
      const srcset = extractAttr(imgTag, "srcset");
      const candidates = parseSrcset(srcset);
      if (candidates.length) {
        heroUrl = pickClosest(candidates, 1000).url;
        thumbUrl = pickClosest(candidates, 300).url;
      }
    }
    if (!heroUrl) heroUrl = ogImage;
    if (!thumbUrl) thumbUrl = ogImage;
  }

  if (!heroUrl) {
    console.error(`  [skip] no hero image resolvable for ${slug}`);
    return;
  }

  const heroPath = `/images/originals/${slug}-hero${heroExt}`;
  const thumbPath = `/images/originals/${slug}-thumb${heroExt}`;
  const heroDest = path.join(IMAGES_DIR, `${slug}-hero${heroExt}`);
  const thumbDest = path.join(IMAGES_DIR, `${slug}-thumb${heroExt}`);

  const currentImgMatch = localHtml.match(/<div class="post-image"><img src="([^"]+)"/);
  const currentImg = currentImgMatch ? currentImgMatch[1] : null;
  const wasStock = currentImg && currentImg.includes("images.unsplash.com");
  const currentLocalBase = currentImg && currentImg.startsWith("/images/originals/")
    ? path.basename(currentImg).replace(/-hero\.[a-z]+$/i, "").replace(/-thumb\.[a-z]+$/i, "")
    : null;
  const isMismatchedLocal = currentLocalBase !== null && currentLocalBase !== slug;
  const needsImageFix = wasStock || isMismatchedLocal || !currentImg?.startsWith("/images/originals/");

  let downloadedHeroBytes = 0;
  let downloadedThumbBytes = 0;
  if (needsImageFix) {
    downloadedHeroBytes = await downloadImage(heroUrl, heroDest);
    downloadedThumbBytes = await downloadImage(thumbUrl, thumbDest);
    if (currentImg && currentImg.includes("unsplash.com")) {
      const idMatch = currentImg.match(/photo-[a-z0-9-]+/);
      if (idMatch) crossRefs.push({ oldFragment: idMatch[0], newThumb: thumbPath });
    }
  }

  const cleanedBody = cleanBodyHtml(entryContent);

  // Replace the post-image (only if we have a real hero to swap in).
  if (needsImageFix) {
    localHtml = localHtml.replace(
      /(<div class="post-image"><img src=")[^"]*("[^>]*\/><\/div>)/,
      `$1${heroPath}$2`
    );
  }

  // Replace the post-body content.
  const bodyRe = /(<div class="post-body">)([\s\S]*?)(<\/div>\s*<\/div>\s*)(<p class="post-source")/;
  if (!bodyRe.test(localHtml)) {
    console.error(`  [warn] post-body pattern not found for ${slug}, skipping body replace`);
  } else {
    localHtml = localHtml.replace(bodyRe, (_all, open, _old, close, tail) => {
      return `${open}${cleanedBody}${close}${tail}`;
    });
  }

  if (!dry) fs.writeFileSync(localPath, localHtml);

  console.error(
    `  ok  ${slug}  hero=${wasStock ? "downloaded" : "kept"}(${downloadedHeroBytes}b) thumb(${downloadedThumbBytes}b) bodyLen=${cleanedBody.length}`
  );
}

async function main() {
  const slugs = listSlugs();
  const crossRefs = [];
  console.error(`Processing ${slugs.length} pages${dry ? " (DRY RUN)" : ""}...`);
  for (const slug of slugs) {
    try {
      await processSlug(slug, crossRefs);
    } catch (e) {
      console.error(`  ERROR ${slug}: ${e.message}`);
    }
    await sleep(300);
  }

  // Second pass: replace remaining stock-image cross references site-wide.
  if (crossRefs.length) {
    console.error(`\nApplying ${crossRefs.length} cross-reference image fixes site-wide...`);
    const allDirs = fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const allHtmlFiles = [
      path.join(ROOT, "index.html"),
      ...allDirs
        .map((d) => path.join(ROOT, d, "index.html"))
        .filter((p) => fs.existsSync(p)),
    ];
    for (const file of allHtmlFiles) {
      let html = fs.readFileSync(file, "utf8");
      let changed = false;
      for (const { oldFragment, newThumb } of crossRefs) {
        const re = new RegExp(
          `https://images\\.unsplash\\.com/${oldFragment}\\?[^"]*`,
          "g"
        );
        if (re.test(html)) {
          html = html.replace(re, newThumb);
          changed = true;
        }
      }
      if (changed && !dry) fs.writeFileSync(file, html);
      if (changed) console.error(`  updated cross-refs in ${path.relative(ROOT, file)}`);
    }
  }

  console.error("\nDone.");
}

main();
