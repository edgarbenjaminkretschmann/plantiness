/* Plantiness Küche — scaling engine, cook mode and shopping list.
   One file for all three pages; each page sets <body data-page="…">.
   No build step, no dependencies, no backend: state lives in localStorage. */

(() => {
  "use strict";

  const DATA_URL = "/new/data/recipes.json";
  const STORE_KEY = "plantiness:kueche:v1";

  /* =============================================================== helpers */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let toastTimer;
  function toast(message) {
    let el = $(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  /* ================================================== quantities & scaling */

  const GLYPHS = [[1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [1 / 2, "½"], [2 / 3, "⅔"], [3 / 4, "¾"]];

  // Round to a step a cook can actually measure. 750 g doubled is 1,5 kg — not
  // 1500,0000001 g — and a tablespoon lands on quarters, never on 1,37.
  function roundQty(value, unit) {
    if (unit === "g" || unit === "ml") {
      if (value >= 500) return Math.round(value / 25) * 25;
      if (value >= 200) return Math.round(value / 10) * 10;
      if (value >= 50) return Math.round(value / 5) * 5;
      if (value >= 10) return Math.round(value);
      return Math.round(value * 2) / 2;
    }
    if (unit === "EL" || unit === "TL") return Math.round(value * 4) / 4;
    if (unit === "kg" || unit === "l") return Math.round(value * 100) / 100;
    if (value >= 10) return Math.round(value);
    return Math.round(value * 2) / 2;
  }

  // Vulgar fractions suit counts and spoons ("1½ Zwiebeln", "½ EL") but not
  // weights: nobody writes "1⅛ kg", they write 1125 g or 1,5 kg.
  const DECIMAL_UNITS = new Set(["g", "ml", "kg", "l"]);

  function fmtNumber(value, unit) {
    if (value == null) return "";
    if (DECIMAL_UNITS.has(unit)) return String(Math.round(value * 100) / 100).replace(".", ",");
    const whole = Math.floor(value + 1e-9);
    const frac = value - whole;
    for (const [v, glyph] of GLYPHS) {
      if (Math.abs(frac - v) < 0.02) return (whole ? whole : "") + glyph;
    }
    if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
    return String(Math.round(value * 100) / 100).replace(".", ",");
  }

  // 1500 g reads better as 1,5 kg — but only when the switch stays clean.
  // 1125 g must stay in grams rather than becoming 1,125 kg. Both ends of a
  // range move together so "1–2 l" never comes out as "1000 ml–2 l".
  function promote(qty, qtyTo, unit) {
    if (unit !== "g" && unit !== "ml") return [qty, qtyTo, unit];
    const values = [qty, qtyTo].filter((v) => v != null);
    if (!values.length || Math.max(...values) < 1000) return [qty, qtyTo, unit];
    if (!values.every((v) => v % 100 === 0)) return [qty, qtyTo, unit];
    return [qty / 1000, qtyTo == null ? null : qtyTo / 1000, unit === "g" ? "kg" : "l"];
  }

  // The full display string for one ingredient at a given scale factor.
  function formatItem(item, factor) {
    const changed = item.scale && Math.abs(factor - 1) > 0.001;
    let qty = item.qty;
    let qtyTo = item.qtyTo;
    if (item.scale && qty != null) {
      qty = roundQty(qty * factor, item.unit);
      qtyTo = qtyTo == null ? null : roundQty(qtyTo * factor, item.unit);
    }
    let unit = item.unit;
    [qty, qtyTo, unit] = promote(qty, qtyTo, unit);

    const parts = [];
    if (item.approx) parts.push("ca.");
    if (qty != null) parts.push(fmtNumber(qty, unit) + (qtyTo != null ? "–" + fmtNumber(qtyTo, unit) : ""));
    if (item.size) parts.push(item.size);
    if (unit) parts.push(unit);
    const lead = parts.join(" ");

    // "Saft von ½ Zitrone" rather than the nonsensical "½ Saft Zitrone".
    const name = item.prefix ? `${item.prefix} von ${item.name}` : item.name;
    return { lead: item.prefix ? "" : lead, inlineLead: item.prefix ? lead : "", name, changed };
  }

  function itemHtml(item, factor) {
    const f = formatItem(item, factor);
    const qtyClass = "qty" + (f.changed ? " changed" : "");
    let html = "";
    if (f.lead) html += `<span class="${qtyClass}">${esc(f.lead)}</span> `;
    if (item.prefix) {
      html += `${esc(item.prefix)} von <span class="${qtyClass}">${esc(f.inlineLead)}</span> ${esc(item.name)}`;
    } else {
      html += esc(item.name);
    }
    if (item.optional) html += ` <span class="flag">optional</span>`;
    if (item.note) html += `<span class="note">${esc(item.note)}</span>`;
    return html;
  }

  /* ========================================================== basket store */

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") {
        return { recipes: parsed.recipes || {}, checked: parsed.checked || {}, extras: parsed.extras || [] };
      }
    } catch {
      /* private mode or blocked site data — fall through to an empty basket */
    }
    return { recipes: {}, checked: {}, extras: [] };
  }

  function saveStore(store) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
      /* nothing we can do; the page still works for this session */
    }
    paintCartCount(store);
  }

  function paintCartCount(store = loadStore()) {
    const n = Object.keys(store.recipes).length;
    $$(".cart-count").forEach((el) => {
      el.textContent = n ? String(n) : "";
      el.dataset.empty = n ? "0" : "1";
    });
  }

  /* ================================================ ingredient aisle table */

  const AISLES = [
    ["Obst & Gemüse", /apfel|äpfel|avocado|banane|beere|birne|blaubeer|blumenkohl|brokkoli|chicor|cranberr|datteln?|erbsen|frühlingszwiebel|granatapfel|grünkohl|gurke|heidelbeer|himbeer|hokkaido|ingwer|jackfruit|kaki|karotte|kartoffel|knoblauch|koriander|kresse|kürbis|kurkuma|limette|lauch|mairübe|mandarine|minze|orange|pak choi|paprika|pastinake|petersilie|pfifferling|pilz|radieschen|rote bete|rucola|salat|schalotte|schnittlauch|sellerie|sharon|spargel|spinat|sprossen|steinpilz|süßkartoffel|tomate|wirsing|zitrone|zucchini|zwiebel|champignon|bärlauch|kohl|banane/i],
    ["Kühlregal", /milch|drink|cuisine|sahne|joghurt|tofu|margarine|butter|seidentofu|pflanzendrink|hafermilch|mandelmilch|sojamilch|kichererbsenwasser/i],
    ["Trockenwaren", /mehl|haferflocken|hafer|hirse|quinoa|buchweizen|reis|linsen|bohnen|kichererbs|couscous|nudel|amaranth|granola|müsli|semmelbrösel|brezen|brot|brötchen|toast|fladen|nori|zucker|xylit|backpulver|agar|hefeflocken|schokolade|kakao|marzipan|kokos|trockenhefe/i],
    ["Nüsse & Saaten", /mandel|cashew|walnuss|walnüsse|pekan|paranuss|paranüsse|haselnuss|pinienkern|sesam|leinsam|chiasam|sonnenblumenkern|kürbiskern|nuss|nüsse|mohn|kerne/i],
    ["Öl, Essig & Würze", /öl|essig|sojasauce|balsamico|tahin|sesammus|mus|sirup|agavendicksaft|ahornsirup|reissirup|senf|miso|tomatenmark|salz|pfeffer|muskat|zimt|vanille|curry|paprikapulver|kreuzkümmel|cumin|chili|gewürz|anis|kardamom|nelken|majoran|wacholder|lorbeer|loorbeer|kräuter|brühe|kala namak|ashwagandha|reishi|barbecue|sauce/i],
  ];

  // Filler that carries no clue about which step an ingredient belongs to.
  const HEAD_STOPWORDS = new Set([
    "etwas", "oder", "und", "zum", "zur", "für", "nach", "mehr", "wenig", "ganz", "ganze",
    "belieben", "geschmack", "wahl", "jede", "jeder", "eine", "einen", "optional", "alternativ",
  ]);

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function aisleOf(name) {
    for (const [label, re] of AISLES) if (re.test(name)) return label;
    return "Sonstiges";
  }

  // Strip preparation adjectives that do not change what you put in the basket.
  // Colour words stay: "rote Bete" and "rote Zwiebel" are different purchases.
  const PREP_ADJ =
    /^(frische[rnms]?|frisch|gemahlene[rnms]?|geriebene[rnms]?|gehackte[rnms]?|geschrotete[rnms]?|getrocknete[rnms]?|gekochte[rnms]?|gekeimte[rnms]?|feine[rnms]?|zarte[rnms]?|glatte[rnms]?|reife[rnms]?|kleine[rnms]?|große[rnms]?|mittelgroße[rnms]?|bunte[rnms]?)\s+/i;

  // Vague leading quantities. Dropping them lets "etwas Salz und Pfeffer" and
  // "Salz und Pfeffer" count as the same thing, both on the shopping list and
  // when matching ingredients to a cooking step.
  const VAGUE_QTY = /^(etwas|optional|nach belieben|je nach geschmack|evtl\.?|eventuell|frisch)\s+/i;

  function normName(name) {
    let n = name
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .replace(/[.,;:!?]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    let previous;
    do {
      previous = n;
      n = n.replace(VAGUE_QTY, "").replace(PREP_ADJ, "");
    } while (n !== previous);
    return n.trim();
  }

  /* ============================================================ index page */

  async function initIndex() {
    const grid = $("#recipe-grid");
    const search = $("#search");
    const chipRow = $("#chips");
    let recipes = [];
    let filter = "all";

    try {
      recipes = await (await fetch(DATA_URL)).json();
    } catch {
      grid.innerHTML = `<div class="empty-state"><h3>Rezepte konnten nicht geladen werden.</h3><p>Bitte lade die Seite neu.</p></div>`;
      return;
    }

    const cats = new Map();
    for (const r of recipes) {
      for (const c of r.cats) {
        if (c === "Rezepte") continue;
        cats.set(c, (cats.get(c) || 0) + 1);
      }
    }
    const top = [...cats.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
    chipRow.innerHTML =
      `<button class="chip" aria-pressed="true" data-cat="all">Alle ${recipes.length}</button>` +
      top.map(([c, n]) => `<button class="chip" aria-pressed="false" data-cat="${esc(c)}">${esc(c)} ${n}</button>`).join("");

    // Searchable haystack: title, category and every ingredient name, so
    // "cashew" or "grünkohl" finds recipes whose title never mentions them.
    const haystacks = new Map(
      recipes.map((r) => [
        r.slug,
        [r.title, r.cats.join(" "), r.groups.flatMap((g) => g.items.map((i) => i.name)).join(" ")]
          .join(" ")
          .toLowerCase(),
      ])
    );

    const render = () => {
      const q = search.value.trim().toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      const hits = recipes.filter((r) => {
        if (filter !== "all" && !r.cats.includes(filter)) return false;
        const hay = haystacks.get(r.slug);
        return terms.every((t) => hay.includes(t));
      });

      if (!hits.length) {
        grid.innerHTML = `<div class="empty-state"><h3>Nichts gefunden.</h3><p>Versuch’s mit einer Zutat wie „Kichererbsen“ oder „Grünkohl“.</p></div>`;
        return;
      }

      grid.innerHTML = hits
        .map((r) => {
          const count = r.groups.reduce((n, g) => n + g.items.length, 0);
          const cat = r.cats.find((c) => c !== "Rezepte") || "Rezept";
          return `<article class="r-card"><a href="/new/rezept/${esc(r.slug)}/">
            <div class="shot"><img src="${esc(r.image)}" alt="" loading="lazy" /></div>
            <div class="body">
              <p class="tag">${esc(cat)}</p>
              <h3>${esc(r.title)}</h3>
              <p class="meta"><span>${r.servings.count} ${esc(r.servings.label)}</span><span>${count} Zutaten</span><span>${r.steps.length} Schritte</span></p>
            </div></a></article>`;
        })
        .join("");
    };

    search.addEventListener("input", render);
    chipRow.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      filter = chip.dataset.cat;
      $$(".chip", chipRow).forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
      render();
    });
    render();
  }

  /* =========================================================== recipe page */

  function initRecipe() {
    const recipe = JSON.parse($("#recipe-data").textContent);
    const base = recipe.servings.count;
    const store = loadStore();
    let servings = store.recipes[recipe.slug] || base;

    const valueEl = $("#servings-value");
    const minus = $("#servings-minus");
    const plus = $("#servings-plus");
    const resetBtn = $("#servings-reset");
    const addBtn = $("#add-to-list");

    const factor = () => servings / base;

    const paint = () => {
      valueEl.innerHTML = `${servings}<small>${esc(recipe.servings.label)}</small>`;
      minus.disabled = servings <= 1;
      plus.disabled = servings >= base * 12;
      resetBtn.hidden = servings === base;

      $$("[data-group]").forEach((groupEl) => {
        const gi = Number(groupEl.dataset.group);
        $$("li", groupEl).forEach((li) => {
          const item = recipe.groups[gi].items[Number(li.dataset.index)];
          $(".txt", li).innerHTML = itemHtml(item, factor());
        });
      });

      // Reflect the current portion count in the URL so a scaled recipe can be
      // shared or bookmarked as-is.
      const url = new URL(location.href);
      if (servings === base) url.searchParams.delete("portionen");
      else url.searchParams.set("portionen", String(servings));
      history.replaceState(null, "", url);

      if (store.recipes[recipe.slug]) {
        store.recipes[recipe.slug] = servings;
        saveStore(store);
      }
    };

    const fromUrl = Number(new URLSearchParams(location.search).get("portionen"));
    if (Number.isFinite(fromUrl) && fromUrl >= 1 && fromUrl <= base * 12) servings = fromUrl;

    minus.addEventListener("click", () => {
      servings = Math.max(1, servings - 1);
      paint();
    });
    plus.addEventListener("click", () => {
      servings = Math.min(base * 12, servings + 1);
      paint();
    });
    resetBtn.addEventListener("click", () => {
      servings = base;
      paint();
    });

    const syncAddBtn = () => {
      const inList = Boolean(loadStore().recipes[recipe.slug]);
      addBtn.classList.toggle("added", inList);
      addBtn.querySelector("span").textContent = inList ? "Auf der Einkaufsliste" : "Auf die Einkaufsliste";
    };

    addBtn.addEventListener("click", () => {
      const s = loadStore();
      if (s.recipes[recipe.slug]) {
        delete s.recipes[recipe.slug];
        saveStore(s);
        toast("Von der Einkaufsliste entfernt");
      } else {
        s.recipes[recipe.slug] = servings;
        saveStore(s);
        toast(`„${recipe.title}“ für ${servings} ${recipe.servings.label} hinzugefügt`);
      }
      store.recipes = loadStore().recipes;
      syncAddBtn();
    });

    paint();
    syncAddBtn();
    decorateTimers(document);
    $("#start-cook").addEventListener("click", () => openCook(recipe, factor));
  }

  /* ============================================================== timers */

  const TIME_RE = /(\d+)\s*(?:[-–]\s*(\d+))?\s*(Minuten|Minute|Sekunden|Sekunde|Stunden|Stunde|Min\.?|Std\.?)\b/gi;

  // Turns "ca. 15-20 Minuten quellen lassen" into a tappable countdown without
  // touching the surrounding text nodes.
  function decorateTimers(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement.closest(".timer-chip, script, style, .ing-panel")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const targets = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement.closest("[data-timers]") && TIME_RE.test(n.nodeValue)) targets.push(n);
      TIME_RE.lastIndex = 0;
    }
    for (const node of targets) {
      const frag = document.createDocumentFragment();
      let last = 0;
      node.nodeValue.replace(TIME_RE, (match, a, b, unitWord, offset) => {
        frag.append(node.nodeValue.slice(last, offset));
        const unit = /std|stunde/i.test(unitWord) ? 3600 : /sek/i.test(unitWord) ? 1 : 60;
        const minutes = Number(b || a) * unit;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "timer-chip";
        chip.dataset.seconds = String(minutes);
        chip.textContent = `⏱ ${match.trim()}`;
        frag.append(chip);
        last = offset + match.length;
        return match;
      });
      frag.append(node.nodeValue.slice(last));
      node.parentNode.replaceChild(frag, node);
    }
  }

  let audioCtx;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < 3; i++) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain).connect(audioCtx.destination);
        osc.frequency.value = 880;
        const t = audioCtx.currentTime + i * 0.45;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        osc.start(t);
        osc.stop(t + 0.32);
      }
    } catch {
      /* audio is a nicety; the toast still fires */
    }
  }

  const activeTimers = new WeakMap();

  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".timer-chip");
    if (!chip) return;
    e.preventDefault();
    const running = activeTimers.get(chip);
    if (running) {
      clearInterval(running.id);
      activeTimers.delete(chip);
      chip.classList.remove("running");
      chip.textContent = running.label;
      return;
    }
    const label = chip.textContent;
    let left = Number(chip.dataset.seconds);
    chip.classList.add("running");
    const tick = () => {
      const m = Math.floor(left / 60);
      const s = left % 60;
      chip.textContent = `⏱ ${m}:${String(s).padStart(2, "0")}`;
      if (left <= 0) {
        clearInterval(id);
        activeTimers.delete(chip);
        chip.classList.remove("running");
        chip.textContent = label;
        beep();
        toast("Timer abgelaufen!");
      }
      left--;
    };
    const id = setInterval(tick, 1000);
    activeTimers.set(chip, { id, label });
    tick();
  });

  /* =========================================================== cook mode */

  function openCook(recipe, factorFn) {
    const flat = recipe.groups.flatMap((g) => g.items);
    // Match ingredients to steps on the head noun, so "Die Kartoffeln schälen"
    // pulls up "750 g Kartoffeln" without a full NLP pass.
    const keyed = flat.map((item) => {
      // "etwas Salz und Pfeffer" must not attach itself to every step that
      // happens to contain the word "etwas", so filler words never become the
      // key we match on.
      const head =
        normName(item.name)
          .split(" ")
          .find((w) => w.length > 3 && !HEAD_STOPWORDS.has(w)) || "";
      return { item, head: escapeRe(head.replace(/(en|n|e|s)$/, "")) };
    });

    const el = document.createElement("div");
    el.className = "cook";
    el.innerHTML = `
      <div class="cook-top">
        <span class="who">${esc(recipe.title)}</span>
        <button class="close" aria-label="Kochmodus beenden">×</button>
      </div>
      <div class="cook-progress"><i style="width:0%"></i></div>
      <div class="cook-stage"><div class="inner"></div></div>
      <div class="cook-nav">
        <button class="prev">← Zurück</button>
        <button class="next">Weiter →</button>
      </div>
      <p class="cook-hint"><span class="keys">Pfeiltasten zum Blättern · Esc beendet · </span><span class="touch">Wischen zum Blättern · </span>Display bleibt an</p>`;
    document.body.appendChild(el);
    document.body.style.overflow = "hidden";

    let index = 0;
    let wakeLock = null;

    const requestWake = async () => {
      try {
        wakeLock = await navigator.wakeLock.request("screen");
      } catch {
        /* unsupported or denied — cooking still works, the screen may dim */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !wakeLock) requestWake();
    };
    requestWake();
    document.addEventListener("visibilitychange", onVisibility);

    const stage = $(".inner", el);

    const paint = () => {
      const total = recipe.steps.length;
      const text = recipe.steps[index];
      // Several groups can carry the same seasoning ("Salz und Pfeffer" once
      // for the dough and once for the filling) — show it as one chip.
      const seen = new Set();
      const used = keyed.filter((k) => {
        if (k.head.length <= 2 || !new RegExp("\\b" + k.head, "i").test(text)) return false;
        const id = normName(k.item.name);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      $(".cook-progress i", el).style.width = `${((index + 1) / total) * 100}%`;

      stage.innerHTML = `
        <p class="cook-num">Schritt ${index + 1} von ${total}</p>
        <div class="cook-text" data-timers>${esc(text)}</div>
        ${
          used.length
            ? `<div class="cook-ings"><p class="eyebrow">Dafür brauchst du</p><ul>${used
                .map(({ item }) => {
                  const f = formatItem(item, factorFn());
                  const lead = f.lead || f.inlineLead;
                  return `<li>${lead ? `<b>${esc(lead)}</b> ` : ""}${esc(item.name)}</li>`;
                })
                .join("")}</ul></div>`
            : ""
        }`;
      decorateTimers(stage);
      $(".prev", el).disabled = index === 0;
      $(".next", el).textContent = index === total - 1 ? "Fertig ✓" : "Weiter →";
      $(".cook-stage", el).scrollTop = 0;
    };

    const close = () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
      if (wakeLock) wakeLock.release().catch(() => {});
      document.body.style.overflow = "";
      el.remove();
    };

    const go = (delta) => {
      const next = index + delta;
      if (next < 0) return;
      if (next >= recipe.steps.length) {
        close();
        toast("Guten Appetit! 🌱");
        return;
      }
      index = next;
      paint();
    };

    const onKey = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") go(-1);
    };

    $(".close", el).addEventListener("click", close);
    $(".prev", el).addEventListener("click", () => go(-1));
    $(".next", el).addEventListener("click", () => go(1));
    document.addEventListener("keydown", onKey);

    let touchX = null;
    $(".cook-stage", el).addEventListener("touchstart", (e) => {
      touchX = e.changedTouches[0].clientX;
    }, { passive: true });
    $(".cook-stage", el).addEventListener("touchend", (e) => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
      touchX = null;
    }, { passive: true });

    paint();
  }

  /* ======================================================== shopping list */

  async function initList() {
    const root = $("#list-root");
    const basket = $("#basket");
    let recipes;
    try {
      recipes = await (await fetch(DATA_URL)).json();
    } catch {
      root.innerHTML = `<div class="empty-state"><h3>Liste konnte nicht geladen werden.</h3></div>`;
      return;
    }
    const bySlug = new Map(recipes.map((r) => [r.slug, r]));

    const render = () => {
      const store = loadStore();
      const chosen = Object.entries(store.recipes)
        .map(([slug, servings]) => ({ recipe: bySlug.get(slug), servings }))
        .filter((x) => x.recipe);

      basket.innerHTML = chosen
        .map(
          ({ recipe, servings }) => `<span class="basket-item">
            <a href="/new/rezept/${esc(recipe.slug)}/">${esc(recipe.title)}</a>
            <span class="srv">${servings} ${esc(recipe.servings.label)}</span>
            <button data-remove="${esc(recipe.slug)}" aria-label="„${esc(recipe.title)}“ entfernen">×</button>
          </span>`
        )
        .join("");

      if (!chosen.length) {
        root.innerHTML = `<div class="empty-state">
          <h3>Deine Einkaufsliste ist leer.</h3>
          <p>Öffne ein Rezept, stell die Portionen ein und tippe auf „Auf die Einkaufsliste“.</p>
          <p style="margin-top:22px"><a class="btn primary" href="/new/">Rezepte durchstöbern</a></p>
        </div>`;
        $("#list-actions").hidden = true;
        return;
      }
      $("#list-actions").hidden = false;

      // Merge identical ingredients across recipes. Same normalised name AND
      // same unit can be summed; anything else stays its own line so we never
      // invent a total that mixes grams with "etwas".
      const merged = new Map();
      for (const { recipe, servings } of chosen) {
        const factor = servings / recipe.servings.count;
        for (const group of recipe.groups) {
          for (const item of group.items) {
            const norm = normName(item.name);
            if (!norm) continue;
            const key = `${norm}|${item.unit || "-"}|${item.scale && item.qty != null ? "n" : "x"}`;
            const entry = merged.get(key) || {
              name: item.name,
              unit: item.unit,
              qty: null,
              optional: true,
              from: new Set(),
              aisle: aisleOf(item.name),
            };
            if (item.scale && item.qty != null) {
              entry.qty = (entry.qty || 0) + item.qty * factor;
            }
            // Keep the most descriptive spelling we have seen for this item.
            if (item.name.length > entry.name.length) entry.name = item.name;
            if (!item.optional) entry.optional = false;
            entry.from.add(recipe.title);
            merged.set(key, entry);
          }
        }
      }

      const order = [...AISLES.map(([label]) => label), "Sonstiges"];
      const byAisle = new Map(order.map((a) => [a, []]));
      for (const entry of merged.values()) byAisle.get(entry.aisle).push(entry);

      root.innerHTML = order
        .filter((a) => byAisle.get(a).length)
        .map((aisle) => {
          const rows = byAisle
            .get(aisle)
            .sort((a, b) => a.name.localeCompare(b.name, "de"))
            .map((entry) => {
              const id = `${aisle}:${entry.name}:${entry.unit || ""}`;
              const done = Boolean(store.checked[id]);
              let qty = entry.qty;
              let unit = entry.unit;
              if (qty != null) {
                qty = roundQty(qty, unit);
                let to;
                [qty, to, unit] = promote(qty, null, unit);
              }
              const label = qty != null ? `${fmtNumber(qty, unit)}${unit ? " " + unit : ""}` : "";
              return `<li><label>
                <input type="checkbox" data-check="${esc(id)}"${done ? " checked" : ""} />
                <span><span class="name">${esc(entry.name)}</span>${
                entry.optional ? ' <span class="flag">optional</span>' : ""
              }<span class="from">${esc([...entry.from].join(" · "))}</span></span>
                <span class="qty">${esc(label)}</span>
              </label></li>`;
            })
            .join("");
          return `<section class="aisle"><h2>${esc(aisle)}</h2><ul>${rows}</ul></section>`;
        })
        .join("");
    };

    basket.addEventListener("click", (e) => {
      const slug = e.target.closest("[data-remove]")?.dataset.remove;
      if (!slug) return;
      const store = loadStore();
      delete store.recipes[slug];
      saveStore(store);
      render();
    });

    root.addEventListener("change", (e) => {
      const id = e.target.dataset?.check;
      if (!id) return;
      const store = loadStore();
      if (e.target.checked) store.checked[id] = true;
      else delete store.checked[id];
      saveStore(store);
    });

    $("#clear-list").addEventListener("click", () => {
      saveStore({ recipes: {}, checked: {}, extras: [] });
      render();
      toast("Einkaufsliste geleert");
    });

    $("#copy-list").addEventListener("click", async () => {
      const text = $$(".aisle")
        .map((sec) => {
          const head = $("h2", sec).textContent;
          const lines = $$("li", sec)
            .filter((li) => !$("input", li).checked)
            .map((li) => `- ${$(".qty", li).textContent} ${$(".name", li).textContent}`.replace(/\s+/g, " ").trim());
          return lines.length ? `${head}\n${lines.join("\n")}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
      const payload = `Einkaufsliste — Plantiness Küche\n\n${text}`;
      try {
        if (navigator.share) await navigator.share({ title: "Einkaufsliste", text: payload });
        else {
          await navigator.clipboard.writeText(payload);
          toast("Liste kopiert");
        }
      } catch {
        /* the user dismissed the share sheet — nothing to report */
      }
    });

    render();
  }

  /* ================================================================= boot */

  paintCartCount();
  const page = document.body.dataset.page;
  if (page === "index") initIndex();
  else if (page === "recipe") initRecipe();
  else if (page === "list") initList();
})();
