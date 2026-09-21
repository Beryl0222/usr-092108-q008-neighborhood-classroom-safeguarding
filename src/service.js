import { DomainError, EventStore } from "./events.js";

/**
 * 任务类型及其任职要求。
 *
 * 心理团辅、急救值守、外出带队、家访属于受控任务：未记录有效资质的人员
 * （尤其是未培训的高校志愿者）一律不得承担；家访额外要求持证社工身份。
 */
export const TASK_REQUIREMENTS = Object.freeze({
  supervision: Object.freeze({ label: "日常照看" }),
  psych_group: Object.freeze({ label: "心理团辅", qualification: "psych_group" }),
  first_aid: Object.freeze({ label: "急救值守", qualification: "first_aid" }),
  outing_lead: Object.freeze({ label: "外出带队", qualification: "first_aid" }),
  home_visit: Object.freeze({
    label: "家访",
    qualification: "home_visit",
    roles: Object.freeze(["licensed_social_worker"]),
  }),
});

export const STAFF_ROLES = Object.freeze(["league_cadre", "licensed_social_worker", "volunteer"]);

/** 优先保障标识：困境儿童、新就业群体家庭。 */
export const PRIORITY_FLAGS = Object.freeze(["children_in_difficulty", "new_employment_family"]);

export const SITE_TYPES = Object.freeze(["community", "rural", "enterprise", "park"]);

export const QUALIFICATION_KINDS = Object.freeze(["psych_group", "first_aid", "home_visit"]);

function fail(code, message) {
  throw new DomainError(code, message);
}

function dateOf(isoDateTime) {
  return isoDateTime.slice(0, 10);
}

/**
 * 邻里课堂安全协作服务。
 *
 * 所有状态变更都通过命令方法完成，并同步追加领域事件；
 * 查询方法（视图）按调用方职责裁剪字段，见 access.js。
 */
export class SafeguardingService {
  #store = new EventStore();
  #seq = 0;

  sites = new Map();
  sessions = new Map();
  children = new Map();
  applications = new Map();
  /** key: `${childId}|${sessionId}` → { status: "enrolled" | "waitlisted" | "ended", seq } */
  enrollments = new Map();
  guardians = new Map();
  pickupRelations = new Map();
  tempPickups = new Map();
  staff = new Map();
  /** staffId → Map(kind → { issuedAt, expiresAt, active }) */
  qualifications = new Map();
  tasks = new Map();
  checkIns = [];
  outings = new Map();
  homeVisits = new Map();
  cases = new Map();
  childAttendance = new Set();
  transfers = new Map();

  get events() {
    return this.#store;
  }

