import { createHash } from "node:crypto";

import { DomainError } from "./events.js";

/**
 * 分级可见性：同一份领域数据，按调用方职责裁剪。
 *
 * - 监护人：自己孩子的完整情况与当日照看安排；
 * - 实际服务的持证人员：履职所需的完整资料（含家庭敏感信息）；
 * - 点位运营、企业联系人、课程方：只读到课/接送等必要状态；
 * - 市级项目组：去标识后的连续服务统计。
 */

const OPERATIONAL_ROLES = new Set(["site_operator", "enterprise_contact", "course_provider"]);

function fail(code, message) {
  throw new DomainError(code, message);
}

function pseudonym(prefix, rawId) {
  const digest = createHash("sha256").update(`linli-classroom:${rawId}`).digest("hex").slice(0, 10);
  return `${prefix}-${digest}`;
}

function isGuardian(service, childId, principalId) {
  return (service.guardians.get(childId) ?? []).some((item) => item.guardianId === principalId);
}

/** 实际服务该儿童的持证社工：在该儿童已报名课程中有在派任务。 */
function isServingLicensedStaff(service, childId, staffId) {
  const member = service.staff.get(staffId);
  if (!member || member.role !== "licensed_social_worker" || member.clearance !== "cleared") return false;
  return [...service.tasks.values()].some(
    (task) =>
      task.staffId === staffId &&
      task.status === "assigned" &&
      service.enrollments.get(`${childId}|${task.sessionId}`)?.status === "enrolled",
  );
}

function validQualifications(service, staffId, date) {
  const quals = service.qualifications.get(staffId);
  if (!quals) return [];
  return [...quals.entries()]
    .filter(([, qual]) => qual.active && qual.expiresAt >= date)
    .map(([kind]) => kind);
}

function operationalChildView(service, childId) {
  const sessions = [];
  for (const [key, enrollment] of service.enrollments.entries()) {
    if (!key.startsWith(`${childId}|`)) continue;
    const sessionId = key.split("|")[1];
    const session = service.sessions.get(sessionId);
    sessions.push({
      sessionId,
      date: session.date,
      sessionStatus: session.status,
      enrollmentStatus: enrollment.status,
      present: service.childAttendance.has(`${childId}|${sessionId}`),
    });
  }
  const temporaryPickups = [...service.tempPickups.values()]
    .filter((ticket) => ticket.status === "confirmed" && ticket.childIds.includes(childId))
    .map((ticket) => ({ date: ticket.date, confirmed: true }));
  return {
    pseudonym: pseudonym("儿童", childId),
    sessions,
    pickup: {
      authorizedPickerCount: (service.pickupRelations.get(childId) ?? []).filter((item) => item.active).length,
      temporaryPickups,
    },
  };
}

/**
 * 儿童档案视图。家庭敏感资料（保障原因、家庭画像）仅向监护人和
 * 实际服务的持证社工开放；课程方、企业与运营人员只见到课与接送状态。
 */
export function childProfileView(service, childId, principal) {
  const child = service.children.get(childId);
  if (!child) fail("CHILD_NOT_FOUND", `儿童不存在：${childId}`);

  if (principal.role === "guardian" && isGuardian(service, childId, principal.id)) {
    return fullChildView(service, child);
  }
  if (principal.role === "licensed_social_worker" && isServingLicensedStaff(service, childId, principal.id)) {
    return fullChildView(service, child);
  }
  if (OPERATIONAL_ROLES.has(principal.role) && isLinkedToChild(service, child, principal)) {
    return operationalChildView(service, childId);
  }
  if (principal.role === "project_group") {
    return { pseudonym: pseudonym("儿童", childId), priorityFlags: [...child.priorityFlags] };
  }
  fail("ACCESS_DENIED", "无权查看该儿童资料");
}

