/**
 * 邻里课堂安全协作领域定义。
 *
 * 设计原则：
 * - 事件一经接收即不可原地改写；业务更正产生后继事件（version 递增，related_events 串联）。
 * - 敏感资料按数据分级标注：restricted 仅向实际服务该儿童的持证社工开放，
 *   sealed 为升级后证据保全；课程方、企业、运营只能读 operational 必要状态。
 * - 每一个“人对任务”的动作都校验角色与资质，未培训志愿者不能承担心理团辅、急救、家访。
 */

// ---------------------------------------------------------------------------
// 基础信封
// ---------------------------------------------------------------------------

/** 可触发领域动作的角色。职责边界见 docs/roles-and-access.md。 */
export type ActorRole =
  | "guardian" // 监护人：申请、授权、接送确认、被通知
  | "certified_social_worker" // 持证社工：资格审核、家访、安全线索处置
  | "league_cadre" // 团干部：点位统筹、排班审核、跨点调班
  | "site_lead" // 点位负责人：当日签到、外出带队、事件首报
  | "volunteer" // 高校志愿者：经培训后仅可承担普通陪护任务
  | "course_provider" // 课程方：只见课程必要信息，不见家庭完整情况
  | "enterprise_host" // 企业/园区主办方：只见容量与必要运营状态
  | "operations_staff" // 运营人员：排班协调与状态跟踪，不见敏感内容
  | "city_project_team" // 市级项目组：只读去标识数据做连续性评估
  | "system"; // 系统自动事件（到期提醒、补签对账等）

export type DataClassification =
  | "operational" // 完成职责所必需的状态
  | "restricted" // 家庭敏感资料（保障原因、困境情况、家访/案件内容）
  | "sealed"; // 升级后保全的证据记录，不可删除、按留存策略冻结

export interface Actor {
  actor_id: string;
  role: ActorRole;
  /** 实际服务关系校验：访问 restricted 数据时必须与该儿童存在在册服务关系。 */
  serving_child_ids?: string[];
}