  #nextSeq() {
    this.#seq += 1;
    return this.#seq;
  }

  // ---------------------------------------------------------------- 点位与课程

  registerSite({ siteId, name, type, capacity, operatorIds = [], enterpriseContactIds = [], occurredAt }) {
    if (!SITE_TYPES.includes(type)) fail("SITE_TYPE_UNKNOWN", `未知点位类型：${type}`);
    if (!Number.isInteger(capacity) || capacity < 1) fail("SITE_CAPACITY_INVALID", "点位容量必须是正整数");
    if (this.sites.has(siteId)) fail("SITE_EXISTS", `点位已存在：${siteId}`);
    const site = {
      siteId,
      name,
      type,
      capacity,
      operatorIds: [...operatorIds],
      enterpriseContactIds: [...enterpriseContactIds],
      coordinatorId: null,
    };
    this.sites.set(siteId, site);
    this.#store.append({
      event_type: "SITE_REGISTERED",
      aggregate_type: "site",
      aggregate_id: siteId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `登记点位「${name}」（${type}，容量 ${capacity}）`,
    });
    return site;
  }

  /** 指定点位的接送变更确认人：须为已审核的团干部或持证社工。 */
  designatePickupCoordinator({ siteId, staffId, occurredAt }) {
    const site = this.#site(siteId);
    const member = this.#staffMember(staffId);
    if (member.clearance !== "cleared") fail("STAFF_NOT_CLEARED", "确认人须先通过审核");
    if (member.role === "volunteer") fail("COORDINATOR_ROLE_INVALID", "志愿者不得担任接送确认人");
    site.coordinatorId = staffId;
    this.#store.append({
      event_type: "SITE_COORDINATOR_DESIGNATED",
      aggregate_type: "site",
      aggregate_id: siteId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `指定 ${member.name} 为「${site.name}」接送变更确认人`,
    });
    return site;
  }

  scheduleSession({ sessionId, siteId, date, courseProviderId = null, riskLevel = "low", capacity = null, occurredAt }) {
    const site = this.#site(siteId);
    if (this.sessions.has(sessionId)) fail("SESSION_EXISTS", `课程已存在：${sessionId}`);
    const session = {
      sessionId,
      siteId,
      date,
      courseProviderId,
      riskLevel,
      capacity: capacity ?? site.capacity,
      status: "scheduled",
    };
    this.sessions.set(sessionId, session);
    this.#store.append({
      event_type: "SESSION_SCHEDULED",
      aggregate_type: "site_session",
      aggregate_id: sessionId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `排定 ${date} 课程（点位 ${site.name}，风险 ${riskLevel}，容量 ${session.capacity}）`,
    });
    return session;
  }

  // ---------------------------------------------------------------- 家庭申请与保障原因

  submitApplication({
    applicationId,
    childId,
    familyId,
    childName,
    siteId,
    safeguardingReason = "",
    priorityFlags = [],
    needsCareDuringSession = false,
    sensitiveProfile = {},
    submittedAt,
  }) {
    this.#site(siteId);
    if (this.applications.has(applicationId)) fail("APPLICATION_EXISTS", `申请已存在：${applicationId}`);
    for (const flag of priorityFlags) {
      if (!PRIORITY_FLAGS.includes(flag)) fail("PRIORITY_FLAG_UNKNOWN", `未知优先保障标识：${flag}`);
    }
    if (!this.children.has(childId)) {
      this.children.set(childId, {
        childId,
        familyId,
        name: childName,
        siteId,
        priorityFlags: [...priorityFlags],
        needsCareDuringSession,
        safeguardingReason,
        sensitiveProfile: { ...sensitiveProfile },
      });
    }
    const application = {
      applicationId,
      childId,
      familyId,
      siteId,
      status: "submitted",
      submittedAt: submittedAt ?? new Date().toISOString(),
    };
    this.applications.set(applicationId, application);
    this.#store.append({
      event_type: "APPLICATION_SUBMITTED",
      aggregate_type: "family_application",
      aggregate_id: applicationId,
      occurred_at: application.submittedAt,
      summary: `收到家庭 ${familyId} 的课堂申请（儿童 ${childId}）`,
      // 保障原因与家庭敏感画像不写入事件载荷，仅保存在受控状态中。
      priority_flags: [...priorityFlags],
      needs_care_during_session: needsCareDuringSession,
    });
    return application;
  }

  /**
   * 确认报名。按课程容量录取；满员时进入候补，困境儿童与新就业群体
   * 家庭排在候补队列前段。
   */
  confirmEnrollment({ applicationId, sessionIds, occurredAt }) {
    const application = this.#application(applicationId);
    if (application.status !== "submitted") fail("APPLICATION_NOT_PENDING", "申请不在待确认状态");
    const child = this.#child(application.childId);
    const results = [];
    for (const sessionId of sessionIds) {
      const session = this.#session(sessionId);
      if (session.status !== "scheduled") fail("SESSION_NOT_SCHEDULED", `课程不可报名：${sessionId}`);
      const key = `${child.childId}|${sessionId}`;
      if (this.enrollments.has(key) && this.enrollments.get(key).status !== "ended") {
        fail("ALREADY_ENROLLED", `儿童已在该课程报名：${sessionId}`);
      }
      const enrolledCount = this.#enrolledCount(sessionId);
      if (enrolledCount < session.capacity) {
        this.enrollments.set(key, { status: "enrolled", seq: this.#nextSeq() });
        this.#store.append({
          event_type: "ENROLLMENT_CONFIRMED",
          aggregate_type: "child_enrollment",
          aggregate_id: child.childId,
          occurred_at: occurredAt ?? new Date().toISOString(),
          summary: `确认儿童 ${child.childId} 报名课程 ${sessionId}`,
          session_id: sessionId,
        });
        results.push({ sessionId, status: "enrolled" });
      } else {
        this.enrollments.set(key, { status: "waitlisted", seq: this.#nextSeq() });
        results.push({ sessionId, status: "waitlisted", position: this.#waitlistPosition(sessionId, child.childId) });
      }
    }
    application.status = "confirmed";
    return results;
  }

  /** 候补队列：优先保障家庭在前，其余按申请先后。 */
  waitlist(sessionId) {
    this.#session(sessionId);
    return [...this.enrollments.entries()]
      .filter(([key, value]) => key.endsWith(`|${sessionId}`) && value.status === "waitlisted")
      .map(([key, value]) => ({ childId: key.split("|")[0], seq: value.seq, priority: this.#child(key.split("|")[0]).priorityFlags.length > 0 }))
      .sort((a, b) => Number(b.priority) - Number(a.priority) || a.seq - b.seq)
      .map((entry) => entry.childId);
  }

  // ---------------------------------------------------------------- 监护授权与接送关系

  authorizeGuardian({ childId, guardianId, relation, occurredAt }) {
    this.#child(childId);
    const list = this.guardians.get(childId) ?? [];
    if (list.some((item) => item.guardianId === guardianId)) fail("GUARDIAN_EXISTS", "该监护人已授权");
    list.push({ guardianId, relation });
    this.guardians.set(childId, list);
    this.#store.append({
      event_type: "GUARDIAN_AUTHORIZED",
      aggregate_type: "child_enrollment",
      aggregate_id: childId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `授权 ${guardianId} 为儿童 ${childId} 的监护人（${relation}）`,
    });
  }

  /** 登记常态接送人，须由已授权监护人发起。 */
  addPickupRelation({ childId, pickerId, relation, authorizedBy, occurredAt }) {
    this.#child(childId);
    this.#requireGuardian(childId, authorizedBy);
    const list = this.pickupRelations.get(childId) ?? [];
    list.push({ pickerId, relation, authorizedBy, active: true });
    this.pickupRelations.set(childId, list);
    this.#store.append({
      event_type: "PICKUP_RELATION_ADDED",
      aggregate_type: "pickup_authorization",
      aggregate_id: childId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `登记儿童 ${childId} 的接送人 ${pickerId}（${relation}）`,
      authorized_by: authorizedBy,
    });
  }

  /**
   * 临时换接送人：由监护人发起，可一次覆盖同点位的兄弟姐妹；
   * 生成待确认工单，须点位确认人核实后才生效。
   */
  requestTemporaryPickup({ ticketId, childIds, pickerId, relation, date, requestedBy, occurredAt }) {
    if (this.tempPickups.has(ticketId)) fail("TICKET_EXISTS", `工单已存在：${ticketId}`);
    if (childIds.length === 0) fail("CHILDREN_REQUIRED", "临时接送至少覆盖一名儿童");
    const siteIds = new Set();
    for (const childId of childIds) {
      const child = this.#child(childId);
      this.#requireGuardian(childId, requestedBy);
      siteIds.add(child.siteId);
    }
    if (siteIds.size > 1) fail("TEMP_PICKUP_CROSS_SITE", "同一临时接送工单仅限同一点位的儿童");
    const ticket = {
      ticketId,
      childIds: [...childIds],
      siteId: [...siteIds][0],
      pickerId,
      relation,
      date,
      requestedBy,
      status: "pending",
      confirmedBy: null,
    };
    this.tempPickups.set(ticketId, ticket);
    this.#store.append({
      event_type: "TEMP_PICKUP_REQUESTED",
      aggregate_type: "pickup_authorization",
      aggregate_id: ticketId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `监护人 ${requestedBy} 申请 ${date} 由 ${pickerId} 临时代接 ${childIds.length} 名儿童`,
      child_ids: [...childIds],
      picker_id: pickerId,
      date,
    });
    return ticket;
  }

  /** 点位确认人核实临时接送工单；每名儿童各留一条可追踪的变更记录。 */
  confirmTemporaryPickup({ ticketId, confirmedBy, occurredAt }) {
    const ticket = this.#tempPickup(ticketId);
    if (ticket.status !== "pending") fail("TICKET_NOT_PENDING", "工单不在待确认状态");
    const site = this.#site(ticket.siteId);
    if (site.coordinatorId !== confirmedBy) {
      fail("NOT_PICKUP_COORDINATOR", "仅点位指定的接送确认人可核实临时接送");
    }
    ticket.status = "confirmed";
    ticket.confirmedBy = confirmedBy;
    const at = occurredAt ?? new Date().toISOString();
    for (const childId of ticket.childIds) {
      this.#store.append({
        event_type: "PICKUP_CHANGED",
        aggregate_type: "pickup_authorization",
        aggregate_id: childId,
        occurred_at: at,
        summary: `${ticket.date} 儿童 ${childId} 临时接送人变更为 ${ticket.pickerId}，确认人 ${confirmedBy}`,
        ticket_id: ticketId,
        picker_id: ticket.pickerId,
        date: ticket.date,
        confirmed_by: confirmedBy,
      });
    }
    return ticket;
  }

  // ---------------------------------------------------------------- 人员与资质

  registerStaff({ staffId, name, role, homeSiteId, occurredAt }) {
    if (!STAFF_ROLES.includes(role)) fail("STAFF_ROLE_UNKNOWN", `未知人员角色：${role}`);
    if (this.staff.has(staffId)) fail("STAFF_EXISTS", `人员已存在：${staffId}`);
    const member = { staffId, name, role, homeSiteId, clearance: "pending" };
    this.staff.set(staffId, member);
    this.#store.append({
      event_type: "STAFF_REGISTERED",
      aggregate_type: "staff_assignment",
      aggregate_id: staffId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `登记人员 ${name}（角色 ${role}）`,
    });
    return member;
  }

  clearStaff({ staffId, clearedBy, occurredAt }) {
    const member = this.#staffMember(staffId);
    if (member.clearance === "cleared") fail("STAFF_ALREADY_CLEARED", "人员已通过审核");
    member.clearance = "cleared";
    this.#store.append({
      event_type: "STAFF_CLEARED",
      aggregate_type: "staff_assignment",
      aggregate_id: staffId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `人员 ${member.name} 通过上岗审核（审核人 ${clearedBy}）`,
      cleared_by: clearedBy,
    });
  }

  recordQualification({ staffId, kind, issuedAt, expiresAt, occurredAt }) {
    const member = this.#staffMember(staffId);
    if (!QUALIFICATION_KINDS.includes(kind)) fail("QUALIFICATION_KIND_UNKNOWN", `未知资质类型：${kind}`);
    if (expiresAt < issuedAt) fail("QUALIFICATION_PERIOD_INVALID", "资质有效期早于签发日期");
    const quals = this.qualifications.get(staffId) ?? new Map();
    quals.set(kind, { issuedAt, expiresAt, active: true });
    this.qualifications.set(staffId, quals);
    this.#store.append({
      event_type: "QUALIFICATION_RECORDED",
      aggregate_type: "staff_assignment",
      aggregate_id: staffId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `登记 ${member.name} 的资质 ${kind}（有效期至 ${expiresAt}）`,
      kind,
      expires_at: expiresAt,
    });
  }

  /**
   * 分派任务。受控任务（心理团辅、急救、外出带队、家访）要求当日有效资质；
   * 家访额外要求持证社工。未培训志愿者因此无法承担这些任务。
   */
  assignTask({ taskId, sessionId, staffId, task, occurredAt }) {
    const session = this.#session(sessionId);
    if (session.status !== "scheduled") fail("SESSION_NOT_SCHEDULED", `课程不可排班：${sessionId}`);
    const member = this.#staffMember(staffId);
    if (member.clearance !== "cleared") fail("STAFF_NOT_CLEARED", "人员未通过上岗审核");
    const requirement = TASK_REQUIREMENTS[task];
    if (!requirement) fail("TASK_UNKNOWN", `未知任务类型：${task}`);
    if (requirement.roles && !requirement.roles.includes(member.role)) {
      fail("STAFF_ROLE_NOT_ALLOWED", `${requirement.label}仅限持证社工承担`);
    }
    if (requirement.qualification && !this.#hasValidQualification(staffId, requirement.qualification, session.date)) {
      fail("QUALIFICATION_MISSING", `${member.name} 缺少当日有效的 ${requirement.qualification} 资质，不能承担${requirement.label}`);
    }
    if (this.tasks.has(taskId)) fail("TASK_EXISTS", `任务已存在：${taskId}`);
    const record = { taskId, sessionId, staffId, task, date: session.date, status: "assigned", releaseReason: null };
    this.tasks.set(taskId, record);
    this.#store.append({
      event_type: "TASK_ASSIGNED",
      aggregate_type: "staff_assignment",
      aggregate_id: staffId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `安排 ${member.name} 在 ${session.date} 承担${requirement.label}（课程 ${sessionId}）`,
      task_id: taskId,
      session_id: sessionId,
      task,
    });
    return record;
  }

  /** 人员缺席：只释放缺席当日的任务，其余日期不受影响。 */
  reportAbsence({ staffId, date, occurredAt }) {
    const member = this.#staffMember(staffId);
    const released = this.#releaseTasks(
      (record) => record.staffId === staffId && record.date === date,
      "absent",
      occurredAt,
    );
    this.#store.append({
      event_type: "STAFF_ABSENCE_REPORTED",
      aggregate_type: "staff_assignment",
      aggregate_id: staffId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `${member.name} ${date} 缺席，释放当日 ${released.length} 项任务`,
      date,
      released_task_ids: released.map((record) => record.taskId),
    });
    return released;
  }

  /** 资质到期：只释放到期日起需要该资质的任务，其他任务保留。 */
  expireQualification({ staffId, kind, asOf, occurredAt }) {
    const member = this.#staffMember(staffId);
    const quals = this.qualifications.get(staffId);
    const qual = quals?.get(kind);
    if (!qual || !qual.active) fail("QUALIFICATION_NOT_FOUND", "没有可注销的有效资质");
    qual.active = false;
    const affectedKinds = Object.entries(TASK_REQUIREMENTS)
      .filter(([, requirement]) => requirement.qualification === kind)
      .map(([task]) => task);
    const released = this.#releaseTasks(
      (record) => record.staffId === staffId && record.date >= asOf && affectedKinds.includes(record.task),
      "qualification_expired",
      occurredAt,
    );
    this.#store.append({
      event_type: "QUALIFICATION_EXPIRED",
      aggregate_type: "staff_assignment",
      aggregate_id: staffId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `${member.name} 的 ${kind} 资质自 ${asOf} 到期，释放 ${released.length} 项相关任务`,
      kind,
      as_of: asOf,
      released_task_ids: released.map((record) => record.taskId),
    });
    return released;
  }

  // ---------------------------------------------------------------- 排班签到

  /**
   * 签到。断网补签（source = "offline_backfill"）与在线签到走同一口径：
   * 同一（人员、课程、任务）的时段取并集计时长，重叠部分不重复累计。
   */
  recordCheckIn({ staffId, sessionId, task, start, end, source = "online", occurredAt }) {
    const record = [...this.tasks.values()].find(
      (item) => item.staffId === staffId && item.sessionId === sessionId && item.task === task,
    );
    if (!record || record.status !== "assigned") {
      fail("TASK_NOT_ASSIGNED", "没有对应的在派任务，不能签到");
    }
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!(startMs < endMs)) fail("CHECK_IN_PERIOD_INVALID", "签到时段无效");
    const key = (item) => item.staffId === staffId && item.sessionId === sessionId && item.task === task;
    const before = unionMinutes(this.checkIns.filter(key).map((item) => [item.startMs, item.endMs]));
    this.checkIns.push({ staffId, sessionId, task, start, end, startMs, endMs, source });
    const after = unionMinutes(this.checkIns.filter(key).map((item) => [item.startMs, item.endMs]));
    const creditedMinutes = after - before;
    this.#store.append({
      event_type: source === "offline_backfill" ? "CHECK_IN_BACKFILLED" : "CHECK_IN_RECORDED",
      aggregate_type: "attendance",
      aggregate_id: `${staffId}:${sessionId}:${task}`,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary:
        creditedMinutes > 0
          ? `${staffId} 签到 ${start}～${end}，计 ${creditedMinutes} 分钟`
          : `${staffId} 补签时段与已有记录重叠，未重复累计`,
      staff_id: staffId,
      session_id: sessionId,
      task,
      start,
      end,
      source,
      credited_minutes: creditedMinutes,
    });
    return { creditedMinutes };
  }

  /** 当日服务时长：同一（课程、任务）的多段签到取时段并集，跨段重叠不重复累计。 */
  staffHoursForDate(staffId, date) {
    const grouped = new Map();
    for (const item of this.checkIns) {
      if (item.staffId !== staffId || dateOf(item.start) !== date) continue;
      const key = `${item.sessionId}|${item.task}`;
      const list = grouped.get(key) ?? [];
      list.push([item.startMs, item.endMs]);
      grouped.set(key, list);
    }
    return [...grouped.values()].reduce((total, intervals) => total + unionMinutes(intervals), 0) / 60;
  }

  recordChildAttendance({ childId, sessionId, occurredAt }) {
    this.#child(childId);
    const session = this.#session(sessionId);
    if (session.status !== "scheduled") fail("SESSION_NOT_SCHEDULED", "课程未在进行中");
    if (this.enrollments.get(`${childId}|${sessionId}`)?.status !== "enrolled") {
      fail("NOT_ENROLLED", "儿童未报名该课程");
    }
    this.childAttendance.add(`${childId}|${sessionId}`);
    this.#store.append({
      event_type: "CHILD_ATTENDANCE_RECORDED",
      aggregate_type: "attendance",
      aggregate_id: `${childId}:${sessionId}`,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `记录儿童 ${childId} 到课（课程 ${sessionId}）`,
      child_id: childId,
      session_id: sessionId,
    });
  }

  // ---------------------------------------------------------------- 外出活动与家访

  /** 外出活动：须先有一名当日有效急救资质的人员在班，家长才能在日报中看到并授权。 */
  planOuting({ outingId, sessionId, destination, departureAt, returnAt, occurredAt }) {
    const session = this.#session(sessionId);
    if (session.status !== "scheduled") fail("SESSION_NOT_SCHEDULED", "课程未在进行中");
    const covered = [...this.tasks.values()].some(
      (record) =>
        record.sessionId === sessionId &&
        record.status === "assigned" &&
        (record.task === "first_aid" || record.task === "outing_lead") &&
        this.#hasValidQualification(record.staffId, "first_aid", session.date),
    );
    if (!covered) fail("OUTING_WITHOUT_FIRST_AID", "外出活动须安排持有效急救资质的人员随行");
    if (this.outings.has(outingId)) fail("OUTING_EXISTS", `外出计划已存在：${outingId}`);
    const outing = { outingId, sessionId, destination, departureAt, returnAt, consents: new Map() };
    this.outings.set(outingId, outing);
    this.#store.append({
      event_type: "OUTING_PLANNED",
      aggregate_type: "outing_plan",
      aggregate_id: outingId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `课程 ${sessionId} 计划外出至${destination}`,
      session_id: sessionId,
      destination,
      departure_at: departureAt,
      return_at: returnAt,
    });
    return outing;
  }

  recordOutingConsent({ outingId, childId, guardianId, occurredAt }) {
    const outing = this.#outing(outingId);
    this.#child(childId);
    this.#requireGuardian(childId, guardianId);
    if (this.enrollments.get(`${childId}|${outing.sessionId}`)?.status !== "enrolled") {
      fail("NOT_ENROLLED", "儿童未报名该课程，不能授权外出");
    }
    outing.consents.set(childId, { guardianId, at: occurredAt ?? new Date().toISOString() });
    this.#store.append({
      event_type: "OUTING_CONSENTED",
      aggregate_type: "outing_plan",
      aggregate_id: outingId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `监护人 ${guardianId} 同意儿童 ${childId} 参加外出`,
      child_id: childId,
      guardian_id: guardianId,
    });
  }

  /** 家访：仅限持有效家访资质的持证社工。 */
  scheduleHomeVisit({ visitId, childId, staffId, at, occurredAt }) {
    this.#child(childId);
    const member = this.#staffMember(staffId);
    if (member.clearance !== "cleared") fail("STAFF_NOT_CLEARED", "人员未通过上岗审核");
    if (member.role !== "licensed_social_worker") fail("STAFF_ROLE_NOT_ALLOWED", "家访仅限持证社工承担");
    if (!this.#hasValidQualification(staffId, "home_visit", dateOf(at))) {
      fail("QUALIFICATION_MISSING", "缺少当日有效的家访资质");
    }
    if (this.homeVisits.has(visitId)) fail("VISIT_EXISTS", `家访已存在：${visitId}`);
    const visit = { visitId, childId, staffId, at, status: "scheduled", outcome: null };
    this.homeVisits.set(visitId, visit);
    this.#store.append({
      event_type: "HOME_VISIT_SCHEDULED",
      aggregate_type: "home_visit",
      aggregate_id: visitId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `安排 ${member.name} 于 ${at} 家访儿童 ${childId}`,
      child_id: childId,
      staff_id: staffId,
      at,
    });
    return visit;
  }

  completeHomeVisit({ visitId, outcome, occurredAt }) {
    const visit = this.homeVisits.get(visitId);
    if (!visit) fail("VISIT_NOT_FOUND", `家访不存在：${visitId}`);
    if (visit.status !== "scheduled") fail("VISIT_NOT_SCHEDULED", "家访不在待完成状态");
    visit.status = "completed";
    visit.outcome = outcome;
    this.#store.append({
      event_type: "HOME_VISIT_COMPLETED",
      aggregate_type: "home_visit",
      aggregate_id: visitId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `家访 ${visitId} 完成`,
      // 家访结论属敏感信息，不写入事件载荷。
    });
    return visit;
  }

  // ---------------------------------------------------------------- 跨点调班与兄弟姐妹联动

  /** 调班申请：由监护人发起，目标课程须有余量；兄弟姐妹可共用一个调班组。 */
  requestTransfer({ transferId, childId, toSessionId, requestedBy, groupId = null, occurredAt }) {
    const child = this.#child(childId);
    this.#requireGuardian(childId, requestedBy);
    const target = this.#session(toSessionId);
    if (target.status !== "scheduled") fail("SESSION_NOT_SCHEDULED", "目标课程不可调入");
    if (this.#enrolledCount(toSessionId) >= target.capacity) fail("SESSION_FULL", "目标课程已满员");
    if (this.transfers.has(transferId)) fail("TRANSFER_EXISTS", `调班单已存在：${transferId}`);
    const transfer = {
      transferId,
      groupId,
      childId,
      fromSessionIds: this.#enrolledSessionIds(childId).filter((id) => this.#session(id).date === target.date),
      toSessionId,
      requestedBy,
      status: "pending",
    };
    this.transfers.set(transferId, transfer);
    this.#store.append({
      event_type: "TRANSFER_REQUESTED",
      aggregate_type: "transfer_request",
      aggregate_id: transferId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `监护人 ${requestedBy} 申请将儿童 ${childId} 调入课程 ${toSessionId}`,
      child_id: childId,
      to_session_id: toSessionId,
      group_id: groupId,
    });
    return transfer;
  }

  /** 兄弟姐妹同组调班：为每名儿童各建一张调班单，共享 groupId 便于追踪。 */
  requestSiblingTransfer({ groupId, childIds, toSessionId, requestedBy, occurredAt }) {
    if (childIds.length < 2) fail("SIBLINGS_REQUIRED", "兄弟姐妹调班至少两名儿童");
    return childIds.map((childId, index) =>
      this.requestTransfer({
        transferId: `${groupId}-${index + 1}`,
        childId,
        toSessionId,
        requestedBy,
        groupId,
        occurredAt,
      }),
    );
  }

  /** 监护人确认调班后生效，原课程名额随之释放。 */
  confirmTransfer({ transferId, confirmedBy, occurredAt }) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) fail("TRANSFER_NOT_FOUND", `调班单不存在：${transferId}`);
    if (transfer.status !== "pending") fail("TRANSFER_NOT_PENDING", "调班单不在待确认状态");
    this.#requireGuardian(transfer.childId, confirmedBy);
    const target = this.#session(transfer.toSessionId);
    if (this.#enrolledCount(transfer.toSessionId) >= target.capacity) fail("SESSION_FULL", "目标课程已满员");
    transfer.status = "confirmed";
    const at = occurredAt ?? new Date().toISOString();
    for (const fromSessionId of transfer.fromSessionIds) {
      this.enrollments.delete(`${transfer.childId}|${fromSessionId}`);
    }
    this.enrollments.set(`${transfer.childId}|${transfer.toSessionId}`, { status: "enrolled", seq: this.#nextSeq() });
    this.#store.append({
      event_type: "TRANSFER_CONFIRMED",
      aggregate_type: "transfer_request",
      aggregate_id: transferId,
      occurred_at: at,
      summary: `调班单 ${transferId} 经监护人 ${confirmedBy} 确认生效`,
      child_id: transfer.childId,
      to_session_id: transfer.toSessionId,
      confirmed_by: confirmedBy,
    });
    this.#store.append({
      event_type: "SESSION_REASSIGNED",
      aggregate_type: "child_enrollment",
      aggregate_id: transfer.childId,
      occurred_at: at,
      summary: `儿童 ${transfer.childId} 自 ${transfer.fromSessionIds.join("、") || "无"} 调入 ${transfer.toSessionId}`,
      from_session_ids: [...transfer.fromSessionIds],
      to_session_id: transfer.toSessionId,
      transfer_id: transferId,
      reason: "transfer_confirmed",
    });
    return transfer;
  }

  /** 同组确认：任一张失败则整组不生效。 */
  confirmSiblingTransfer({ groupId, confirmedBy, occurredAt }) {
    const group = [...this.transfers.values()].filter((transfer) => transfer.groupId === groupId);
    if (group.length === 0) fail("TRANSFER_GROUP_NOT_FOUND", `调班组不存在：${groupId}`);
    for (const transfer of group) {
      const target = this.#session(transfer.toSessionId);
      const pendingInGroup = group.filter((item) => item.toSessionId === transfer.toSessionId && item.status === "pending").length;
      if (this.#enrolledCount(transfer.toSessionId) + pendingInGroup > target.capacity) {
        fail("SESSION_FULL", "目标课程容量不足以整组调入");
      }
    }
    return group.map((transfer) => this.confirmTransfer({ transferId: transfer.transferId, confirmedBy, occurredAt }));
  }

  // ---------------------------------------------------------------- 课程取消

  /**
   * 取消课程：先为上课时段无人照看的儿童逐一落实安排
   * （优先困境儿童与新就业群体家庭，能调班则调班，否则登记监护人接回），
   * 全部落实后课程才标记取消并释放排班任务。
   */
  cancelSession({ sessionId, reason, occurredAt }) {
    const session = this.#session(sessionId);
    if (session.status !== "scheduled") fail("SESSION_NOT_SCHEDULED", "课程已取消");
    const at = occurredAt ?? new Date().toISOString();
    const enrolledChildren = this.#enrolledChildren(sessionId);
    const unattended = enrolledChildren
      .filter((child) => child.needsCareDuringSession)
      .sort((a, b) => Number(b.priorityFlags.length > 0) - Number(a.priorityFlags.length > 0));
    const arrangements = [];
    for (const child of unattended) {
      const target = this.#findAlternativeSession(session, child.childId);
      if (target) {
        this.enrollments.delete(`${child.childId}|${sessionId}`);
        this.enrollments.set(`${child.childId}|${target.sessionId}`, { status: "enrolled", seq: this.#nextSeq() });
        this.#store.append({
          event_type: "SESSION_REASSIGNED",
          aggregate_type: "child_enrollment",
          aggregate_id: child.childId,
          occurred_at: at,
          summary: `课程取消，儿童 ${child.childId} 调入 ${target.sessionId}`,
          from_session_ids: [sessionId],
          to_session_id: target.sessionId,
          reason: "session_cancelled",
        });
        arrangements.push({ childId: child.childId, type: "transfer", toSessionId: target.sessionId });
      } else {
        arrangements.push({ childId: child.childId, type: "guardian_pickup" });
      }
      this.#store.append({
        event_type: "CARE_ARRANGEMENT_RECORDED",
        aggregate_type: "child_enrollment",
        aggregate_id: child.childId,
        occurred_at: at,
        summary: `课程 ${sessionId} 取消，已为儿童 ${child.childId} 落实照看安排`,
        session_id: sessionId,
        arrangement: arrangements[arrangements.length - 1],
      });
    }
    for (const child of enrolledChildren) {
      const key = `${child.childId}|${sessionId}`;
      if (this.enrollments.has(key)) this.enrollments.set(key, { status: "ended", seq: this.#nextSeq() });
    }
    this.#releaseTasks((record) => record.sessionId === sessionId, "session_cancelled", at);
    session.status = "cancelled";
    this.#store.append({
      event_type: "SESSION_CANCELLED",
      aggregate_type: "site_session",
      aggregate_id: sessionId,
      occurred_at: at,
      summary: `课程 ${sessionId} 取消（${reason}），${unattended.length} 名无人照看儿童已先行安置`,
      reason,
      unattended_child_count: unattended.length,
    });
    return arrangements;
  }

  // ---------------------------------------------------------------- 安全线索处置

  /**
   * 安全线索升级：自动指派给服务该点位的持证社工，并同步通知监护人；
   * 处置记录仅可追加，不得改写或删除。
   */
  raiseConcern({ caseId, childId, raisedBy, detail, occurredAt }) {
    const child = this.#child(childId);
    if (this.cases.has(caseId)) fail("CASE_EXISTS", `个案已存在：${caseId}`);
    const assignee = [...this.staff.values()].find(
      (member) =>
        member.role === "licensed_social_worker" &&
        member.clearance === "cleared" &&
        (member.homeSiteId === child.siteId ||
          [...this.tasks.values()].some(
            (record) =>
              record.staffId === member.staffId &&
              record.status === "assigned" &&
              this.#session(record.sessionId).siteId === child.siteId,
          )),
    );
    if (!assignee) fail("CASE_NO_LICENSED_WORKER", "该点位暂无可用持证社工，无法受理线索");
    const guardianIds = (this.guardians.get(childId) ?? []).map((item) => item.guardianId);
    const record = {
      caseId,
      childId,
      siteId: child.siteId,
      raisedBy,
      detail,
      status: "open",
      assigneeId: assignee.staffId,
      notes: [],
      openedAt: occurredAt ?? new Date().toISOString(),
      closedAt: null,
    };
    this.cases.set(caseId, record);
    this.#store.append({
      event_type: "CASE_ESCALATED",
      aggregate_type: "safeguarding_case",
      aggregate_id: caseId,
      occurred_at: record.openedAt,
      summary: `安全线索升级，指派持证社工 ${assignee.name} 接手并通知监护人`,
      child_id: childId,
      site_id: child.siteId,
      assignee_id: assignee.staffId,
      guardian_notified_ids: guardianIds,
      // 线索细节属敏感信息，不写入事件载荷。
    });
    return record;
  }

  addCaseNote({ caseId, authorId, note, occurredAt }) {
    const record = this.#case(caseId);
    if (record.assigneeId !== authorId && !this.#isGuardian(record.childId, authorId)) {
      fail("CASE_NOTE_FORBIDDEN", "仅承办社工或监护人可补充个案记录");
    }
    record.notes.push({ authorId, note, at: occurredAt ?? new Date().toISOString() });
    this.#store.append({
      event_type: "CASE_NOTE_ADDED",
      aggregate_type: "safeguarding_case",
      aggregate_id: caseId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `个案 ${caseId} 追加一条处置记录（作者 ${authorId}）`,
      author_id: authorId,
    });
  }

  updateCaseStatus({ caseId, status, by, occurredAt }) {
    const record = this.#case(caseId);
    if (record.assigneeId !== by) fail("CASE_UPDATE_FORBIDDEN", "仅承办社工可变更个案状态");
    if (!["open", "in_progress", "closed"].includes(status)) fail("CASE_STATUS_UNKNOWN", `未知个案状态：${status}`);
    record.status = status;
    if (status === "closed") record.closedAt = occurredAt ?? new Date().toISOString();
    this.#store.append({
      event_type: "CASE_STATUS_UPDATED",
      aggregate_type: "safeguarding_case",
      aggregate_id: caseId,
      occurred_at: occurredAt ?? new Date().toISOString(),
      summary: `个案 ${caseId} 状态变更为 ${status}`,
      status,
      by,
    });
  }

  // ---------------------------------------------------------------- 内部工具

  #site(siteId) {
    const site = this.sites.get(siteId);
    if (!site) fail("SITE_NOT_FOUND", `点位不存在：${siteId}`);
    return site;
  }

  #session(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) fail("SESSION_NOT_FOUND", `课程不存在：${sessionId}`);
    return session;
  }

  #child(childId) {
    const child = this.children.get(childId);
    if (!child) fail("CHILD_NOT_FOUND", `儿童不存在：${childId}`);
    return child;
  }

  #application(applicationId) {
    const application = this.applications.get(applicationId);
    if (!application) fail("APPLICATION_NOT_FOUND", `申请不存在：${applicationId}`);
    return application;
  }

  #staffMember(staffId) {
    const member = this.staff.get(staffId);
    if (!member) fail("STAFF_NOT_FOUND", `人员不存在：${staffId}`);
    return member;
  }

  #tempPickup(ticketId) {
    const ticket = this.tempPickups.get(ticketId);
    if (!ticket) fail("TICKET_NOT_FOUND", `工单不存在：${ticketId}`);
    return ticket;
  }

  #outing(outingId) {
    const outing = this.outings.get(outingId);
    if (!outing) fail("OUTING_NOT_FOUND", `外出计划不存在：${outingId}`);
    return outing;
  }

  #case(caseId) {
    const record = this.cases.get(caseId);
    if (!record) fail("CASE_NOT_FOUND", `个案不存在：${caseId}`);
    return record;
  }

  #isGuardian(childId, principalId) {
    return (this.guardians.get(childId) ?? []).some((item) => item.guardianId === principalId);
  }

  #requireGuardian(childId, principalId) {
    if (!this.#isGuardian(childId, principalId)) {
      fail("NOT_GUARDIAN", `${principalId} 不是儿童 ${childId} 的授权监护人`);
    }
  }

  #hasValidQualification(staffId, kind, date) {
    const qual = this.qualifications.get(staffId)?.get(kind);
    return Boolean(qual && qual.active && qual.expiresAt >= date);
  }

  #enrolledCount(sessionId) {
    return [...this.enrollments.entries()].filter(
      ([key, value]) => key.endsWith(`|${sessionId}`) && value.status === "enrolled",
    ).length;
  }

  #enrolledChildren(sessionId) {
    return [...this.enrollments.entries()]
      .filter(([key, value]) => key.endsWith(`|${sessionId}`) && value.status === "enrolled")
      .map(([key]) => this.#child(key.split("|")[0]));
  }

  #enrolledSessionIds(childId) {
    return [...this.enrollments.entries()]
      .filter(([key, value]) => key.startsWith(`${childId}|`) && value.status === "enrolled")
      .map(([key]) => key.split("|")[1]);
  }

  #waitlistPosition(sessionId, childId) {
    return this.waitlist(sessionId).indexOf(childId) + 1;
  }

  #releaseTasks(predicate, reason, occurredAt) {
    const released = [...this.tasks.values()].filter((record) => record.status === "assigned" && predicate(record));
    for (const record of released) {
      record.status = "released";
      record.releaseReason = reason;
      this.#store.append({
        event_type: "TASK_RELEASED",
        aggregate_type: "staff_assignment",
        aggregate_id: record.staffId,
        occurred_at: occurredAt ?? new Date().toISOString(),
        summary: `释放任务 ${record.taskId}（${record.task}，原因 ${reason}）`,
        task_id: record.taskId,
        session_id: record.sessionId,
        task: record.task,
        reason,
      });
    }
    return released;
  }

  /** 为被取消课程中的儿童寻找替代课程：同点位优先，须同日、有余量。 */
  #findAlternativeSession(cancelledSession, childId) {
    const candidates = [...this.sessions.values()]
      .filter(
        (session) =>
          session.sessionId !== cancelledSession.sessionId &&
          session.status === "scheduled" &&
          session.date === cancelledSession.date &&
          this.#enrolledCount(session.sessionId) < session.capacity &&
          this.enrollments.get(`${childId}|${session.sessionId}`)?.status !== "enrolled",
      )
      .sort((a, b) => Number(b.siteId === cancelledSession.siteId) - Number(a.siteId === cancelledSession.siteId));
    return candidates[0] ?? null;
  }
}

/** 时段并集（分钟），用于签到去重。 */
function unionMinutes(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let currentStart = null;
  let currentEnd = null;
  for (const [start, end] of sorted) {
    if (currentEnd === null || start > currentEnd) {
      if (currentEnd !== null) total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else if (end > currentEnd) {
      currentEnd = end;
    }
  }
  if (currentEnd !== null) total += currentEnd - currentStart;
  return total / 60000;
}
