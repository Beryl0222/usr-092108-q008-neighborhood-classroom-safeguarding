import assert from "node:assert/strict";
import test from "node:test";

import {
  caseView,
  childProfileView,
  continuityReport,
  guardianDailyBrief,
  sessionStatusView,
} from "../src/access.js";
import { SafeguardingService } from "../src/service.js";
import { validateEvent } from "../src/validator.js";

const DATE1 = "2026-07-06";
const DATE2 = "2026-07-07";

function buildService() {
  const service = new SafeguardingService();
  service.registerSite({
    siteId: "site-ent-01",
    name: "城东企业厂区课堂",
    type: "enterprise",
    capacity: 2,
    operatorIds: ["op-1"],
    enterpriseContactIds: ["ent-1"],
  });
  service.registerSite({ siteId: "site-com-02", name: "西社区课堂", type: "community", capacity: 3 });

  service.registerStaff({ staffId: "sw-1", name: "林社工", role: "licensed_social_worker", homeSiteId: "site-ent-01" });
  service.registerStaff({ staffId: "sw-2", name: "许社工", role: "licensed_social_worker", homeSiteId: "site-com-02" });
  service.registerStaff({ staffId: "cadre-1", name: "王团干", role: "league_cadre", homeSiteId: "site-ent-01" });
  service.registerStaff({ staffId: "vol-1", name: "陈同学", role: "volunteer", homeSiteId: "site-ent-01" });
  service.registerStaff({ staffId: "vol-2", name: "黄同学", role: "volunteer", homeSiteId: "site-ent-01" });
  for (const staffId of ["sw-1", "sw-2", "cadre-1", "vol-1", "vol-2"]) {
    service.clearStaff({ staffId, clearedBy: "proj-1" });
  }
  for (const kind of ["psych_group", "first_aid", "home_visit"]) {
    service.recordQualification({ staffId: "sw-1", kind, issuedAt: "2026-06-01", expiresAt: "2026-12-31" });
  }
  service.recordQualification({ staffId: "vol-2", kind: "first_aid", issuedAt: "2026-06-01", expiresAt: "2026-12-31" });
  service.designatePickupCoordinator({ siteId: "site-ent-01", staffId: "cadre-1" });

  service.scheduleSession({ sessionId: "sess-1", siteId: "site-ent-01", date: DATE1, courseProviderId: "cp-1" });
  service.scheduleSession({ sessionId: "sess-1b", siteId: "site-ent-01", date: DATE1, capacity: 1 });
  service.scheduleSession({ sessionId: "sess-2", siteId: "site-com-02", date: DATE1, capacity: 3 });
  service.scheduleSession({ sessionId: "sess-3", siteId: "site-ent-01", date: DATE2, courseProviderId: "cp-1" });
  return service;
}

function applyAndEnroll(
  service,
  { childId, familyId, name, siteId, sessionIds = [], priorityFlags = [], needsCare = false, guardians = [] },
) {
  service.submitApplication({
    applicationId: `app-${childId}`,
    childId,
    familyId,
    childName: name,
    siteId,
    priorityFlags,
    needsCareDuringSession: needsCare,
    safeguardingReason: "保障原因（敏感）",
    sensitiveProfile: { note: "家庭敏感画像" },
  });
  for (const guardianId of guardians) {
    service.authorizeGuardian({ childId, guardianId, relation: "父母" });
  }
  if (sessionIds.length > 0) {
    return service.confirmEnrollment({ applicationId: `app-${childId}`, sessionIds });
  }
  return [];
}

