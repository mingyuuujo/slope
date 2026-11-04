import assert from "node:assert/strict";
import { test } from "node:test";
import { initResultViewer, moveCropRect, renderResultCanvas, verticalCropBounds } from "../js/result-viewer.js";

test("vertical crop keeps a visible region when both edges move", () => {
  assert.deepEqual(verticalCropBounds(524, 24, 32), { top: 24, bottom: 492 });
  assert.deepEqual(verticalCropBounds(100, 90, 90), { top: 50, bottom: 100 });
});

test("moving the crop keeps its size inside the canvas", () => {
  assert.deepEqual(moveCropRect(1000, 500, 100, 20, 700, 400, 60, 30),
    { left: 160, right: 860, top: 50, bottom: 50 });
  assert.deepEqual(moveCropRect(1000, 500, 100, 20, 700, 400, 900, -200),
    { left: 300, right: 1000, top: 0, bottom: 100 });
});

test("FOS marker and GeoStudio water line render in both label positions", () => {
  globalThis.document = { documentElement: { getAttribute: () => "light" } };
  const regions = [{ id: 1, coords: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }];
  const materials = [{ id: 1, color: "#cccccc" }];
  const piezoLines = [[{ x: 0, y: 2 }, { x: 10, y: 2 }]];

  for (const centerY of [3, 6]) for (const fosAlign of ["left", "right"]) {
    const calls = [];
    const state = {};
    const ctx = new Proxy(state, {
      get(target, key) {
        if (key === "measureText") return () => ({ width: 60 });
        if (key === "setLineDash") return (dash) => { target.dash = dash; };
        if (key in target) return target[key];
        return (...args) => calls.push({ key, args, fill: target.fillStyle, stroke: target.strokeStyle, dash: target.dash, font: target.font });
      },
    });
    const canvas = { offsetWidth: 700, getContext: () => ctx };
    const slip = { centerX: 5, centerY, fos: 1.882, profile: [{ x: 0, y: 4 }, { x: 10, y: 4 }] };

    renderResultCanvas(canvas, regions, materials, new Map([[1, 1]]), slip, null, piezoLines, { slipStyle: { fosAlign } });

    assert.equal(calls.filter((call) => call.key === "arc" && call.fill === "#ff0000").length, 1);
    assert.equal(calls.filter((call) => call.key === "arc" && call.fill === "#111111").length, 0);
    assert.ok(calls.some((call) => call.key === "stroke" && call.stroke === "#0000ff" && String(call.dash) === "5,4"));
    assert.ok(calls.findIndex((call) => call.key === "fill" && call.fill === "rgba(120,220,255,0.40)") <
      calls.findIndex((call) => call.key === "fill" && call.fill === "#cccccc"));
    assert.ok(calls.some((call) => call.key === "fillText" && call.font.includes("YDIYGO330")));
    if (centerY === 3 && fosAlign === "left") {
      renderResultCanvas(canvas, regions, materials, new Map([[1, 1]]), slip, null, piezoLines,
        { width: 700, viewZoom: 2 });
      assert.equal(canvas.width, 1400);
      assert.equal(canvas.height, 888);
      assert.ok(calls.some((call) => call.key === "scale" && String(call.args) === "2,2"));
    }
  }
});

test("viewer zoom changes only the on-screen view", () => {
  const handlers = new Map();
  const makeElement = (id) => ({
    id, style: {}, dataset: {},
    addEventListener(type, fn) { handlers.set(`${id}:${type}`, fn); },
    setAttribute(name, value) { this[name] = value; },
  });
  const ids = ["rv-file", "rv-view-viewport", "rv-view-spacer", "rv-canvas-clip", "rv-canvas", "rv-zoom-in", "rv-zoom-out", "rv-zoom-fit", "rv-zoom-lock", "rv-zoom-pct"];
  const elements = Object.fromEntries(ids.map((id) => [id, makeElement(id)]));
  Object.assign(elements["rv-view-viewport"], { clientWidth: 700, clientHeight: 300, scrollLeft: 0, scrollTop: 0 });
  Object.assign(elements["rv-canvas"], { offsetWidth: 700, offsetHeight: 300, width: 700, height: 300 });
  Object.defineProperty(elements["rv-view-spacer"], "offsetWidth", { get() { return parseFloat(this.style.width) || 700; } });
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {},
  };
  globalThis.window = { addEventListener: () => {} };

  initResultViewer();
  handlers.get("rv-zoom-in:click")();
  assert.equal(elements["rv-zoom-pct"].textContent, "125%");
  assert.equal(elements["rv-view-viewport"].scrollLeft, 87.5);
  assert.equal(elements["rv-canvas"].width, 700);
  handlers.get("rv-zoom-lock:click")({ currentTarget: elements["rv-zoom-lock"] });
  assert.equal(elements["rv-zoom-lock"]["aria-pressed"], "true");
  assert.equal(elements["rv-zoom-in"].disabled, true);
  handlers.get("rv-zoom-out:click")();
  assert.equal(elements["rv-zoom-pct"].textContent, "125%");
  handlers.get("rv-zoom-lock:click")({ currentTarget: elements["rv-zoom-lock"] });
  handlers.get("rv-zoom-fit:click")();
  assert.equal(elements["rv-zoom-pct"].textContent, "100%");
  assert.equal(elements["rv-view-viewport"].scrollLeft, 0);
});

test("default Excel cases can be removed and added again", () => {
  const handlers = new Map();
  const elements = { "rv-file": { addEventListener() {} } };
  for (const key of ["normal", "seismic"]) {
    const row = { hidden: false };
    elements[`rv-case-${key}`] = { value: "0", closest: () => row };
    elements[`rv-${key}-remove`] = { addEventListener: (type, fn) => handlers.set(`${key}:remove`, fn) };
    elements[`rv-${key}-add`] = { hidden: true, addEventListener: (type, fn) => handlers.set(`${key}:add`, fn) };
  }
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {},
  };
  globalThis.window = { addEventListener: () => {} };

  initResultViewer();
  for (const key of ["normal", "seismic"]) {
    const select = elements[`rv-case-${key}`];
    const add = elements[`rv-${key}-add`];
    handlers.get(`${key}:remove`)();
    assert.equal(select.closest().hidden, true);
    assert.equal(select.value, "");
    assert.equal(add.hidden, false);
    handlers.get(`${key}:add`)();
    assert.equal(select.closest().hidden, false);
    assert.equal(add.hidden, true);
  }
});