function fullChildView(service, child) {
  return {
    childId: child.childId,
    name: child.name,
    familyId: child.familyId,
    siteId: child.siteId,
    priorityFlags: [...child.priorityFlags],
    needsCareDuringSession: child.needsCareDuringSession,
    safeguardingReason: child.safeguardingReason,
    sensitiveProfile: { ...child.sensitiveProfile },
    guardians: (service.guardians.get(child.childId) ?? []).map((item) => ({ ...item })),
    pickupRelations: (service.pickupRelations.get(child.childId) ?? []).map((item) => ({ ...item })),
  };
}

function isLinkedToChild(service, child, principal) {
  const site = service.sites.get(child.siteId);
  if (!site) return false;
  if (principal.role === "site_operator") return site.operatorIds.includes(principal.id);
  if (principal.role === "enterprise_contact") return site.enterpriseContactIds.includes(principal.id);
  if (principal.role === "course_provider") {
    return [...service.enrollments.entries()].some(([key, enrollment]) => {
      if (!key.startsWith(`${child.childId}|`) || enrollment.status === "ended") return false;
      const session = service.sessions.get(key.split("|")[1]);
      return session?.courseProviderId === principal.id;
    });
  }
  return false;
}

/**
 * 家长当日确认单：今天由哪位合格人员照看、是否有外出安排、
 * 临时换接送人该找谁确认。
 */
export function guardianDailyBrief(service, { childId, date, guardianId }) {
  const child = service.children.get(childId);
  if (!child) fail("CHILD_NOT_FOUND", `儿童不存在：${childId}`);
  if (!isGuardian(service, childId, guardianId)) {
    fail("NOT_GUARDIAN", `${guardianId} 不是儿童 ${childId} 的授权监护人`);
  }
  const site = service.sites.get(child.siteId);
  const coordinator = site?.coordinatorId ? service.staff.get(site.coordinatorId) : null;

  const sessions = [];
  for (const [key, enrollment] of service.enrollments.entries()) {
    if (!key.startsWith(`${childId}|`)) continue;
    const sessionId = key.split("|")[1];
    const session = service.sessions.get(sessionId);
    if (!session || session.date !== date) continue;
    const caregivers = [...service.tasks.values()]
      .filter((task) => task.sessionId === sessionId && task.status === "assigned")
      .map((task) => {
        const member = service.staff.get(task.staffId);
        return {
          staffId: member.staffId,
          name: member.name,
          role: member.role,
          task: task.task,
          qualifications: validQualifications(service, task.staffId, session.date),
        };
      });
    const outing = [...service.outings.values()].find((plan) => plan.sessionId === sessionId) ?? null;
    sessions.push({
      sessionId,
      sessionStatus: session.status,
      enrollmentStatus: enrollment.status,
      caregivers,
      outing: outing
        ? {
            outingId: outing.outingId,
            destination: outing.destination,
            departureAt: outing.departureAt,
            returnAt: outing.returnAt,
            consented: outing.consents.has(childId),
          }
        : null,
    });
  }

  const temporaryPickup = [...service.tempPickups.values()].find(
    (ticket) => ticket.childIds.includes(childId) && ticket.date === date && ticket.status === "confirmed",
  );

  return {
    childId,
    childName: child.name,
    date,
    sessions,
    pickupChangeContact: coordinator
      ? { staffId: coordinator.staffId, name: coordinator.name, role: coordinator.role }
      : null,
    temporaryPickup: temporaryPickup
      ? { ticketId: temporaryPickup.ticketId, pickerId: temporaryPickup.pickerId, confirmedBy: temporaryPickup.confirmedBy }
      : null,
  };
}

/**
 * 个案视图。承办社工与监护人见完整记录；运营、企业、课程方仅见状态；
 * 项目组见去标识摘要。记录本体只追加、不改写。
 */
