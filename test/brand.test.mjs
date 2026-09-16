// Huletts branding: the invariants that survive a redesign.
//
// A brand breaks in software by drift, not by a single wrong commit — a hex
// value typed by hand, a lock-up cropped to "just the wordmark", a reverse logo
// faked with a CSS filter. These tests pin the things the guidelines actually
// require, so the next person to touch the stylesheet finds out here.
import { describe, it, assert } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const BRAND = "src/web-console/public/brand";

describe("Huletts branding", () => {
  it("both approved colourways of every lock-up are present and are real artwork", () => {
    for (const name of ["huletts-vertical", "huletts-horizontal", "huletts-icon"]) {
      for (const variant of ["", "-reverse"]) {
        const svg = read(`${BRAND}/${name}${variant}.svg`);
        assert.match(svg, /^<svg[^>]*viewBox="/, `${name}${variant} must be a real SVG with a viewBox`);
        assert.ok(svg.includes("<path"), `${name}${variant} must be vector paths, not an embedded raster`);
        // The reverse is a separate file because the guidelines call for an
        // all-white logo on red, blue and black — not a filtered colour one.
        const fills = [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase());
        assert.ok(fills.length, `${name}${variant} has no fills`);
        if (variant === "-reverse") assert.ok(fills.every((f) => f === "#FFFFFF"), `${name}-reverse must be all white, got ${[...new Set(fills)]}`);
        else assert.ok(fills.every((f) => ["#D7282F", "#002F87"].includes(f)), `${name} may only use the primary palette, got ${[...new Set(fills)]}`);
      }
    }
  });

  it("the primary palette is exactly the two specified values", () => {
    const css = read("src/web-console/src/styles.css");
    assert.match(css, /--huletts-blue:\s*#002F87/i, "Pantone 287 C");
    assert.match(css, /--huletts-red:\s*#D7282F/i, "Pantone 1795 C");
  });

  it("no screen hand-types a near-miss of a brand colour", () => {
    // A stray #b42318 next to a #D7282F logo reads as a printing fault, and the
    // two are indistinguishable in a code review. Every surface uses the token.
    // The legacy *.original.* files are the superseded desk and are not built.
    const root = "src/web-console/src";
    const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const files = walk(root).filter((f) => /\.(jsx?|css)$/.test(f) && !f.includes(".original."));
    assert.ok(files.length > 5, "found the console sources");
    const strays = ["#1f6f5f", "#b42318", "#d7292e", "#1f3d7b", "rgba(180,35,24"];
    for (const f of files) {
      const body = read(f).toLowerCase();
      for (const stray of strays) {
        assert.ok(!body.includes(stray), `${f} hand-types ${stray}; use var(--danger) / var(--warn) / the brand token`);
      }
    }
  });

  it("the mark is never restyled, stretched or faked in CSS", () => {
    const css = read("src/web-console/src/styles.css");
    const rules = css.split("}").filter((r) => r.includes(".brand-mark") || r.includes(".gate-logo"));
    assert.ok(rules.length, "the mark has styles");
    for (const r of rules) {
      for (const banned of ["filter:", "transform: scale", "box-shadow", "background-image"]) {
        assert.ok(!r.includes(banned), `"do not add any graphic styling": found ${banned} on the mark`);
      }
    }
    // Clear space only works if the padding sits outside the artwork's height.
    assert.match(css, /\.brand-mark\s*\{[^}]*box-sizing:\s*content-box/, "clear space must not eat the mark's height");
  });

  it("every lock-up rendered by the console is complete", () => {
    // The guidelines: the icon, Est. 1892 and the wordmark are used in
    // combination. The component is the only way to render one, and it only
    // ever names a whole lock-up file.
    const app = read("src/web-console/src/App.jsx");
    const lockups = [...app.matchAll(/huletts-\$\{lockup\}|huletts-([a-z]+)(-reverse)?\.svg/g)].map((m) => m[0]);
    assert.ok(lockups.length, "the Brand component builds a lock-up filename");
    assert.ok(!/huletts-wordmark/.test(app), "the wordmark is never used on its own");
    assert.match(app, /CLEAR_SPACE\s*=\s*\{/, "clear space is derived, not guessed");
  });

  it("the console carries the brand in its title, icon and theme colour", () => {
    const html = read("src/web-console/index.html");
    assert.match(html, /<title>Huletts[^<]*<\/title>/);
    assert.match(html, /rel="icon"[^>]*\/brand\/favicon\.svg/);
    assert.match(html, /theme-color"\s+content="#002F87"/i);
    assert.ok(!html.includes("fonts.googleapis.com"), "the font is self-hosted; no CDN preconnect should remain");
  });

  it("the brand typeface is named first and the substitute is self-hosted", () => {
    const css = read("src/web-console/src/styles.css");
    assert.match(css, /--font-display:\s*"Gotham Black"/, "a licensed Gotham must take over with no code change");
    assert.match(css, /--font-body:\s*"Gotham Book"/);
    assert.match(css, /src:\s*url\("\/brand\/fonts\/montserrat-latin\.woff2"\)/, "self-hosted, not fetched from a CDN");
    assert.ok(fs.existsSync(path.join(ROOT, BRAND, "fonts/montserrat-latin.woff2")), "the font file ships");
    assert.ok(fs.existsSync(path.join(ROOT, BRAND, "fonts/OFL.txt")), "its licence ships with it");
  });

  it("the participant's WhatsApp copy stays client-neutral", () => {
    // DEFAULT_COPY is the fallback every campaign inherits. One client's brand
    // does not belong in it; the campaign name and content version carry that.
    const copy = read("src/copy.mjs");
    assert.ok(!/huletts/i.test(copy), "no client brand in the shared copy fallback");
  });

  it("the built bundle actually ships the brand assets", () => {
    for (const f of ["huletts-horizontal.svg", "huletts-vertical.svg", "favicon.svg", "fonts/montserrat-latin.woff2"]) {
      assert.ok(fs.existsSync(path.join(ROOT, "src/web-console-dist/brand", f)), `${f} is missing from the built console — run npm run web:build`);
    }
  });
});
