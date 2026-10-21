import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRegions, carryOverMaterials, polygonStats } from "../js/region-carryover.js";

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

test("polygonStats returns area and centroid", () => {
  const s = polygonStats(rect(0, 0, 4, 2));
  assert.equal(s.area, 8);
  assert.equal(s.cx, 2);
  assert.equal(s.cy, 1);
});

test("regions keep their material after ids shift and the section grows", () => {
  const old = [
    { regId: 1, layer: "기초", poly: rect(0, 0, 20, 5) },
    { regId: 2, layer: "성토", poly: rect(0, 5, 20, 8) },
  ];
  // 새 DXF 는 순서가 뒤바뀌고 성토 높이가 8 → 10 m 로 커졌다.
  const next = [
    { regId: 1, layer: "성토", poly: rect(0, 5, 20, 10) },
    { regId: 2, layer: "기초", poly: rect(0, 0, 20, 5) },
  ];
  const m = matchRegions(old, next);
  assert.equal(m.get(1).oldId, 2);
  assert.equal(m.get(2).oldId, 1);
  assert.equal(m.get(2).confident, true);

  const out = {};
  const n = carryOverMaterials({ 1: 7, 2: 9 }, out, m);
  assert.equal(n, 2);
  assert.deepEqual(out, { 1: 9, 2: 7 });
});

test("a region is never matched across layers or reused twice", () => {
  const old = [{ regId: 1, layer: "A", poly: rect(0, 0, 10, 10) }];
  const next = [
    { regId: 1, layer: "B", poly: rect(0, 0, 10, 10) },
    { regId: 2, layer: "A", poly: rect(0, 0, 10, 10) },
    { regId: 3, layer: "A", poly: rect(1, 0, 10, 10) },
  ];
  const m = matchRegions(old, next);
  assert.equal(m.has(1), false);
  assert.equal(m.get(2).oldId, 1);
  assert.equal(m.has(3), false);
});

test("a far-away region is left unmatched", () => {
  const m = matchRegions(
    [{ regId: 1, layer: "A", poly: rect(0, 0, 10, 10) }],
    [{ regId: 1, layer: "A", poly: rect(500, 0, 10, 10) }],
  );
  assert.equal(m.size, 0);
});