export interface DomainEvent<TType extends string = string, TPayload = unknown> {
  event_id: string;
  event_type: TType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string; // RFC 3339
  version: number;
  summary: string;
  actor?: Actor;
  site_id?: string;
  data_classification?: DataClassification;
  /** 前驱/关联事件，构成可追踪确认链。 */
  related_events?: string[];
  payload?: TPayload;
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

export type AggregateType =
  | "family_application" // 家庭申请 + 保障原因（敏感）
  | "child_enrollment" // 儿童入点与优先级
  | "guardianship_grant" // 监护授权与接送关系
  | "site" // 点位与容量
  | "site_session" // 某日某点位的课堂/课程班次与风险
  | "staff_member" // 人员档案与资质
  | "staff_assignment" // 排班：人 × 班次 × 任务
  | "attendance_record" // 签到/签退与补签
  | "activity_outing" // 外出活动
  | "home_visit" // 家访
  | "safeguarding_case" // 安全线索/事件处置
  | "analytics_dataset"; // 去标识分析数据集

export type SiteKind = "community" | "village" | "enterprise" | "industrial_park";

/** 保障原因类别决定优先保障；具体原因描述属 restricted。 */
export type SupportReasonCode =
  | "child_in_difficulty" // 困境儿童
  | "new_employment_family" // 新就业群体（外卖/快递/网约工等）家庭
  | "dual_working_family" // 双职工且无替代照护
  | "single_caregiver"
  | "other";

export type ApplicationStatus =
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "waitlisted"
  | "cancelled";

export type EnrollmentStatus =
  | "confirmed"
  | "cancelled" // 家庭取消或长期不到
  | "no_show"
  | "completed";

/** 任务类型 → 所需资质。排班时做硬匹配。 */
export type TaskKind =
  | "general_care" // 普通陪护：基础培训即可
  | "psychological_group" // 心理团辅：须心理咨询相关资质
  | "first_aid" // 急救值守：须急救证
  | "home_visit" // 家访：须持证社工，且双人同行
  | "outing_lead" // 外出带队：点位负责人/团干部
  | "signin_desk" // 签到台
  | "course_delivery"; // 课程交付（课程方人员）

export type CredentialCode =
  | "social_worker_cert" // 持证社工
  | "psychological_counseling"
  | "first_aid_cert"
  | "basic_training" // 志愿者基础培训
  | "background_check"; // 入职/入岗前背景核查

export type AssignmentState =
  | "scheduled"
  | "active"
  | "task_blocked" // 资质不足/到期，该任务被拦截
  | "released" // 人员缺席或资质到期：仅释放对应任务
  | "reclaimed" // 任务被具备资质者重新认领
  | "completed";

export type AttendanceKind = "checkin" | "checkout";

export type OutingStatus = "planned" | "approved" | "departed" | "returned" | "cancelled";

export type HomeVisitStatus = "scheduled" | "confirmed" | "completed" | "cancelled";

export type CaseStatus =
  | "concern_raised"
  | "escalated"
  | "assigned"
  | "guardian_notified"
  | "under_handling"
  | "resolved";

export type CaseSeverity = "watch" | "elevated" | "urgent";

// ---------------------------------------------------------------------------
// 各事件 payload
// ---------------------------------------------------------------------------

export interface ApplicationPayload {
  application_id: string;
  child_id: string;
  family_id: string;
  site_id: string;
  preferred_session_ids: string[];
  /** 是否存在兄弟姐妹同时申请（用于联动排班与容量预留）。 */
  sibling_ids: string[];
  support_reason_code?: SupportReasonCode;
  /** 敏感：仅随 restricted 事件出现，运营/课程方/企业不可见。 */
  support_reason_detail_ref?: string; // 指向受控保管的敏感档案，不入普通事件流
  no_alternative_care: boolean;
  guardian_user_id: string;
}

export interface EligibilityReviewPayload {
  application_id: string;
  decision: "eligible" | "ineligible" | "more_info";
  priority_tier: number; // 1 最高：困境儿童/新就业且无人照护优先
  reviewed_by_social_worker_id: string;
  note_ref?: string; // restricted 备注的受控引用
}

export interface EnrollmentPayload {
  enrollment_id: string;
  application_id: string;
  child_id: string;
  site_id: string;
  session_id: string;
  sibling_group_id?: string; // 兄弟姐妹同组
  seat_label?: string;
  status: EnrollmentStatus;
  /** 取消时：该儿童当日是否无人照看，决定等待队列优先递补。 */
  needs_replacement_seat?: boolean;
}

export interface GuardianshipPayload {
  grant_id: string;
  child_id: string;
  guardian_user_id: string;
  /** 授权范围：接送、医疗紧急处置、外出同意、家访同意等。 */
  scopes: Array<"pickup" | "medical_emergency" | "outing_consent" | "home_visit_consent">;
  valid_from: string;
  valid_until?: string;
  revoked?: boolean;
}

export interface PickupParty {
  party_id: string;
  relation: string;
  /** 核验要素的受控引用（证件/人脸模板不入事件流）。 */
  verification_ref: string;
  valid_from?: string;
  valid_until?: string;
}

export interface PickupPayload {
  child_id: string;
  site_id: string;
  session_id: string;
  /** 常规授权接送人；临时接送只在指定日期生效。 */
  permanent_parties: PickupParty[];
  temporary_party?: PickupParty & { valid_on: string };
  confirmation_code?: string; // 监护人确认后生成的一次性接人码
  confirmed_by_guardian_id?: string;
  confirmed_at?: string;
  decision?: "confirmed" | "rejected";
  reject_reason?: string;
  /** 追溯：本次变更基于哪条授权/申请。 */
  source_grant_id: string;
}

export interface SitePayload {
  site_id: string;
  name: string;
  kind: SiteKind;
  capacity: number;
  /** 为优先保障儿童预留的席位数。 */
  reserved_seats: number;
  active: boolean;
}

export interface SessionRiskRequirement {
  task: TaskKind;
  required_credential?: CredentialCode;
  min_staff: number;
}

export interface SessionPayload {
  session_id: string;
  site_id: string;
  date: string; // YYYY-MM-DD
  start_time: string;
  end_time: string;
  capacity: number;
  /** 课程风险评级与对应资质要求，决定谁能被排进该班。 */
  risk_level: "low" | "medium" | "high";
  risk_notes_classification?: DataClassification;
  requirements: SessionRiskRequirement[];
  outing_id?: string;
  status: "planned" | "risk_reviewed" | "open" | "cancelled";
  /** 取消时需要优先安置的儿童（无人照看者在前）。 */
  cancelled_seat_policy?: {
    prioritize_enrollment_ids: string[];
    alternate_session_ids: string[];
  };
}

export interface StaffPayload {
  staff_id: string;
  name: string;
  role: ActorRole;
  site_ids: string[];
  credentials: Array<{
    code: CredentialCode;
    verified: boolean;
    expires_on?: string; // 急救证等到期日
  }>;
  background_check_passed: boolean;
  active: boolean;
}

export interface AssignmentPayload {
  assignment_id: string;
  session_id: string;
  site_id: string;
  staff_id: string;
  task: TaskKind;
  state: AssignmentState;
  /** 拦截/释放原因：missing_credential | credential_expired | absent | replaced。 */
  reason?: string;
  missing_credential?: CredentialCode;
  /** 释放后由谁认领（可追踪）。 */
  reclaimed_by_assignment_id?: string;
  blocked_task_only?: boolean; // 始终只释放受影响任务，不清空该人员全天排班
}

export interface AttendancePayload {
  attendance_id: string;
  enrollment_id: string;
  child_id: string;
  session_id: string;
  site_id: string;
  kind: AttendanceKind;
  recorded_at: string;
  recorded_by: string;
  method: "online" | "offline_backfill";
  /** 断网补签：离线发生时间与补签对账事件。 */
  offline_occurred_at?: string;
  reconciled_event_id?: string;
  duplicate_of_event_id?: string; // 被判定重复、不计时长的签到
}

export interface OutingPayload {
  outing_id: string;
  session_id: string;
  site_id: string;
  destination: string;
  depart_at: string;
  expected_return_at: string;
  actual_return_at?: string;
  participant_child_ids: string[];
  leader_staff_id: string; // 须 outing_lead 资质
  first_aid_staff_id: string; // 须急救证
  consent_grant_ids: string[]; // 每名儿童须有外出同意授权
  status: OutingStatus;
  approved_by?: string;
  headcounts?: Array<{ point: string; at: string; count: number }>;
}

export interface HomeVisitPayload {
  visit_id: string;
  child_id: string;
  family_id: string;
  site_id: string;
  scheduled_at: string;
  completed_at?: string;
  /** 双人同行：主责社工 + 同行人员。 */
  lead_social_worker_id: string;
  companion_staff_id: string;
  guardian_consent_grant_id: string;
  status: HomeVisitStatus;
  finding_ref?: string; // restricted/密封的家访记录受控引用
}

export interface SafeguardingCasePayload {
  case_id: string;
  child_id: string;
  site_id: string;
  severity: CaseSeverity;
  status: CaseStatus;
  /** 线索来源（志愿者/教师/家长/系统），首报人可见于案件流。 */
  reported_by: string;
  assigned_social_worker_id?: string;
  guardian_user_id?: string;
  /** 运营只见 status / severity，不见 content_ref 指向的内容。 */
  content_ref?: string; // sealed：保全记录受控引用
  retention_locked?: boolean;
  resolution_note_ref?: string;
  /** 去标识连续性指标回链（不含身份）。 */
  continuity_cohort_id?: string;
}

export interface DeidentifiedDatasetPayload {
  dataset_id: string;
  period: string;
  /** 仅含稳定化名 ID 与服务连续性指标，不含姓名、证件、联系方式、点位明细到个人。 */
  pseudonymous_child_id: string;
  priority_tier: number;
  sessions_attended: number;
  consecutive_weeks_served: number;
  had_gap: boolean;
  gap_reason_category?: string;
  safeguarding_followed_up: boolean;
}

// ---------------------------------------------------------------------------
// 事件目录：事件类型 ↔ 聚合 ↔ payload ↔ 默认数据分级
// ---------------------------------------------------------------------------

export interface EventTypeDefinition<
  TType extends string,
  TAggregate extends AggregateType,
  TPayload,
> {
  type: TType;
  aggregate_type: TAggregate;
  payload: TPayload;
  classification: DataClassification;
}

export type EventTypeCatalog =
  // 家庭申请与资格
  | EventTypeDefinition<"APPLICATION_SUBMITTED", "family_application", ApplicationPayload, "restricted">
  | EventTypeDefinition<"ELIGIBILITY_REVIEWED", "family_application", EligibilityReviewPayload, "restricted">
  | EventTypeDefinition<"APPLICATION_APPROVED", "family_application", ApplicationPayload, "operational">
  | EventTypeDefinition<"APPLICATION_WAITLISTED", "family_application", ApplicationPayload, "operational">
  // 入点 / 取消 / 递补
  | EventTypeDefinition<"ENROLLMENT_CONFIRMED", "child_enrollment", EnrollmentPayload, "operational">
  | EventTypeDefinition<"ENROLLMENT_CANCELLED", "child_enrollment", EnrollmentPayload, "operational">
  | EventTypeDefinition<"WAITLIST_PROMOTED", "child_enrollment", EnrollmentPayload, "operational">
  | EventTypeDefinition<"SEAT_PRIORITY_APPLIED", "child_enrollment", EnrollmentPayload, "operational">
  // 监护授权与接送
  | EventTypeDefinition<"GUARDIANSHIP_AUTHORIZED", "guardianship_grant", GuardianshipPayload, "restricted">
  | EventTypeDefinition<"PICKUP_AUTHORIZED", "guardianship_grant", PickupPayload, "restricted">
  | EventTypeDefinition<"PICKUP_CHANGED", "guardianship_grant", PickupPayload, "restricted">
  | EventTypeDefinition<"PICKUP_CONFIRMED", "guardianship_grant", PickupPayload, "operational">
  | EventTypeDefinition<"PICKUP_REJECTED", "guardianship_grant", PickupPayload, "operational">
  // 点位与容量
  | EventTypeDefinition<"SITE_REGISTERED", "site", SitePayload, "operational">
  | EventTypeDefinition<"SITE_CAPACITY_CHANGED", "site", SitePayload, "operational">
  // 班次 / 风险 / 取消 / 跨点调班
  | EventTypeDefinition<"SESSION_PLANNED", "site_session", SessionPayload, "operational">
  | EventTypeDefinition<"SESSION_RISK_REVIEWED", "site_session", SessionPayload, "operational">
  | EventTypeDefinition<"SESSION_CANCELLED", "site_session", SessionPayload, "operational">
  | EventTypeDefinition<"REASSIGNMENT_OFFERED", "site_session", SessionPayload, "operational">
  | EventTypeDefinition<"SESSION_REASSIGNED", "site_session", SessionPayload, "operational">
  // 人员与资质
  | EventTypeDefinition<"STAFF_REGISTERED", "staff_member", StaffPayload, "operational">
  | EventTypeDefinition<"STAFF_CLEARED", "staff_member", StaffPayload, "operational">
  | EventTypeDefinition<"CREDENTIAL_EXPIRING", "staff_member", StaffPayload, "operational">
  | EventTypeDefinition<"CREDENTIAL_EXPIRED", "staff_member", StaffPayload, "operational">
  // 排班
  | EventTypeDefinition<"ASSIGNMENT_SCHEDULED", "staff_assignment", AssignmentPayload, "operational">
  | EventTypeDefinition<"ASSIGNMENT_TASK_BLOCKED", "staff_assignment", AssignmentPayload, "operational">
  | EventTypeDefinition<"STAFF_ABSENT", "staff_assignment", AssignmentPayload, "operational">
  | EventTypeDefinition<"ASSIGNMENT_TASK_RELEASED", "staff_assignment", AssignmentPayload, "operational">
  | EventTypeDefinition<"ASSIGNMENT_TASK_RECLAIMED", "staff_assignment", AssignmentPayload, "operational">
  // 签到
  | EventTypeDefinition<"CHECKIN_RECORDED", "attendance_record", AttendancePayload, "operational">
  | EventTypeDefinition<"CHECKOUT_RECORDED", "attendance_record", AttendancePayload, "operational">
  | EventTypeDefinition<"OFFLINE_CHECKIN_QUEUED", "attendance_record", AttendancePayload, "operational">
  | EventTypeDefinition<"ATTENDANCE_RECONCILED", "attendance_record", AttendancePayload, "operational">
  // 外出
  | EventTypeDefinition<"OUTING_PLANNED", "activity_outing", OutingPayload, "operational">
  | EventTypeDefinition<"OUTING_APPROVED", "activity_outing", OutingPayload, "operational">
  | EventTypeDefinition<"OUTING_DEPARTED", "activity_outing", OutingPayload, "operational">
  | EventTypeDefinition<"OUTING_RETURNED", "activity_outing", OutingPayload, "operational">
  // 家访
  | EventTypeDefinition<"HOME_VISIT_SCHEDULED", "home_visit", HomeVisitPayload, "restricted">
  | EventTypeDefinition<"HOME_VISIT_CONFIRMED", "home_visit", HomeVisitPayload, "restricted">
  | EventTypeDefinition<"HOME_VISIT_COMPLETED", "home_visit", HomeVisitPayload, "restricted">
  // 安全线索与事件处置
  | EventTypeDefinition<"SAFEGUARDING_CONCERN_RAISED", "safeguarding_case", SafeguardingCasePayload, "restricted">
  | EventTypeDefinition<"CASE_ESCALATED", "safeguarding_case", SafeguardingCasePayload, "sealed">
  | EventTypeDefinition<"CASE_ASSIGNED", "safeguarding_case", SafeguardingCasePayload, "sealed">
  | EventTypeDefinition<"GUARDIAN_NOTIFIED", "safeguarding_case", SafeguardingCasePayload, "sealed">
  | EventTypeDefinition<"INCIDENT_RECORDED", "safeguarding_case", SafeguardingCasePayload, "sealed">
  | EventTypeDefinition<"RECORD_RETENTION_LOCKED", "safeguarding_case", SafeguardingCasePayload, "sealed">
  | EventTypeDefinition<"CASE_RESOLVED", "safeguarding_case", SafeguardingCasePayload, "sealed">
  // 去标识数据
  | EventTypeDefinition<"DEIDENTIFIED_DATASET_RELEASED", "analytics_dataset", DeidentifiedDatasetPayload, "operational">;

export type KnownEventType = EventTypeCatalog["type"];
