import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("create_instance spends balance, so it is marked destructive", () => {
  const start = src.indexOf('"create_instance"');
  assert.ok(start >= 0, "create_instance registration found");
  const m = src.slice(start).match(/annotations:\s*\{([^}]*)\}/);
  assert.ok(m, "annotations found");
  assert.match(m[1], /destructiveHint:\s*true/);
  assert.match(m[1], /readOnlyHint:\s*false/);
});
