import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { parseAllResults } from "../js/result-parser.js";

test("GeoStudio result directory uses the XML analysis name", async () => {
  const zip = new JSZip();
  zip.file("Stage&4 loaded/001/lambdafos_7.csv", "FOSByMoment\n1.25\n");
  const doc = {
    querySelectorAll: () => [{ querySelector: () => ({ textContent: "Stage: loaded" }) }],
  };

  const [result] = await parseAllResults(zip, doc);
  assert.equal(result.analysisName, "Stage: loaded");
  assert.equal(result.dir, "Stage&4 loaded");
  assert.equal(result.fos, 1.25);
});