export function caseView(service, caseId, principal) {
  const record = service.cases.get(caseId);
  if (!record) fail("CASE_NOT_FOUND", `个案不存在：${caseId}`);

  const isAssignee = record.assigneeId === principal.id;
  const isCaseGuardian = isGuardian(service, record.childId, principal.id);
  const isSiteLicensedStaff =
    principal.role === "licensed_social_worker" &&
    service.staff.get(principal.id)?.clearance === "cleared" &&
    service.staff.get(principal.id)?.homeSiteId === record.siteId;

  if (isAssignee || isCaseGuardian || isSiteLicensedStaff) {
    return {
      caseId: record.caseId,
      childId: record.childId,
      siteId: record.siteId,
      status: record.status,
      detail: record.detail,
      assigneeId: record.assigneeId,
      notes: record.notes.map((note) => ({ ...note })),
      openedAt: record.openedAt,
      closedAt: record.closedAt,
    };
  }
  if (OPERATIONAL_ROLES.has(principal.role) && isLinkedToSite(service, record.siteId, principal)) {
    return { caseId: record.caseId, status: record.status };
  }
  if (principal.role === "project_group") {
    return {
      caseKey: pseudonym("个案", record.caseId),
      status: record.status,
      openedAt: record.openedAt,
      closedAt: record.closedAt,
    };
  }
  fail("ACCESS_DENIED", "无权查看该个案");
}

function isLinkedToSite(service, siteId, principal) {
  const site = service.sites.get(siteId);
  if (!site) return false;
  if (principal.role === "site_operator") return site.operatorIds.includes(principal.id);
  if (principal.role === "enterprise_contact") return site.enterpriseContactIds.includes(principal.id);
  if (principal.role === "course_provider") {
    return [...service.sessions.values()].some(
      (session) => session.siteId === siteId && session.courseProviderId === principal.id,
    );
  }
  return false;
}

/**
 * 课程运行状态视图：课程方、企业、运营只见容量与到课计数，
 * 不含任何儿童身份信息。
 */
export function sessionStatusView(service, sessionId, principal) {
  const session = service.sessions.get(sessionId);
  if (!session) fail("SESSION_NOT_FOUND", `课程不存在：${sessionId}`);
  const allowed =
    principal.role === "project_group" ||
    (OPERATIONAL_ROLES.has(principal.role) && isLinkedToSite(service, session.siteId, principal));
  if (!allowed) fail("ACCESS_DENIED", "无权查看该课程状态");
  const enrolledCount = [...service.enrollments.entries()].filter(
    ([key, enrollment]) => key.endsWith(`|${sessionId}`) && enrollment.status === "enrolled",
  ).length;
  const presentCount = [...service.childAttendance].filter((key) => key.endsWith(`|${sessionId}`)).length;
  return {
    sessionId,
    date: session.date,
    status: session.status,
    capacity: session.capacity,
    enrolledCount,
    presentCount,
  };
}

/**
 * 市级项目组连续服务报表：去标识输出，重点家庭是否真正得到连续服务。
 * 一个“服务日”要求课程实际进行、儿童到课且有人员在岗签到。
 */
export function continuityReport(service, { from, to }) {
  const families = new Map();
  for (const child of service.children.values()) {
    const family = families.get(child.familyId) ?? { priorityFlags: new Set(), enrolledDays: 0, servedDays: 0 };
    for (const flag of child.priorityFlags) family.priorityFlags.add(flag);
    for (const [key, enrollment] of service.enrollments.entries()) {
      if (!key.startsWith(`${child.childId}|`)) continue;
      if (enrollment.status === "waitlisted") continue;
      const sessionId = key.split("|")[1];
      const session = service.sessions.get(sessionId);
      if (!session || session.date < from || session.date > to) continue;
      family.enrolledDays += 1;
      const staffed = service.checkIns.some((checkIn) => checkIn.sessionId === sessionId);
      const served =
        session.status === "scheduled" && service.childAttendance.has(`${child.childId}|${sessionId}`) && staffed;
      if (served) family.servedDays += 1;
    }
    families.set(child.familyId, family);
  }
  return [...families.entries()]
    .filter(([, family]) => family.enrolledDays > 0)
    .map(([familyId, family]) => ({
      familyKey: pseudonym("家庭", familyId),
      priorityFlags: [...family.priorityFlags].sort(),
      enrolledDays: family.enrolledDays,
      servedDays: family.servedDays,
      missedDays: family.enrolledDays - family.servedDays,
      continuity: family.servedDays / family.enrolledDays,
    }))
    .sort((a, b) => a.continuity - b.continuity);
}
