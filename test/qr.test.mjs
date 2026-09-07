import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qrSvgOf } from "../src/transport/linked-device.mjs";

describe("QR renderer (linked-device)", () => {
  it("produces a scannable-size SVG with sane module count (no 30k-px bug)", () => {
    const svg = qrSvgOf("https://wa.me/settings/linked_devices#2@test123");
    const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    assert.ok(vb, "viewBox present");
    const px = Number(vb[1]);
    // 29-module QR (as sampled live) -> 296px; a sane QR is under ~2000px, never 30k
    assert.ok(px >= 200 && px <= 2000, `sane viewBox px=${px}`);
    const dots = (svg.match(/<rect /g) || []).length;
    assert.ok(dots > 100 && dots < 1500, `reasonable dark-module count: ${dots}`);
    // finder pattern: top-left should have a 7x7 block -> the first rows contain dots
    assert.ok(svg.indexOf("<g fill=\"#000\">") > 0);
  });

  it("renders different inputs differently (not a blank/stub)", () => {
    const a = qrSvgOf("pairing-one");
    const b = qrSvgOf("pairing-two");
    assert.notEqual(a, b);
  });
});