import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertPackagedConfig, createPackagedConfig } from "./package.mjs";

const workerConfig = JSON.parse(await readFile(new URL("../apps/worker/config.json", import.meta.url), "utf8"));

test("packaged config includes current VNU and HA settings without secrets or URLs", () => {
  const config = assertPackagedConfig(createPackagedConfig(workerConfig));

  assert.deepEqual(config.vnu, workerConfig.vnu);
  assert.deepEqual(config.ha, workerConfig.ha);
  assert.deepEqual(config.origins, []);
  assert.equal(config.browser.ws_endpoint, "");
  assert.equal(config.static_dir, "./public");
  assert.doesNotMatch(JSON.stringify(config), /HYEB_SESSION_SECRET|DATABASE_URL|REDIS_URL|POSTGRES_URL|password|secret|token|cookie/i);
});
