// Bounds on attacker-controlled images. A receipt upload is unauthenticated
// consumer input on the inbound path, so decode and normalisation cost must be
// bounded by the declared limits — not by what the sender chooses.
import { describe, it, assert } from "./helpers.mjs";
import sharp from "sharp";
import { inspectImage, normaliseForOcr, MAX_PIXELS, MAX_ASPECT, MAX_NORMALISED_PIXELS, MAX_BYTES } from "../src/media.mjs";

describe("image limits", () => {
  it("a ribbon-shaped image is refused before any pixel work", async () => {
    // 400 x 100000 is exactly MAX_PIXELS and a few hundred KB on the wire, but
    // width-only upscaling turned it into a 640-megapixel working image and
    // ~57s of CPU inside the inbound path. Any consumer could repeat it.
    const hostile = await sharp({ create: { width: 400, height: 100_000, channels: 3, background: "#888" } }).png().toBuffer();
    assert.ok(hostile.length < MAX_BYTES, "it passes the byte limit");
    assert.equal(400 * 100_000, MAX_PIXELS, "and sits exactly on the pixel limit");
    await assert.rejects(() => inspectImage(hostile), (e) => e.code === "BAD_TYPE", "shape must be refused");
  });

  it("normalisation bounds the working image even for an image that slipped through", async () => {
    const tall = await sharp({ create: { width: 400, height: 40_000, channels: 3, background: "#999" } }).png().toBuffer();
    const started = Date.now();
    const meta = await sharp(await normaliseForOcr(tall)).metadata();
    assert.ok(meta.width * meta.height <= MAX_NORMALISED_PIXELS, `working image ${meta.width}x${meta.height} exceeds the bound`);
    assert.ok(Date.now() - started < 20_000, "and it does not cost a minute of CPU");
  });

  it("a normal receipt photo is still upscaled for OCR", async () => {
    // The bound must not change what the extractor sees for real receipts:
    // small photos are deliberately enlarged to ~1600px so tesseract can read them.
    const normal = await sharp({ create: { width: 800, height: 2000, channels: 3, background: "#eee" } }).jpeg().toBuffer();
    const m = await inspectImage(normal);
    assert.equal(m.width, 800);
    const out = await sharp(await normaliseForOcr(normal)).metadata();
    assert.equal(out.width, 1600, "upscaling to the OCR width is preserved");
    assert.equal(out.height, 4000);
  });

  it("aspect ratios a real receipt can have are accepted", async () => {
    for (const [w, h] of [[600, 2400], [1000, 1000], [2400, 600], [480, 3000]]) {
      const img = await sharp({ create: { width: w, height: h, channels: 3, background: "#fff" } }).jpeg().toBuffer();
      const m = await inspectImage(img);
      assert.equal(m.width, w, `${w}x${h} must be accepted (ratio ${(Math.max(w, h) / Math.min(w, h)).toFixed(1)} <= ${MAX_ASPECT})`);
    }
  });
});