test("家长当日确认单：合格照看人、外出安排、临时接送确认人", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
    priorityFlags: ["children_in_difficulty"],
    needsCare: true,
    guardians: ["g-1"],
  });
  service.assignTask({ taskId: "t-1", sessionId: "sess-1", staffId: "sw-1", task: "supervision" });
  service.assignTask({ taskId: "t-2", sessionId: "sess-1", staffId: "vol-2", task: "first_aid" });

  const brief = guardianDailyBrief(service, { childId: "child-1", date: DATE1, guardianId: "g-1" });
  assert.equal(brief.sessions.length, 1);
  assert.deepEqual(
    brief.sessions[0].caregivers.map((item) => item.staffId).sort(),
    ["sw-1", "vol-2"],
  );
  assert.ok(brief.sessions[0].caregivers.find((item) => item.staffId === "vol-2").qualifications.includes("first_aid"));
  assert.equal(brief.sessions[0].outing, null);
  assert.equal(brief.pickupChangeContact.staffId, "cadre-1");

  service.planOuting({
    outingId: "out-1",
    sessionId: "sess-1",
    destination: "科技馆",
    departureAt: `${DATE1}T13:00:00+08:00`,
    returnAt: `${DATE1}T16:00:00+08:00`,
  });
  service.recordOutingConsent({ outingId: "out-1", childId: "child-1", guardianId: "g-1" });
  const updated = guardianDailyBrief(service, { childId: "child-1", date: DATE1, guardianId: "g-1" });
  assert.equal(updated.sessions[0].outing.destination, "科技馆");
  assert.equal(updated.sessions[0].outing.consented, true);

  assert.throws(
    () => guardianDailyBrief(service, { childId: "child-1", date: DATE1, guardianId: "g-9" }),
    /监护人/,
  );
});

test("外出活动必须有持有效急救资质的人员随行", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
    guardians: ["g-1"],
  });
  service.assignTask({ taskId: "t-1", sessionId: "sess-1", staffId: "vol-1", task: "supervision" });
  assert.throws(
    () =>
      service.planOuting({
        outingId: "out-1",
        sessionId: "sess-1",
        destination: "科技馆",
        departureAt: `${DATE1}T13:00:00+08:00`,
        returnAt: `${DATE1}T16:00:00+08:00`,
      }),
    /急救/,
  );
});

test("未培训志愿者不得承担心理团辅、急救、家访；受控任务按角色与资质把关", () => {
  const service = buildService();
  assert.throws(
    () => service.assignTask({ taskId: "x1", sessionId: "sess-1", staffId: "vol-1", task: "psych_group" }),
    /资质/,
  );
  assert.throws(
    () => service.assignTask({ taskId: "x2", sessionId: "sess-1", staffId: "vol-1", task: "first_aid" }),
    /资质/,
  );
  assert.throws(
    () => service.assignTask({ taskId: "x3", sessionId: "sess-1", staffId: "vol-1", task: "home_visit" }),
    /持证社工/,
  );
  assert.throws(
    () => service.assignTask({ taskId: "x4", sessionId: "sess-1", staffId: "cadre-1", task: "home_visit" }),
    /持证社工/,
  );
  // 受过培训并登记资质的志愿者可以承担急救值守
  service.assignTask({ taskId: "ok1", sessionId: "sess-1", staffId: "vol-2", task: "first_aid" });
  // 持证社工可以承担家访任务
  service.assignTask({ taskId: "ok2", sessionId: "sess-1", staffId: "sw-1", task: "home_visit" });
  // 日常照看不受资质限制
  service.assignTask({ taskId: "ok3", sessionId: "sess-1", staffId: "vol-1", task: "supervision" });
  // 未通过上岗审核的人员不能排班
  service.registerStaff({ staffId: "vol-9", name: "新同学", role: "volunteer", homeSiteId: "site-ent-01" });
  assert.throws(
    () => service.assignTask({ taskId: "x5", sessionId: "sess-1", staffId: "vol-9", task: "supervision" }),
    /审核/,
  );
});

test("点位容量控制与优先保障家庭候补排序", () => {
  const service = buildService();
  applyAndEnroll(service, { childId: "c-a", familyId: "f-a", name: "甲", siteId: "site-ent-01", sessionIds: ["sess-1"] });
  applyAndEnroll(service, { childId: "c-b", familyId: "f-b", name: "乙", siteId: "site-ent-01", sessionIds: ["sess-1"] });
  const [ordinary] = applyAndEnroll(service, {
    childId: "c-n",
    familyId: "f-n",
    name: "丙",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
  });
  const [priority] = applyAndEnroll(service, {
    childId: "c-p",
    familyId: "f-p",
    name: "丁",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
    priorityFlags: ["new_employment_family"],
  });
  assert.equal(ordinary.status, "waitlisted");
  assert.equal(priority.status, "waitlisted");
  // 困境儿童与新就业群体家庭排在候补前段
  assert.deepEqual(service.waitlist("sess-1"), ["c-p", "c-n"]);
});

