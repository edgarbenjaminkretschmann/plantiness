# Plantiness Küche (`/new/`)

A self-contained cooking layer over the existing recipe posts. **Nothing outside
this folder is read at runtime and nothing outside it is written by the build.**

## What it does

- **Portionsrechner** — every quantity rescales live, rounded to something you
  can actually measure (`750 g` doubled is `1,5 kg`, never `1500,0000001 g`).
  The chosen portion count is mirrored into `?portionen=N` so a scaled recipe
  is shareable.
- **Kochmodus** — full-screen, one step at a time, with the ingredients for that
  step, tappable countdown timers, and a screen wake lock.
- **Einkaufsliste** — recipes collect into a basket, ingredients merge across
  them and sort by supermarket aisle. State lives in `localStorage`.

## Build

    node scripts/kueche-build.mjs          # parse + write data and pages
    node scripts/kueche-build.mjs --dry    # parse only, print a parse report

`scripts/kueche-build.mjs` parses the already-published post pages in the repo
(not the WordPress API), so the build is reproducible offline. It turns prose
like `750 g Kartoffeln (Schälgewicht ca. 580g)` into
`{qty: 750, unit: "g", name: "Kartoffeln", note: "Schälgewicht ca. 580g"}`.
`scripts/kueche-render.mjs` writes the pages from that data.

Generated (do not edit by hand):

    new/data/recipes.json
    new/index.html
    new/einkaufsliste/index.html
    new/rezept/<slug>/index.html

Hand-written: `kueche.css`, `kueche.js`, this file.

## Notes for whoever picks this up

- `kueche.css` deliberately does **not** import `/styles.css`. The design tokens
  are copied so the main site and this subsection cannot break each other.
- Pages are complete without JavaScript: quantities render server-side at the
  recipe's own portion count, and `kueche.js` only takes over the scaling.
- `formatItem()` in `kueche.js` and `renderItem()` in `kueche-render.mjs` must
  agree at scale factor 1 — they are the same formatter in two places.
- 40 of 41 recipes parse. `himmlisches-bananeneis-mit-schoko-und-karamell` is
  skipped because the original post has no ingredient list at all, only prose.
- 18 recipes state no yield in the source. Those assume 4 portions and say so
  in the UI (`servings.assumed`) rather than pretending to know.
- Quantities marked `scale: false` are left alone on purpose: "1 Prise",
  "etwas Salz", and lines like "1 große oder 2 kleine Zwiebeln" that carry a
  second count inside the name.
