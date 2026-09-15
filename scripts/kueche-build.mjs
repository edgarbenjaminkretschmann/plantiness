// Builds the /new/ subsection: a cooking UI layered on top of the existing
// static post pages. Reads the generated pages in the repo (not the WordPress
// API) so the build is self-contained and reproducible offline.
//
// Usage: node scripts/kueche-build.mjs [--dry]
//
// Nothing outside kueche/ is written. The main site is never touched.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "new");
const DRY = process.argv.includes("--dry");

/* ---------------------------------------------------------------- html bits */

const ENTITIES = {
  "&#8211;": "–", "&#8212;": "—", "&#8217;": "’", "&#8216;": "‘",
  "&#8220;": "“", "&#8221;": "”", "&#8218;": "‚", "&#8230;": "…",
  "&#189;": "½", "&#8539;": "⅛", "&#8531;": "⅓", "&#8532;": "⅔",
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
};

function decode(s) {
  return s
    .replace(/&#\d+;|&[a-z]+;/gi, (m) => ENTITIES[m] ?? ENTITIES[m.toLowerCase()] ?? m)
    .replace(/ /g, " ");
}

const stripTags = (s) =>
  decode(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();

const blocksOf = (html) =>
  html.match(/<(h[1-6]|p|ul|ol)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];

const liOf = (block) =>
  [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].flatMap((m) =>
    stripTags(m[1]).split(/\n+/).map((s) => s.trim()).filter(Boolean)
  );

// Captions on the original site are always a paragraph wrapped entirely in <em>.
// That is the one reliable signal separating photo captions from ingredients.
const isCaption = (block) =>
  /^<p[^>]*>\s*(?:<em>[\s\S]*<\/em>)\s*<\/p>$/i.test(block.replace(/\n/g, ""));

/* ------------------------------------------------------------ yield parsing */

// A heading that just announces the ingredient list itself, rather than naming a
// sub-recipe like "Für das Dressing", should not become a visible group label.
const MAIN_LIST_TITLE = /^\s*(zutaten|was du brauchst|was ist drin|rezept für)/i;

const YIELD_NOUNS =
  "Portionen|Portion|Personen|Person|Stück|Bällchen|Rouladen|Burger|Knödel|Maki-Rollen|Rollen|Gläser|Glas|Blech|Muffins|Waffeln|Pancakes";

// "Zutaten (für ca. 4 Portionen):" -> { count: 4, label: "Portionen" }
// A range ("2-3 Personen") takes the lower bound, which is how the original
// recipes read in practice.
function parseYield(text) {
  const tail = `(\\d+)(?:\\s*[-–]\\s*(\\d+))?\\s+(?:\\w+e[rn]?\\s+)?(${YIELD_NOUNS})`;
  // Preferred: anchored to "für"/"ergibt" so a stray number cannot win.
  const anchored = text.match(
    new RegExp(`(?:für|ergibt|reicht für|macht)\\s+(?:ca\\.?|circa|etwa|rund)?\\s*${tail}`, "i")
  );
  // Fallback: the count sits in its own parenthetical, detached from the verb,
  // e.g. "Zutaten für den lauwarmen Hirsesalat\n(ca. 2 Portionen):".
  const loose = anchored || text.match(new RegExp(tail, "i"));
  if (!loose) return null;
  return { count: Number(loose[1]), label: loose[3].replace(/^\w/, (c) => c.toUpperCase()) };
}

/* ------------------------------------------------- ingredient line -> object */

const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
// "1/2" must be tried before the plain-integer branch, or it parses as "1".
const NUM = "\\d+\\s*/\\s*\\d+|\\d+(?:[.,]\\d+)?|[½¼¾⅓⅔⅛]";
// "2 große Handvoll Rucola" - a size adjective may sit between count and unit.
const SIZE_ADJ = "(?:große[nr]?|kleine[nr]?|mittelgroße[nr]?|gehäufte[nr]?|gestrichene[nr]?)";

// Canonical unit -> the spellings found in the source.
const UNITS = [
  ["g", ["g", "Gramm", "gr"]],
  ["kg", ["kg", "Kilo", "Kilogramm"]],
  ["ml", ["ml", "Milliliter"]],
  ["l", ["l", "Liter"]],
  ["EL", ["EL", "El", "Esslöffel", "Eßlöffel"]],
  ["TL", ["TL", "Tl", "Teelöffel"]],
  ["Prise", ["Prise", "Prisen"]],
  ["Messerspitze", ["Messerspitze", "Messerspitzen", "Msp"]],
  ["Handvoll", ["Handvoll", "Hand voll"]],
  ["Bund", ["Bund", "Bündel"]],
  ["Dose", ["Dose", "Dosen"]],
  ["Glas", ["Glas", "Gläser"]],
  ["Becher", ["Becher"]],
  ["Tasse", ["Tasse", "Tassen"]],
  ["Stück", ["Stück", "Stk"]],
  ["Stängel", ["Stängel", "Stangen", "Stange"]],
  ["Blatt", ["Blätter", "Blatt"]],
  ["Zehe", ["Zehen", "Zehe"]],
  ["Knolle", ["Knollen", "Knolle"]],
  ["Scheibe", ["Scheiben", "Scheibe"]],
  ["Blech", ["Bleche", "Blech"]],
];
const UNIT_ALT = UNITS.flatMap(([, alts]) => alts)
  .sort((a, b) => b.length - a.length)
  .join("|");
const UNIT_CANON = new Map(UNITS.flatMap(([canon, alts]) => alts.map((a) => [a.toLowerCase(), canon])));

// Units where doubling the recipe should NOT double the number - a pinch stays
// a pinch. Everything else scales linearly.
const NO_SCALE_UNITS = new Set(["Prise", "Messerspitze"]);

const WORD_NUM = {
  ein: 1, eine: 1, einen: 1, einer: 1, eines: 1, einem: 1,
  zwei: 2, drei: 3, vier: 4, "fünf": 5, sechs: 6, acht: 8, zehn: 10,
};

function num(raw) {
  if (!raw) return null;
  const t = raw.trim();
  if (FRACTIONS[t] != null) return FRACTIONS[t];
  if (/^\d+\s*\/\s*\d+$/.test(t)) {
    const [a, b] = t.split("/").map((x) => Number(x.trim()));
    return b ? a / b : null;
  }
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Lines that describe technique or the author's opinion rather than a shopping
// item. These slip through when the source put them in the ingredient block.
const PROSE_MARKERS =
  /\b(ich|du kannst|kannst du|ihr|habe|gibt es|schmeckt|lassen sich|empfehle|würde|wer|falls|achtung|tipp|bereits|kaufen|verwenden|servier|auflockern|interpretiert|geben der)\b/i;

function looksLikeProse(text) {
  if (/^(tipp|achtung|hinweis|♥)/i.test(text)) return true;
  const words = text.split(/\s+/).length;
  // A quantity up front is decisive: it is an ingredient no matter how chatty
  // the parenthetical after it gets.
  if (new RegExp(`^(?:ca\\.?|circa|etwa|gut|knapp|je)?\\s*(?:${NUM})`, "i").test(text)) return false;
  if (words >= 6 && PROSE_MARKERS.test(text)) return true;
  if (words >= 9 && /\.$/.test(text)) return true;
  return false;
}

const STARTS_QTY = new RegExp(`^(?:ca\\.?|circa|etwa|je|gut|knapp)?\\s*(?:${NUM})`, "i");

// Split on commas that are not inside a parenthetical.
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((p) => p.trim()).filter(Boolean);
}

// The source often packs a whole sub-recipe onto one line:
//   "Für die Marinade: 3 EL Sojasauce, 2 EL Agavendicksaft, 1 Knoblauchzehe"
// Only split when at least two parts carry their own quantity, so a plain
// seasoning line like "Salz, Pfeffer und Muskat" survives intact.
function splitCompound(line) {
  let prefix = "";
  let body = line;
  const m = line.match(/^([^:]{2,45}):\s*(.+)$/);
  if (m && /^(für|zum|optional für)\b/i.test(m[1].trim())) {
    prefix = m[1].trim();
    body = m[2];
  }
  const parts = splitTopLevel(body);
  if (parts.length < 2) return null;
  if (parts.filter((p) => STARTS_QTY.test(p)).length < 2) return null;
  return { prefix, parts };
}

// "ca. 400 g Muskatkürbis (Hokkaido oder Butternut passen auch gut)"
//   -> { approx: true, qty: 400, unit: "g", name: "Muskatkürbis", note: "Hokkaido ..." }
function parseIngredient(raw) {
  const text = raw.replace(/\s+/g, " ").trim();
  const out = { raw: text, qty: null, qtyTo: null, unit: null, name: text, note: "", approx: false, scale: true };

  // A leading "Für den Dip:" style label with the ingredients inline after it.
  const groupInline = text.match(
    /^(Für [^:]{2,40}|zum Würzen[^:]{0,30}|optional für [^:]{0,30}):\s*(.+)$/i
  );
  if (groupInline && new RegExp(`(?:${NUM})`).test(groupInline[2])) {
    out.name = groupInline[2].trim();
    out.prefix = groupInline[1].trim();
    out.scale = false; // a comma-run of several items - scale the group, not the line
    out.compound = true;
    return out;
  }

  let rest = text;
  let optional = false;
  const opt = rest.match(/^(optional|nach Belieben|evtl\.?|eventuell)\s*:?\s*/i);
  if (opt) {
    optional = true;
    rest = rest.slice(opt[0].length);
  }

  const approxM = rest.match(/^(ca\.?|circa|etwa|gut|knapp|rund|je)\s+/i);
  if (approxM) {
    out.approx = true;
    rest = rest.slice(approxM[0].length);
  }

  // "Saft einer halben Zitrone", "Saft ½ Orange", "Zitronensaft von 1 Zitrone"
  const juice = rest.match(
    new RegExp(
      `^((?:\\w+saft|Saft|Abrieb)(?:\\s+und\\s+Abrieb)?)\\s+(?:von\\s+)?(einer halben|einer|eine|${NUM})?\\s*(.*)$`,
      "i"
    )
  );
  if (juice && !/^\d/.test(rest)) {
    // Kept as prefix + count + fruit so scaling reads "Saft von 2 Zitronen"
    // rather than the nonsensical "2 Saft Zitrone".
    out.qty = /halben/i.test(juice[2] || "") ? 0.5 : num(juice[2]) ?? 1;
    out.unit = null;
    out.prefix = juice[1].trim();
    out.name = juice[3].replace(/\s+/g, " ").trim();
    out.optional = optional;
    out.scale = true;
    out.juice = true;
    return out;
  }

  const wordNum = rest.match(
    /^(ein|eine|einen|einer|zwei|drei|vier|fünf|sechs|acht|zehn)\s+(halbe[nr]?\s+)?/i
  );
  // Two stages: take the count first, then look for a unit behind an optional
  // size adjective. If no unit follows, that adjective stays part of the name.
  const unitRe = new RegExp(`^(?:(${SIZE_ADJ})\\s+)?(${UNIT_ALT})\\b\\.?\\s*`, "i");
  const m = rest.match(new RegExp(`^(${NUM})\\s*(?:[-–—]\\s*(${NUM}))?\\s*`, "i"));

  if (m) {
    out.qty = num(m[1]);
    out.qtyTo = m[2] ? num(m[2]) : null;
    rest = rest.slice(m[0].length);
    const um = rest.match(unitRe);
    if (um) {
      if (um[1]) out.size = um[1];
      out.unit = UNIT_CANON.get(um[2].toLowerCase()) ?? um[2];
      rest = rest.slice(um[0].length);
    }
  } else if (wordNum) {
    out.qty = (WORD_NUM[wordNum[1].toLowerCase()] ?? 1) * (wordNum[2] ? 0.5 : 1);
    rest = rest.slice(wordNum[0].length);
    const um = rest.match(unitRe);
    if (um) {
      if (um[1]) out.size = um[1];
      out.unit = UNIT_CANON.get(um[2].toLowerCase()) ?? um[2];
      rest = rest.slice(um[0].length);
    }
  }

  // Trailing parenthetical is a note, not part of the name.
  const note = rest.match(/\s*\((.+)\)\s*$/);
  if (note) {
    out.note = note[1].trim();
    rest = rest.slice(0, note.index);
  }

  out.name = rest.replace(/^[,:\s]+|[,;\s]+$/g, "") || text;
  out.optional = optional;
  if (out.unit && NO_SCALE_UNITS.has(out.unit)) out.scale = false;
  if (out.qty == null) out.scale = false;
  // "1 große oder 2 kleine Zwiebeln" carries a second count inside the name, so
  // scaling the first number alone would produce a contradiction.
  if (!out.unit && /\boder\s+(?:\d|ein)/i.test(out.name)) out.scale = false;
  return out;
}

/* --------------------------------------------------- per-post extraction */

function extract(html) {
  const groups = [];
  const steps = [];
  const notes = [];
  let intro = "";
  let yieldInfo = null;
  let group = null;

  const ensureGroup = (title) => {
    group = { title: title || "", items: [] };
    groups.push(group);
    return group;
  };

  // Adds one source line to the current group, expanding a packed
  // "Für die Marinade: a, b, c" line into its own group of real ingredients.
  const addLine = (line) => {
    if (!group) ensureGroup("");
    const comp = splitCompound(line);
    if (!comp) {
      group.items.push(parseIngredient(line));
      return;
    }
    if (!comp.prefix) {
      for (const part of comp.parts) group.items.push(parseIngredient(part));
      return;
    }
    const previous = group;
    ensureGroup(comp.prefix);
    for (const part of comp.parts) group.items.push(parseIngredient(part));
    // Subsequent lines belong to the main list again, not to this sub-recipe.
    group = previous;
  };

  // Footnotes and source lists sit after the method on some posts; they are
  // reference material, not something you do at the stove.
  const isCitation = (line) => /^(studien|quellen|quelle|literatur|fußnoten)\s*:/i.test(line) || /^[¹²³\s]*https?:\/\//i.test(line);

  // Steps come from <br>-joined markup, so collapse the stray newlines.
  const pushStep = (line) => {
    const clean = line.replace(/\s+/g, " ").trim();
    if (!clean) return;
    if (isCitation(clean)) notes.push(clean);
    else steps.push(clean);
  };

  // A chatty line inside the ingredient block that reads like an instruction is
  // the recipe stepping over into its method without a heading to announce it.
  const looksLikeStep = (line) =>
    /\b(verrühren|vermengen|pürieren|mixen|in den Mixer|kochen|backen|braten|schneiden|schälen|erwärmen|rühren|geben, bis|quellen lassen)\b/i.test(
      line
    );

  const aside = html.match(/<aside class="post-ingredients">([\s\S]*?)<\/aside>/);
  if (aside) {
    for (const g of aside[1].matchAll(/<div class="post-ingredients-group">([\s\S]*?)<\/div>/g)) {
      const title = stripTags((g[1].match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [, ""])[1]);
      yieldInfo = yieldInfo || parseYield(title);
      ensureGroup(MAIN_LIST_TITLE.test(title) ? "" : title.replace(/:$/, ""));
      for (const line of liOf(g[1])) {
        // Inside a list a bare "Für das Dressing:" starts a new sub-group.
        const sub = line.match(/^(Für [^:]{2,40}):\s*$/i);
        if (sub) {
          ensureGroup(sub[1]);
          continue;
        }
        if (!STARTS_QTY.test(line) && looksLikeStep(line)) {
          pushStep(line);
          continue;
        }
        if (looksLikeProse(line)) {
          notes.push(line);
          continue;
        }
        addLine(line);
      }
    }
    const stepBlock = html.match(/<div class="post-steps">([\s\S]*?)<\/div>/);
    if (stepBlock) liOf(stepBlock[1]).forEach(pushStep);
    const body = html.match(/<div class="post-body">([\s\S]*?)<\/div>\s*<\/div>/);
    if (body) {
      intro = blocksOf(body[1])
        .filter((b) => /^<p/i.test(b) && !isCaption(b))
        .map(stripTags)
        .filter(Boolean)
        .slice(0, 2)
        .join(" ");
    }
  } else {
    const body = html.match(/<div class="post-body">([\s\S]*?)<\/div>\s*<\/div>/);
    if (!body) return null;
    let mode = "intro";
    const introParts = [];
    for (const block of blocksOf(body[1])) {
      const tag = block.match(/^<(\w+)/)[1].toLowerCase();
      const text = stripTags(block);
      if (!text) continue;
      if (isCaption(block)) continue;

      const isHeading = /^h[1-6]$/.test(tag);
      const startsSteps = /^(zubereitung|anleitung|so geht|und so geht|zubereiten)/i.test(text);
      const startsIngredients =
        /^(zutaten|was du brauchst|was ist drin|rezept für|.{0,30}brauchst du|für den .{0,25}brauchst)/i.test(text);

      // The source is inconsistent: "Zubereitung:" sometimes arrives as a
      // paragraph rather than a heading, so switch on the wording either way.
      if (isHeading || /^[\wÄÖÜäöüß ,.()-]{0,60}:$/.test(text)) {
        if (startsSteps) {
          mode = "steps";
          continue;
        }
        if (startsIngredients) {
          yieldInfo = yieldInfo || parseYield(text);
          mode = "ing";
          ensureGroup("");
          continue;
        }
        if (mode === "ing" && /^(für|zum)\b/i.test(text)) {
          ensureGroup(text.replace(/:$/, ""));
          continue;
        }
        if (mode === "ing" && isHeading) {
          // A bare "(für 2 Portionen):" continuation of the previous heading.
          yieldInfo = yieldInfo || parseYield(text);
          continue;
        }
        if (mode === "intro") continue;
      }

      if (mode === "intro") {
        if (tag === "p") introParts.push(text);
        continue;
      }

      if (mode === "ing") {
        const lines = tag === "ul" || tag === "ol" ? liOf(block) : text.split(/\n+/);
        for (const line of lines.map((s) => s.trim()).filter(Boolean)) {
          if (/^(zubereitung|und so geht)/i.test(line)) {
            mode = "steps";
            continue;
          }
          if (/^\d+[.)]\s/.test(line) && line.split(/\s+/).length > 12) {
            mode = "steps";
            pushStep(line.replace(/^\d+[.)]\s*/, ""));
            continue;
          }
          const sub = line.match(/^(Für [^:]{2,40}):\s*$/i);
          if (sub) {
            ensureGroup(sub[1]);
            continue;
          }
          if (!STARTS_QTY.test(line) && looksLikeStep(line)) {
            mode = "steps";
            pushStep(line);
            continue;
          }
          if (looksLikeProse(line)) {
            notes.push(line);
            continue;
          }
          addLine(line);
        }
        continue;
      }

      if (mode === "steps") {
        const lines = tag === "ul" || tag === "ol" ? liOf(block) : [text];
        for (const line of lines) pushStep(line.replace(/^\d+[.)]\s*/, ""));
      }
    }
    intro = introParts.slice(0, 2).join(" ");
  }

  const cleaned = groups.filter((g) => g.items.length);
  if (!cleaned.length) return null;
  return { intro, groups: cleaned, steps, notes, yield: yieldInfo };
}

