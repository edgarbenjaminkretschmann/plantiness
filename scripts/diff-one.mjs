import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const slug = process.argv[2];

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
    .replace(/\s+/g, " ")
    .trim();
}

const localHtml = fs.readFileSync(path.join(ROOT, slug, "index.html"), "utf8");
const localBodyMatch = localHtml.match(
  /<div class="post-body">([\s\S]*?)<\/div>\s*<\/div>\s*(?:<p class="post-source")/
);
const localBodyText = localBodyMatch ? stripToText(localBodyMatch[1]) : null;

const res = await fetch(`https://www.plantiness.com/${slug}/`, {
  headers: { "User-Agent": "Mozilla/5.0 (compatible; plantiness-audit/1.0)" },
});
const html = await res.text();
const realContent = extractBetween(html, '<div id="entry-content" class="entry-content">');
const realBodyText = realContent ? stripToText(realContent) : null;

console.log("local length:", localBodyText?.length);
console.log("real  length:", realBodyText?.length);
let i = 0;
while (i < localBodyText.length && i < realBodyText.length && localBodyText[i] === realBodyText[i]) i++;
console.log("first diff at index", i);
console.log("LOCAL context:", JSON.stringify(localBodyText.slice(Math.max(0,i-60), i+120)));
console.log("REAL  context:", JSON.stringify(realBodyText.slice(Math.max(0,i-60), i+120)));
