# Huletts branding in this system

Applied from *Huletts Brand Guidelines 2020* (Brand Kit, pages 4–10). This page
records what was taken from that document, what was decided where the document
does not reach, and where each thing lives, so a future change does not have to
re-derive any of it.

## The mark

Extracted as vector directly from the guidelines PDF, not redrawn. Both approved
colourways ship:

| File | Use |
|---|---|
| `huletts-vertical.svg` | The **primary** lock-up. Use wherever space allows |
| `huletts-horizontal.svg` | Where space is limited |
| `huletts-icon.svg` | The H roundel alone, for favicons and avatars |
| `*-reverse.svg` | The all-white reverse, for red, blue or black grounds |
| `huletts-wave.svg` | The wave device, at its own 13° |
| `favicon.svg` | The roundel, brand red on a light tab, white on a dark one |

They live in `src/web-console/public/brand/` and are served at `/brand/*`.

Four rules from the guidelines are enforced in code rather than left to whoever
writes the next screen:

- **All three elements travel together.** The H icon, *Est. 1892* and the
  wordmark are one lock-up. The `<Brand>` component in `App.jsx` only ever
  renders a complete one; there is no way to ask it for a wordmark on its own.
- **Clear space is the height of the H icon.** That ratio is not the same for the
  two lock-ups, so it is measured from the artwork — the icon is 78% of the
  horizontal lock-up's height and 42% of the vertical one's — and applied as
  padding, which holds at any size.
- **The mark is never restyled.** It ships as artwork, so there is nothing for
  CSS to stretch, recolour or add a shadow to. The reverse is a separate file,
  not a filter.
- **`box-sizing: content-box` on `.brand-mark`.** The global `border-box` rule
  makes padding eat the element's height, which rendered a 30px mark with its
  clear space as a 6px smudge. Worth knowing before someone "tidies" it.

The H in the roundel is a genuine knockout, not a white fill, so the mark sits
correctly on any ground without a second file.

## Colour

The primary palette is exactly two values. Do not alter them.

| Token | Value | Source |
|---|---|---|
| `--huletts-blue` | `#002F87` | Pantone 287 C · C100 M86 Y19 K10 · R0 G47 B135 |
| `--huletts-red` | `#D7282F` | Pantone 1795 C · C10 M97 Y92 K1 · R215 G40 B47 |

**Interaction is blue; red is identity and stop.** This is a decision, not
something the guidelines say. Red is the brand's hero colour, but this is a tool
whose job includes disqualifying a shopper's entry and reporting failed
deliveries, and a red button reads as "stop" to every operator regardless of
what a brand book says. So blue carries every interactive state — navigation,
primary buttons, links, focus — and the single red carries the logo, the wave,
the sign-in label, and destructive actions and errors. One red, two honest
meanings, rather than two reds a tired operator has to tell apart at 5pm.

The secondary palette (speciality sugars and Equisweet) is not used: it is a
product-range system, and nothing in this console is a product. Note also that
the guidelines' secondary table has errors — Treacle and Equisweet Erythritol
both carry the primary blue's RGB values, and "Pantone 27571 C" is not a real
Pantone reference. Worth resolving with the brand owner before anyone uses that
palette for anything.

The artwork in the PDF renders *Est. 1892* at `#1F3D7B`, which is not Pantone
287 C. The extraction normalises it to the specified `#002F87`.

## Type

| Role | Brand font | What ships |
|---|---|---|
| Headlines | Gotham Black | Montserrat 800 |
| Body | Gotham Book | Montserrat 400/600 |
| Emphasis | Nexa Rust Script | not used |

**Gotham is licensed from Hoefler&Co and cannot be redistributed**, so the
console cannot ship in the brand typeface. Montserrat is the closest freely
licensable geometric sans, self-hosted as one 37 kB variable font so there is no
runtime dependency on a font CDN. Both stacks name Gotham *first*: drop a
licensed web kit into `public/brand/fonts/`, add two `@font-face` rules, and the
console picks it up with no other change. See the note in that directory.

Nexa Rust Script is a display face for packaging and posters. It has no place in
a data table and is not loaded.

One cost of the substitution, worth knowing before someone reports it as a bug:
Montserrat's zero has a very tight counter at 600 and above, so at headline sizes
a `0` can read as an `8` at a glance. That is the typeface's own design, not a
misuse of it. It is deliberately not patched with a weight override tuned to
Montserrat, because that override would be wrong the day a Gotham web kit is
dropped in — Gotham's zero is open. The numbers that matter operationally are in
tables at body weight, where it does not arise.

## The 13° slant

The wave and every headline treatment sit at 13°. In this system that angle
appears only on the wave device on the sign-in screen. Slanted text in a console
full of tables and numbers costs legibility for nothing, so headlines are set
upright. The angle is available as `--brand-slant` if a future marketing surface
wants it.

## What is deliberately *not* branded

The **participant's WhatsApp messages**. That copy is campaign content, versioned
and edited by the client under *Campaigns → Content*, not system chrome. Baking
"Huletts" into `DEFAULT_COPY` would put one client's brand into the fallback
every campaign inherits. The campaign name already carries the brand, and the
tagline — *A little Huletts sweetness goes a long way* — is available to use in
that content wherever the client wants it.
