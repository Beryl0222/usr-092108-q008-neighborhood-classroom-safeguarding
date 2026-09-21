/**
 * 邻里课堂安全协作的领域事件类型与仅追加事件存储。
 *
 * 事件一经追加不可改写：标识、发生时间与版本保持原样，
 * 业务更正（如接送人变更、排班调整）一律以后继事件表达。
 */

/** 事件类型。与 contracts/domain.schema.json 的 event_type 枚举保持一致。 */
export const EVENT_TYPES = Object.freeze([
  // 既有约定
  "ENROLLMENT_CONFIRMED",
  "STAFF_CLEARED",
  "SESSION_REASSIGNED",
  "PICKUP_CHANGED",
  "CASE_ESCALATED",
  // 家庭申请与保障原因
  "APPLICATION_SUBMITTED",
  // 点位与课程
  "SITE_REGISTERED",
  "SITE_COORDINATOR_DESIGNATED",
  "SESSION_SCHEDULED",
  "SESSION_CANCELLED",
  "CARE_ARRANGEMENT_RECORDED",
  // 监护授权与接送关系
  "GUARDIAN_AUTHORIZED",
  "PICKUP_RELATION_ADDED",
  "TEMP_PICKUP_REQUESTED",
  // 人员与资质
  "STAFF_REGISTERED",
  "QUALIFICATION_RECORDED",
  "QUALIFICATION_EXPIRED",
  "STAFF_ABSENCE_REPORTED",
  "TASK_ASSIGNED",
  "TASK_RELEASED",
  // 排班签到（含断网补签）
  "CHECK_IN_RECORDED",
  "CHECK_IN_BACKFILLED",
  "CHILD_ATTENDANCE_RECORDED",
  // 外出活动与家访
  "OUTING_PLANNED",
  "OUTING_CONSENTED",
  "HOME_VISIT_SCHEDULED",
  "HOME_VISIT_COMPLETED",
  // 跨点调班与兄弟姐妹联动
  "TRANSFER_REQUESTED",
  "TRANSFER_CONFIRMED",
  // 安全线索处置
  "CASE_NOTE_ADDED",
  "CASE_STATUS_UPDATED",
]);

/** 聚合类型。与 contracts/domain.schema.json 的 aggregate_type 枚举保持一致。 */
export const AGGREGATE_TYPES = Object.freeze([
  // 既有约定
  "child_enrollment",
  "site_session",
  "staff_assignment",
  "safeguarding_case",
  // 扩展
  "family_application",
  "site",
  "pickup_authorization",
  "attendance",
  "outing_plan",
  "home_visit",
  "transfer_request",
]);

/** 领域规则违例。code 供调用方程序化判断。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/**
 * 仅追加事件存储。版本号按聚合单调递增，由存储统一分配，
 * 调用方不能指定或回写版本。
 */
export class EventStore {
  #events = [];
  #versions = new Map();
  #seq = 0;

  append({ event_type, aggregate_type, aggregate_id, occurred_at, summary, ...payload }) {
    if (!EVENT_TYPES.includes(event_type)) {
      throw new DomainError("UNKNOWN_EVENT_TYPE", `未知事件类型：${event_type}`);
    }
    if (!AGGREGATE_TYPES.includes(aggregate_type)) {
      throw new DomainError("UNKNOWN_AGGREGATE_TYPE", `未知聚合类型：${aggregate_type}`);
    }
    if (typeof aggregate_id !== "string" || aggregate_id.length === 0) {
      throw new DomainError("AGGREGATE_ID_REQUIRED", "aggregate_id 不能为空");
    }
    if (typeof occurred_at !== "string" || Number.isNaN(Date.parse(occurred_at))) {
      throw new DomainError("OCCURRED_AT_INVALID", "occurred_at 必须是可解析的时间串");
    }
    if (typeof summary !== "string" || summary.length === 0) {
      throw new DomainError("SUMMARY_REQUIRED", "summary 不能为空");
    }
    const key = `${aggregate_type}:${aggregate_id}`;
    const version = (this.#versions.get(key) ?? 0) + 1;
    this.#versions.set(key, version);
    this.#seq += 1;
    const event = Object.freeze({
      event_id: `evt-${String(this.#seq).padStart(6, "0")}`,
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at,
      version,
      summary,
      ...payload,
    });
    this.#events.push(event);
    return event;
  }

  all() {
    return [...this.#events];
  }

  forAggregate(aggregateType, aggregateId) {
    return this.#events.filter(
      (event) => event.aggregate_type === aggregateType && event.aggregate_id === aggregateId,
    );
  }

  ofType(eventType) {
    return this.#events.filter((event) => event.event_type === eventType);
  }
}