test("临时换接送人：监护人发起、点位确认人核实、每名儿童留痕", () => {
  const service = buildService();
  for (const childId of ["child-1", "child-2"]) {
    applyAndEnroll(service, {
      childId,
      familyId: "fam-1",
      name: `孩子${childId}`,
      siteId: "site-ent-01",
      sessionIds: ["sess-1"],
      guardians: ["g-1"],
    });
  }
  applyAndEnroll(service, {
    childId: "child-5",
    familyId: "fam-1",
    name: "孩子五",
    siteId: "site-com-02",
    sessionIds: ["sess-2"],
    guardians: ["g-1"],
  });

  const ticket = service.requestTemporaryPickup({
    ticketId: "tp-1",
    childIds: ["child-1", "child-2"],
    pickerId: "aunt-1",
    relation: "姑母",
    date: DATE1,
    requestedBy: "g-1",
  });
  assert.equal(ticket.status, "pending");
  assert.throws(() => service.confirmTemporaryPickup({ ticketId: "tp-1", confirmedBy: "vol-2" }), /确认人/);

  service.confirmTemporaryPickup({ ticketId: "tp-1", confirmedBy: "cadre-1" });
  const changes = service.events.ofType("PICKUP_CHANGED");
  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map((event) => event.aggregate_id).sort(), ["child-1", "child-2"]);
  assert.ok(changes.every((event) => event.ticket_id === "tp-1" && event.confirmed_by === "cadre-1"));

  assert.throws(
    () =>
      service.requestTemporaryPickup({
        ticketId: "tp-2",
        childIds: ["child-1"],
        pickerId: "x",
        relation: "邻居",
        date: DATE1,
        requestedBy: "g-9",
      }),
    /监护人/,
  );
  assert.throws(
    () =>
      service.requestTemporaryPickup({
        ticketId: "tp-3",
        childIds: ["child-1", "child-5"],
        pickerId: "aunt-1",
        relation: "姑母",
        date: DATE1,
        requestedBy: "g-1",
      }),
    /同一点位/,
  );

  assert.throws(
    () => service.addPickupRelation({ childId: "child-1", pickerId: "p-1", relation: "邻居", authorizedBy: "g-9" }),
    /监护人/,
  );
  service.addPickupRelation({ childId: "child-1", pickerId: "p-1", relation: "邻居", authorizedBy: "g-1" });
});

test("兄弟姐妹同组跨点调班：监护人确认后生效且全程可追踪", () => {
  const service = buildService();
  for (const childId of ["child-1", "child-2"]) {
    applyAndEnroll(service, {
      childId,
      familyId: "fam-1",
      name: `孩子${childId}`,
      siteId: "site-ent-01",
      sessionIds: ["sess-1"],
      guardians: ["g-1"],
    });
  }
  service.requestSiblingTransfer({ groupId: "grp-1", childIds: ["child-1", "child-2"], toSessionId: "sess-2", requestedBy: "g-1" });
  assert.throws(() => service.confirmSiblingTransfer({ groupId: "grp-1", confirmedBy: "g-9" }), /监护人/);
  service.confirmSiblingTransfer({ groupId: "grp-1", confirmedBy: "g-1" });

  const reassigned = service.events.ofType("SESSION_REASSIGNED");
  assert.equal(reassigned.length, 2);
  assert.ok(reassigned.every((event) => event.to_session_id === "sess-2" && event.transfer_id));

  // 目标课程满员时调班申请被拒绝
  applyAndEnroll(service, { childId: "c-x", familyId: "f-x", name: "小满", siteId: "site-ent-01", sessionIds: ["sess-1b"] });
  assert.throws(
    () =>
      service.requestTransfer({
        transferId: "tr-9",
        childId: "child-1",
        toSessionId: "sess-1b",
        requestedBy: "g-1",
      }),
    /满员/,
  );
});

