import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_TYPES } from "../src/events.js";
import { validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("契约枚举与代码常量保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...schema.properties.event_type.enum].sort(), [...EVENT_TYPES].sort());
  assert.deepEqual([...schema.properties.aggregate_type.enum].sort(), [...AGGREGATE_TYPES].sort());
});
