/**
 * 领域事件基础校验：信封完整性 + 事件/聚合配对 + 角色与数据分级枚举。
 * 目录与 src/domain.ts 的 EventTypeCatalog 保持一致。
 */

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_AGGREGATE = Object.freeze({
  APPLICATION_SUBMITTED: "family_application",
  ELIGIBILITY_REVIEWED: "family_application",
  APPLICATION_APPROVED: "family_application",
  APPLICATION_WAITLISTED: "family_application",
  ENROLLMENT_CONFIRMED: "child_enrollment",
  ENROLLMENT_CANCELLED: "child_enrollment",
  WAITLIST_PROMOTED: "child_enrollment",
  SEAT_PRIORITY_APPLIED: "child_enrollment",
  GUARDIANSHIP_AUTHORIZED: "guardianship_grant",
  PICKUP_AUTHORIZED: "guardianship_grant",
  PICKUP_CHANGED: "guardianship_grant",
  PICKUP_CONFIRMED: "guardianship_grant",
  PICKUP_REJECTED: "guardianship_grant",
  SITE_REGISTERED: "site",
  SITE_CAPACITY_CHANGED: "site",
  SESSION_PLANNED: "site_session",
  SESSION_RISK_REVIEWED: "site_session",
  SESSION_CANCELLED: "site_session",
  REASSIGNMENT_OFFERED: "site_session",
  SESSION_REASSIGNED: "site_session",
  STAFF_REGISTERED: "staff_member",
  STAFF_CLEARED: "staff_member",
  CREDENTIAL_EXPIRING: "staff_member",
  CREDENTIAL_EXPIRED: "staff_member",
  ASSIGNMENT_SCHEDULED: "staff_assignment",
  ASSIGNMENT_TASK_BLOCKED: "staff_assignment",
  STAFF_ABSENT: "staff_assignment",
  ASSIGNMENT_TASK_RELEASED: "staff_assignment",
  ASSIGNMENT_TASK_RECLAIMED: "staff_assignment",
  CHECKIN_RECORDED: "attendance_record",
  CHECKOUT_RECORDED: "attendance_record",
  OFFLINE_CHECKIN_QUEUED: "attendance_record",
  ATTENDANCE_RECONCILED: "attendance_record",
  OUTING_PLANNED: "activity_outing",
  OUTING_APPROVED: "activity_outing",
  OUTING_DEPARTED: "activity_outing",
  OUTING_RETURNED: "activity_outing",
  HOME_VISIT_SCHEDULED: "home_visit",
  HOME_VISIT_CONFIRMED: "home_visit",
  HOME_VISIT_COMPLETED: "home_visit",
  SAFEGUARDING_CONCERN_RAISED: "safeguarding_case",
  CASE_ESCALATED: "safeguarding_case",
  CASE_ASSIGNED: "safeguarding_case",
  GUARDIAN_NOTIFIED: "safeguarding_case",
  INCIDENT_RECORDED: "safeguarding_case",
  RECORD_RETENTION_LOCKED: "safeguarding_case",
  CASE_RESOLVED: "safeguarding_case",
  DEIDENTIFIED_DATASET_RELEASED: "analytics_dataset",
});

export const EVENT_CLASSIFICATION = Object.freeze({
  APPLICATION_SUBMITTED: "restricted",
  ELIGIBILITY_REVIEWED: "restricted",
  GUARDIANSHIP_AUTHORIZED: "restricted",
  PICKUP_AUTHORIZED: "restricted",
  PICKUP_CHANGED: "restricted",
  HOME_VISIT_SCHEDULED: "restricted",
  HOME_VISIT_CONFIRMED: "restricted",
  HOME_VISIT_COMPLETED: "restricted",
  SAFEGUARDING_CONCERN_RAISED: "restricted",
  CASE_ESCALATED: "sealed",
  CASE_ASSIGNED: "sealed",
  GUARDIAN_NOTIFIED: "sealed",
  INCIDENT_RECORDED: "sealed",
  RECORD_RETENTION_LOCKED: "sealed",
  CASE_RESOLVED: "sealed",
});

const ROLES = new Set([
  "guardian",
  "certified_social_worker",
  "league_cadre",
  "site_lead",
  "volunteer",
  "course_provider",
  "enterprise_host",
  "operations_staff",
  "city_project_team",
  "system",
]);

const CLASSIFICATIONS = new Set(["operational", "restricted", "sealed"]);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 仅校验信封与目录约定；业务前置条件（资质、容量、授权链）见 docs/workflows.md。 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if (errors.length) return errors;

  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push("version 必须是正整数");
  }
  for (const name of ["event_id", "event_type", "aggregate_type", "aggregate_id", "summary"]) {
    if (typeof record[name] !== "string" || record[name].length === 0) {
      errors.push(`${name} 必须是非空字符串`);
    }
  }
  if (typeof record.occurred_at !== "string" || !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是 RFC 3339 日期时间");
  }

  const expectedAggregate = EVENT_AGGREGATE[record.event_type];
  if (!expectedAggregate) {
    errors.push(`未知事件类型：${record.event_type}`);
  } else if (record.aggregate_type !== expectedAggregate) {
    errors.push(`${record.event_type} 必须归属聚合 ${expectedAggregate}，实际为 ${record.aggregate_type}`);
  }

  if (record.actor !== undefined) {
    if (typeof record.actor !== "object" || record.actor === null) {
      errors.push("actor 必须是对象");
    } else {
      if (!record.actor.actor_id) errors.push("actor.actor_id 缺失");
      if (!ROLES.has(record.actor.role)) errors.push(`未知角色：${record.actor.role}`);
    }
  }

  if (
    record.data_classification !== undefined &&
    !CLASSIFICATIONS.has(record.data_classification)
  ) {
    errors.push(`未知数据分级：${record.data_classification}`);
  }

  if (record.related_events !== undefined) {
    if (!Array.isArray(record.related_events) || record.related_events.some((id) => typeof id !== "string")) {
      errors.push("related_events 必须是字符串数组");
    } else if (new Set(record.related_events).size !== record.related_events.length) {
      errors.push("related_events 存在重复");
    }
  }

  return errors;
}

/** 事件类型在目录中的默认数据分级（未列出的为 operational）。 */
export function defaultClassification(eventType) {
  return EVENT_CLASSIFICATION[eventType] ?? "operational";
}
