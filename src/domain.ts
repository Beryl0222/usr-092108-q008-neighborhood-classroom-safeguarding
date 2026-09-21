/** 邻里课堂安全协作使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
}

/** 人员角色：团干部 / 持证社工 / 高校志愿者。 */
export type StaffRole = "league_cadre" | "licensed_social_worker" | "volunteer";

/** 受控资质类型：心理团辅、急救、家访。 */
export type QualificationKind = "psych_group" | "first_aid" | "home_visit";

/** 任务类型；心理团辅、急救、外出带队、家访为受控任务。 */
export type TaskKind = "supervision" | "psych_group" | "first_aid" | "outing_lead" | "home_visit";

/** 优先保障标识：困境儿童、新就业群体家庭。 */
export type PriorityFlag = "children_in_difficulty" | "new_employment_family";

export type SiteType = "community" | "rural" | "enterprise" | "park";

/** 家庭申请中登记的儿童保障信息（敏感，分级可见）。 */
export interface ChildRecord {
  childId: string;
  familyId: string;
  name: string;
  siteId: string;
  priorityFlags: PriorityFlag[];
  /** 上课时段是否无人照看，取消课程时据此优先安置。 */
  needsCareDuringSession: boolean;
  safeguardingReason: string;
  sensitiveProfile: Record<string, unknown>;
}

export interface SiteRecord {
  siteId: string;
  name: string;
  type: SiteType;
  capacity: number;
  operatorIds: string[];
  enterpriseContactIds: string[];
  /** 接送变更确认人（团干部或持证社工）。 */
  coordinatorId: string | null;
}

export interface SessionRecord {
  sessionId: string;
  siteId: string;
  date: string;
  courseProviderId: string | null;
  riskLevel: "low" | "medium" | "high";
  capacity: number;
  status: "scheduled" | "cancelled";
}

export interface TaskRecord {
  taskId: string;
  sessionId: string;
  staffId: string;
  task: TaskKind;
  date: string;
  status: "assigned" | "released";
  releaseReason: "absent" | "qualification_expired" | "session_cancelled" | null;
}

/** 签到记录；creditedMinutes 为去重后实际累计的分钟数。 */
export interface CheckInRecord {
  staffId: string;
  sessionId: string;
  task: TaskKind;
  start: string;
  end: string;
  source: "online" | "offline_backfill";
}

export interface SafeguardingCaseRecord {
  caseId: string;
  childId: string;
  siteId: string;
  raisedBy: string;
  detail: string;
  status: "open" | "in_progress" | "closed";
  assigneeId: string;
  openedAt: string;
  closedAt: string | null;
}

/** 视图调用方。可见字段由 src/access.js 按角色裁剪。 */
export interface Principal {
  id: string;
  role:
    | "guardian"
    | "licensed_social_worker"
    | "league_cadre"
    | "volunteer"
    | "site_operator"
    | "enterprise_contact"
    | "course_provider"
    | "project_group";
}
