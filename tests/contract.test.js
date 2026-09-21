import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateEvent,
  defaultClassification,
  EVENT_AGGREGATE,
} from "../src/validator.js";

const readJson = (path) =>
  readFile(new URL(path, import.meta.url), "utf8").then((text) => JSON.parse(text));

test("样例符合领域约定", async () => {
  const sample = await readJson("../data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("端到端样例流中的每条事件都通过校验", async () => {
  const { events } = await readJson("../data/event-samples.json");
  assert.ok(events.length >= 40, "样例应覆盖完整链路");
  for (const event of events) {
    assert.deepEqual(
      validateEvent(event),
      [],
      `事件 ${event.event_id} 校验失败：${validateEvent(event).join("；")}`
    );
  }
});

test("校验目录与 JSON Schema 的事件枚举完全一致", async () => {
  const schema = await readJson("../contracts/domain.schema.json");
  const schemaTypes = new Set(
    schema.properties.event_type.enum
  );
  const validatorTypes = new Set(Object.keys(EVENT_AGGREGATE));
  assert.deepEqual(
    [...validatorTypes].sort(),
    [...schemaTypes].sort(),
    "validator.js 与 domain.schema.json 的事件类型目录不得漂移"
  );
});

test("样例覆盖事件目录中的每一种事件类型", async () => {
  const schema = await readJson("../contracts/domain.schema.json");
  const { events } = await readJson("../data/event-samples.json");
  const covered = new Set(events.map((e) => e.event_type));
  const missing = schema.properties.event_type.enum.filter((t) => !covered.has(t));
  assert.deepEqual(missing, [], `缺少事件类型样例：${missing.join("、")}`);
});

test("样例覆盖全部聚合类型", async () => {
  const schema = await readJson("../contracts/domain.schema.json");
  const { events } = await readJson("../data/event-samples.json");
  const used = new Set(events.map((e) => e.aggregate_type));
  const missing = schema.properties.aggregate_type.enum.filter((t) => !used.has(t));
  assert.deepEqual(missing, [], `缺少聚合样例：${missing.join("、")}`);
});

test("每条样例显式标注的数据分级与目录默认分级一致", async () => {
  const { events } = await readJson("../data/event-samples.json");
  for (const event of events) {
    if (event.data_classification !== undefined) {
      assert.equal(
        event.data_classification,
        defaultClassification(event.event_type),
        `${event.event_id} 分级与目录不一致`
      );
    }
  }
});

test("restricted 与 sealed 事件不得缺省为运营可见", async () => {
  const { events } = await readJson("../data/event-samples.json");
  const sensitive = events.filter(
    (e) => defaultClassification(e.event_type) !== "operational"
  );
  assert.ok(sensitive.length >= 10, "申请、授权、家访、案件等敏感事件应成链出现");
  for (const event of sensitive) {
    assert.ok(
      ["restricted", "sealed"].includes(event.data_classification),
      `${event.event_id} 必须显式标注敏感分级`
    );
  }
});

test("事件 id 唯一且关联链不出现自指", async () => {
  const { events } = await readJson("../data/event-samples.json");
  const ids = events.map((e) => e.event_id);
  assert.equal(new Set(ids).size, ids.length);
  for (const event of events) {
    if (event.related_events) {
      assert.ok(!event.related_events.includes(event.event_id));
      for (const ref of event.related_events) assert.ok(ids.includes(ref), `${event.event_id} 关联了不存在的 ${ref}`);
    }
  }
});

test("非法信封被拒绝", () => {
  const base = {
    event_id: "x1",
    event_type: "CHECKIN_RECORDED",
    aggregate_type: "attendance_record",
    aggregate_id: "a1",
    occurred_at: "2026-07-15T08:32:00+08:00",
    version: 1,
    summary: "基线",
  };
  assert.ok(validateEvent({ ...base, version: 0 }).length > 0);
  assert.ok(validateEvent({ ...base, event_type: "UNKNOWN" }).length > 0);
  assert.ok(
    validateEvent({ ...base, aggregate_type: "site_session" }).some((m) => m.includes("必须归属聚合"))
  );
  assert.ok(
    validateEvent({ ...base, actor: { actor_id: "a", role: "intern" } }).some((m) =>
      m.includes("未知角色")
    )
  );
  assert.ok(
    validateEvent({ ...base, related_events: ["e", "e"] }).some((m) => m.includes("重复"))
  );
  assert.ok(
    validateEvent({ ...base, occurred_at: "2026/07/15 08:32" }).some((m) =>
      m.includes("RFC 3339")
    )
  );
  assert.deepEqual(validateEvent(base), []);
});