/* -------------------------------------------------------------------- main */

const posts = JSON.parse(await readFile(path.join(ROOT, "data/posts.json"), "utf8"));
const recipes = [];
const skipped = [];

for (const post of posts) {
  if (post.kind !== "recipe") continue;
  let html;
  try {
    html = await readFile(path.join(ROOT, post.slug, "index.html"), "utf8");
  } catch {
    skipped.push([post.slug, "keine Seite"]);
    continue;
  }
  const parsed = extract(html);
  if (!parsed) {
    skipped.push([post.slug, "keine Zutaten gefunden"]);
    continue;
  }

  const count = parsed.groups.reduce((n, g) => n + g.items.length, 0);
  if (count < 3) {
    skipped.push([post.slug, `nur ${count} Zutat(en)`]);
    continue;
  }

  recipes.push({
    slug: post.slug,
    title: decode(post.title),
    date: post.date,
    image: post.image,
    hero: post.image.replace(/-thumb\.jpg$/, "-hero.jpg"),
    excerpt: decode(post.excerpt),
    cats: post.cats.map(decode),
    intro: parsed.intro,
    servings: parsed.yield || { count: 4, label: "Portionen", assumed: true },
    groups: parsed.groups,
    steps: parsed.steps,
    notes: parsed.notes,
  });
}