test("取消课程：先安置无人照看儿童（重点家庭优先），再取消并释放任务", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-com-02",
    sessionIds: ["sess-2"],
    priorityFlags: ["children_in_difficulty"],
    needsCare: true,
    guardians: ["g-1"],
  });
  applyAndEnroll(service, {
    childId: "child-4",
    familyId: "fam-4",
    name: "小琪",
    siteId: "site-com-02",
    sessionIds: ["sess-2"],
    needsCare: true,
    guardians: ["g-3"],
  });
  applyAndEnroll(service, {
    childId: "child-2",
    familyId: "fam-1",
    name: "小舟",
    siteId: "site-com-02",
    sessionIds: ["sess-2"],
    guardians: ["g-1"],
  });
  // 替代课程余量：sess-1 剩 1 个名额，sess-1b 已满
  applyAndEnroll(service, { childId: "c-x", familyId: "f-x", name: "小满", siteId: "site-ent-01", sessionIds: ["sess-1"] });
  applyAndEnroll(service, { childId: "c-z", familyId: "f-z", name: "小意", siteId: "site-ent-01", sessionIds: ["sess-1b"] });
  service.assignTask({ taskId: "t-1", sessionId: "sess-2", staffId: "sw-2", task: "supervision" });

  const arrangements = service.cancelSession({ sessionId: "sess-2", reason: "台风停课" });
  assert.deepEqual(arrangements, [
    { childId: "child-1", type: "transfer", toSessionId: "sess-1" },
    { childId: "child-4", type: "guardian_pickup" },
  ]);
  assert.equal(service.tasks.get("t-1").status, "released");
  assert.equal(service.tasks.get("t-1").releaseReason, "session_cancelled");
  assert.equal(service.sessions.get("sess-2").status, "cancelled");

  const all = service.events.all();
  const lastArrangement = all.map((event) => event.event_type).lastIndexOf("CARE_ARRANGEMENT_RECORDED");
  const cancelledAt = all.findIndex((event) => event.event_type === "SESSION_CANCELLED");
  assert.ok(lastArrangement > -1 && lastArrangement < cancelledAt, "安置记录必须先于取消事件");
  assert.throws(
    () => service.confirmEnrollment({ applicationId: "app-child-2", sessionIds: ["sess-2"] }),
    /不在待确认状态|不可报名/,
  );
});

test("人员缺席只释放当日任务，资质到期只释放相关任务", () => {
  const service = buildService();
  service.assignTask({ taskId: "t-a", sessionId: "sess-1", staffId: "sw-1", task: "first_aid" });
  service.assignTask({ taskId: "t-b", sessionId: "sess-3", staffId: "sw-1", task: "supervision" });
  service.assignTask({ taskId: "t-c", sessionId: "sess-3", staffId: "sw-1", task: "psych_group" });

  const releasedByAbsence = service.reportAbsence({ staffId: "sw-1", date: DATE1 });
  assert.deepEqual(releasedByAbsence.map((record) => record.taskId), ["t-a"]);
  assert.equal(service.tasks.get("t-b").status, "assigned");
  assert.equal(service.tasks.get("t-c").status, "assigned");

  const releasedByExpiry = service.expireQualification({ staffId: "sw-1", kind: "psych_group", asOf: DATE1 });
  assert.deepEqual(releasedByExpiry.map((record) => record.taskId), ["t-c"]);
  assert.equal(service.tasks.get("t-b").status, "assigned");

  assert.throws(
    () => service.assignTask({ taskId: "t-d", sessionId: "sess-3", staffId: "sw-1", task: "psych_group" }),
    /资质/,
  );
});

test("断网补签不重复累计时长", () => {
  const service = buildService();
  service.assignTask({ taskId: "t-1", sessionId: "sess-1", staffId: "sw-1", task: "supervision" });

  const online = service.recordCheckIn({
    staffId: "sw-1",
    sessionId: "sess-1",
    task: "supervision",
    start: `${DATE1}T09:00:00+08:00`,
    end: `${DATE1}T12:00:00+08:00`,
  });
  assert.equal(online.creditedMinutes, 180);

  const backfill = service.recordCheckIn({
    staffId: "sw-1",
    sessionId: "sess-1",
    task: "supervision",
    start: `${DATE1}T10:00:00+08:00`,
    end: `${DATE1}T13:00:00+08:00`,
    source: "offline_backfill",
  });
  assert.equal(backfill.creditedMinutes, 60);

  const duplicate = service.recordCheckIn({
    staffId: "sw-1",
    sessionId: "sess-1",
    task: "supervision",
    start: `${DATE1}T09:00:00+08:00`,
    end: `${DATE1}T12:00:00+08:00`,
    source: "offline_backfill",
  });
  assert.equal(duplicate.creditedMinutes, 0);

  assert.equal(service.staffHoursForDate("sw-1", DATE1), 4);
  assert.equal(service.events.ofType("CHECK_IN_BACKFILLED").length, 2);
});

test("家访仅限持有效资质的持证社工", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
    guardians: ["g-1"],
  });
  assert.throws(
    () => service.scheduleHomeVisit({ visitId: "v-1", childId: "child-1", staffId: "vol-2", at: `${DATE1}T15:00:00+08:00` }),
    /持证社工/,
  );
  service.scheduleHomeVisit({ visitId: "v-2", childId: "child-1", staffId: "sw-1", at: `${DATE1}T15:00:00+08:00` });
  service.completeHomeVisit({ visitId: "v-2", outcome: "已走访，情况稳定" });

  service.expireQualification({ staffId: "sw-1", kind: "home_visit", asOf: DATE1 });
  assert.throws(
    () => service.scheduleHomeVisit({ visitId: "v-3", childId: "child-1", staffId: "sw-1", at: `${DATE2}T15:00:00+08:00` }),
    /资质/,
  );
});

test("安全线索升级：社工与监护人接手、记录保全，运营只见必要状态", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
    guardians: ["g-1"],
  });
  service.assignTask({ taskId: "t-1", sessionId: "sess-1", staffId: "sw-1", task: "supervision" });

  const record = service.raiseConcern({
    caseId: "case-1",
    childId: "child-1",
    raisedBy: "vol-1",
    detail: "发现儿童手臂有不明伤痕",
  });
  assert.equal(record.assigneeId, "sw-1");
  const escalated = service.events.ofType("CASE_ESCALATED")[0];
  assert.deepEqual(escalated.guardian_notified_ids, ["g-1"]);
  assert.ok(!("detail" in escalated), "敏感细节不进入事件载荷");

  service.addCaseNote({ caseId: "case-1", authorId: "sw-1", note: "已与监护人面谈" });
  service.addCaseNote({ caseId: "case-1", authorId: "g-1", note: "补充家庭情况" });
  assert.throws(() => service.addCaseNote({ caseId: "case-1", authorId: "vol-1", note: "x" }), /承办社工或监护人/);

  const socialWorkerView = caseView(service, "case-1", { id: "sw-1", role: "licensed_social_worker" });
  assert.equal(socialWorkerView.detail, "发现儿童手臂有不明伤痕");
  const guardianView = caseView(service, "case-1", { id: "g-1", role: "guardian" });
  assert.equal(guardianView.notes.length, 2);

  const operatorView = caseView(service, "case-1", { id: "op-1", role: "site_operator" });
  assert.deepEqual(Object.keys(operatorView).sort(), ["caseId", "status"]);
  const enterpriseView = caseView(service, "case-1", { id: "ent-1", role: "enterprise_contact" });
  assert.equal(enterpriseView.status, "open");
  const providerView = caseView(service, "case-1", { id: "cp-1", role: "course_provider" });
  assert.deepEqual(Object.keys(providerView).sort(), ["caseId", "status"]);

  const projectView = caseView(service, "case-1", { id: "proj-1", role: "project_group" });
  assert.ok(!("detail" in projectView) && !("childId" in projectView) && !("notes" in projectView));

  assert.throws(() => caseView(service, "case-1", { id: "vol-1", role: "volunteer" }), /无权/);
  assert.throws(() => service.updateCaseStatus({ caseId: "case-1", status: "closed", by: "g-1" }), /承办社工/);
  service.updateCaseStatus({ caseId: "case-1", status: "closed", by: "sw-1" });
  assert.equal(caseView(service, "case-1", { id: "op-1", role: "site_operator" }).status, "closed");
});