recipes.sort((a, b) => (a.date < b.date ? 1 : -1));

if (DRY) {
  const total = recipes.reduce((n, r) => n + r.groups.reduce((m, g) => m + g.items.length, 0), 0);
  const noQty = [];
  for (const r of recipes)
    for (const g of r.groups) for (const it of g.items) if (it.qty == null) noQty.push(`${r.slug} :: ${it.raw}`);
  console.log(
    `Rezepte: ${recipes.length}  Zutaten: ${total}  ohne Menge: ${noQty.length}  ohne Schritte: ${
      recipes.filter((r) => !r.steps.length).length
    }`
  );
  console.log("\n--- uebersprungen ---");
  for (const [s, why] of skipped) console.log(`  ${s}: ${why}`);
  console.log("\n--- Portionsangaben ---");
  for (const r of recipes)
    console.log(
      `  ${r.servings.assumed ? "?" : " "} ${String(r.servings.count).padStart(2)} ${r.servings.label.padEnd(10)} ${
        r.slug
      }`
    );
  console.log("\n--- ohne erkannte Menge ---");
  for (const l of noQty) console.log("  " + l);
  console.log("\n--- aussortierte Notizen ---");
  for (const r of recipes) for (const n of r.notes) console.log(`  ${r.slug} :: ${n.slice(0, 90)}`);
  process.exit(0);
}

await mkdir(path.join(OUT, "data"), { recursive: true });
await writeFile(path.join(OUT, "data/recipes.json"), JSON.stringify(recipes, null, 1), "utf8");
console.log(`new/data/recipes.json - ${recipes.length} Rezepte`);

const { renderAll } = await import("./kueche-render.mjs");
const written = await renderAll(recipes, OUT);
console.log(`new/index.html, new/einkaufsliste/, ${written} Rezeptseiten unter new/rezept/`);
if (skipped.length) console.log(`uebersprungen: ${skipped.map(([s]) => s).join(", ")}`);