test("家庭敏感资料仅向实际服务的持证人员开放", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
    priorityFlags: ["children_in_difficulty"],
    guardians: ["g-1"],
  });
  service.assignTask({ taskId: "t-1", sessionId: "sess-1", staffId: "sw-1", task: "supervision" });

  const guardianView = childProfileView(service, "child-1", { id: "g-1", role: "guardian" });
  assert.equal(guardianView.safeguardingReason, "保障原因（敏感）");

  const servingView = childProfileView(service, "child-1", { id: "sw-1", role: "licensed_social_worker" });
  assert.equal(servingView.sensitiveProfile.note, "家庭敏感画像");

  // 未服务该儿童的持证社工同样不可见
  assert.throws(() => childProfileView(service, "child-1", { id: "sw-2", role: "licensed_social_worker" }), /无权/);

  for (const principal of [
    { id: "cp-1", role: "course_provider" },
    { id: "ent-1", role: "enterprise_contact" },
    { id: "op-1", role: "site_operator" },
  ]) {
    const view = childProfileView(service, "child-1", principal);
    assert.ok(!("safeguardingReason" in view), `${principal.role} 不应看到保障原因`);
    assert.ok(!("sensitiveProfile" in view) && !("name" in view));
    assert.ok(view.pseudonym.startsWith("儿童-"));
  }

  const projectView = childProfileView(service, "child-1", { id: "proj-1", role: "project_group" });
  assert.deepEqual(Object.keys(projectView).sort(), ["priorityFlags", "pseudonym"]);
});

test("课程状态视图对课程方/企业只含必要计数", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
    guardians: ["g-1"],
  });
  service.assignTask({ taskId: "t-1", sessionId: "sess-1", staffId: "sw-1", task: "supervision" });
  service.recordChildAttendance({ childId: "child-1", sessionId: "sess-1" });

  const view = sessionStatusView(service, "sess-1", { id: "cp-1", role: "course_provider" });
  assert.deepEqual(view, {
    sessionId: "sess-1",
    date: DATE1,
    status: "scheduled",
    capacity: 2,
    enrolledCount: 1,
    presentCount: 1,
  });
  assert.throws(() => sessionStatusView(service, "sess-1", { id: "vol-1", role: "volunteer" }), /无权/);
});

test("项目组用去标识数据判断重点家庭是否得到连续服务", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-ent-01",
    sessionIds: ["sess-1", "sess-3"],
    priorityFlags: ["children_in_difficulty"],
    needsCare: true,
    guardians: ["g-1"],
  });
  service.assignTask({ taskId: "t-1", sessionId: "sess-1", staffId: "sw-1", task: "supervision" });
  // 第一天：儿童到课且人员在岗签到 → 得到服务
  service.recordChildAttendance({ childId: "child-1", sessionId: "sess-1" });
  service.recordCheckIn({
    staffId: "sw-1",
    sessionId: "sess-1",
    task: "supervision",
    start: `${DATE1}T09:00:00+08:00`,
    end: `${DATE1}T12:00:00+08:00`,
  });
  // 第二天：课程取消 → 未得到服务
  service.cancelSession({ sessionId: "sess-3", reason: "场地检修" });

  const report = continuityReport(service, { from: DATE1, to: DATE2 });
  const row = report.find((item) => item.priorityFlags.includes("children_in_difficulty"));
  assert.equal(row.enrolledDays, 2);
  assert.equal(row.servedDays, 1);
  assert.equal(row.continuity, 0.5);
  assert.ok(row.familyKey.startsWith("家庭-"));
  assert.ok(!("name" in row) && !("safeguardingReason" in row) && !("siteId" in row) && !("childId" in row));
});

test("事件全程留痕且符合基础约定", () => {
  const service = buildService();
  applyAndEnroll(service, {
    childId: "child-1",
    familyId: "fam-1",
    name: "小宇",
    siteId: "site-ent-01",
    sessionIds: ["sess-1"],
    guardians: ["g-1"],
  });
  service.assignTask({ taskId: "t-1", sessionId: "sess-1", staffId: "sw-1", task: "supervision" });
  service.recordCheckIn({
    staffId: "sw-1",
    sessionId: "sess-1",
    task: "supervision",
    start: `${DATE1}T09:00:00+08:00`,
    end: `${DATE1}T12:00:00+08:00`,
  });
  const events = service.events.all();
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 应符合约定`);
  }
  // 同一聚合的版本单调递增
  const enrollmentEvents = service.events.forAggregate("child_enrollment", "child-1");
  assert.deepEqual(
    enrollmentEvents.map((event) => event.version),
    enrollmentEvents.map((_, index) => index + 1),
  );
});
