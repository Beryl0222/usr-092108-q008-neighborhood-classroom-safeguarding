# 领域模型

泉州 101 个暑期邻里课堂（社区、乡村、企业、园区四类点位）共用一套事件语义。
本文定义聚合、事件生命周期、数据分级与核心不变量；流程见 [workflows.md](./workflows.md)，角色与可见范围见 [roles-and-access.md](./roles-and-access.md)。

## 建模原则

1. **事件不可变**：事件被接收后，`event_id`、`occurred_at`、`version` 不原地改写；状态更正产生后继事件（version 递增，用 `related_events` 指向前序事件）。
2. **敏感内容不进事件流**：保障原因详情、证件/人脸核验材料、家访与案件内容只存受控保管库，事件里只放 `vault://` 引用（`support_reason_detail_ref`、`verification_ref`、`content_ref`、`finding_ref`）。
3. **每个动作带责任人**：`actor.role` 决定动作是否合法；访问 restricted 数据还要求 `actor.serving_child_ids` 包含该儿童（在册服务关系）。
4. **只释放任务，不清空排班**：人员缺席或资质到期只影响对应的那一条任务，其他排班保留。

## 聚合与事件

### family_application 家庭申请（敏感）

| 事件 | 触发者 | 说明 |
|---|---|---|
| `APPLICATION_SUBMITTED` | 监护人 | 含保障原因**代码**与详情引用；事件为 restricted |
| `ELIGIBILITY_REVIEWED` | 持证社工 | 给出 priority_tier（1 最高）；困境儿童、新就业群体且无替代照护优先 |
| `APPLICATION_APPROVED` / `APPLICATION_WAITLISTED` | 社工 / 运营 | 批准事件只含运营字段，不含原因详情 |

### child_enrollment 儿童入点

| 事件 | 说明 |
|---|---|
| `ENROLLMENT_CONFIRMED` | 占座成功，绑定班次与席位 |
| `SEAT_PRIORITY_APPLIED` | 优先保障席位被占用（预留席）；兄弟姐妹用 `sibling_group_id` 联动 |
| `WAITLIST_PROMOTED` | 席位释放后按优先级自动递补 |
| `ENROLLMENT_CANCELLED` | 取消时标注 `needs_replacement_seat`：当日无人照看的儿童才触发优先安置 |

### guardianship_grant 监护授权与接送关系（敏感）

- `GUARDIANSHIP_AUTHORIZED`：授权范围 `scopes` = 接送 / 应急医疗 / 外出同意 / 家访同意，含有效期，可撤销。
- `PICKUP_AUTHORIZED`：常规接送人名单。
- `PICKUP_CHANGED`：临时接送人，`temporary_party.valid_on` 限定单日有效。
- `PICKUP_CONFIRMED`：监护人确认后生成一次性接人码 `confirmation_code`，点位按码核验。
- `PICKUP_REJECTED`：无确认、无授权、过期均拒绝并留痕。

### site / site_session 点位、班次与风险

- `SITE_REGISTERED`、`SITE_CAPACITY_CHANGED`：容量含 `reserved_seats` 预留席。
- `SESSION_PLANNED` → `SESSION_RISK_REVIEWED`（社工+团干部复核）→ open。
- 班次风险用 `risk_level` 与 `requirements[]` 表达：每个任务（心理团辅/急救/陪护/家访/带队）写明所需资质与最少在岗人数，是排班硬约束。
- `SESSION_CANCELLED`：必须带 `cancelled_seat_policy`，先列无人照看儿童与可替代班次。
- `REASSIGNMENT_OFFERED` → `SESSION_REASSIGNED`：跨点调班须监护人确认、接收点容量与资质齐备。

### staff_member / staff_assignment 人员、资质与排班

- 人员角色：团干部、持证社工、点位负责人、高校志愿者、课程方。
- 资质：社工证、心理咨询、急救证（有到期日）、基础培训、背景核查。
- `CREDENTIAL_EXPIRING`（提前预警）→ `CREDENTIAL_EXPIRED`（系统自动，对应任务停止排入）。
- 排班状态机：

```
ASSIGNMENT_SCHEDULED ──缺资质──▶ ASSIGNMENT_TASK_BLOCKED（拦截，不落班）
        │
        ├──人员缺勤──▶ STAFF_ABSENT ──▶ ASSIGNMENT_TASK_RELEASED ──▶ ASSIGNMENT_TASK_RECLAIMED
        │                                   （仅该任务挂空）            （有资质者认领，回填来源）
        └──正常完成──▶ completed
```

- 资质到期与缺勤一样，只 `ASSIGNMENT_TASK_RELEASED` 对应任务（`blocked_task_only=true`）。
- **志愿者仅凭基础培训只能排 `general_care` 等无资质门槛任务**；心理团辅、急救值守、家访任务在排班入口即被拦截。

### attendance_record 签到与补签

- `CHECKIN_RECORDED` / `CHECKOUT_RECORDED`：正常在线签到签退。
- 断网：`OFFLINE_CHECKIN_QUEUED`（先记 `offline_occurred_at` 实际发生时间）→ 联网后 `ATTENDANCE_RECONCILED`。
- 对账规则：以**实际发生时间**计时长；重复提交挂 `duplicate_of_event_id`，**不重复累计**；任何更正都留新事件，不改原记录。

### activity_outing 外出活动

`OUTING_PLANNED` → `OUTING_APPROVED` → `OUTING_DEPARTED` → `OUTING_RETURNED`。

审批与执行的前置条件：

- 每名儿童 `consent_grant_ids` 中都有有效 `outing_consent` 授权；
- `leader_staff_id` 具备带队资格，`first_aid_staff_id` 持**有效**急救证；
- 出发、各节点、返回均有点名 `headcounts`，人数闭合才能闭环。

### home_visit 家访（敏感）

`HOME_VISIT_SCHEDULED` → `HOME_VISIT_CONFIRMED`（监护人确认）→ `HOME_VISIT_COMPLETED`。

- 主责必须是持证社工；`companion_staff_id` 双人同行；
- 须有 `home_visit_consent` 授权；记录写入 `finding_ref`，事件本身不含内容；
- 志愿者不能发起或单独执行家访。

### safeguarding_case 安全线索与事件处置

```
SAFEGUARDING_CONCERN_RAISED（任何角色可首报，restricted）
  └─▶ CASE_ESCALATED（社工研判后升级，sealed）
        └─▶ CASE_ASSIGNED（指派持证社工）
              └─▶ GUARDIAN_NOTIFIED（监护人接手）
                    └─▶ INCIDENT_RECORDED（经过与处置）
                          └─▶ RECORD_RETENTION_LOCKED（冻结保全）
                                └─▶ CASE_RESOLVED（结案，仍留存）
```

- 升级即密封：`sealed` 记录不可删改，按未成年人保护要求留存。
- 志愿者/教师只负责首报，不承担研判与处置。
- 运营侧只能看到案件**状态与级别**（见读模型），看不到 `content_ref` 内容。

### analytics_dataset 去标识数据

`DEIDENTIFIED_DATASET_RELEASED`：只含稳定化名 ID、优先层级、出勤周数、服务是否中断及中断原因类别、案件是否跟进；**不含**姓名、证件、联系方式，也不到"某点位+某儿童"的可识别粒度。市级项目组据此判断重点家庭是否获得连续服务。

## 核心不变量

1. **资质硬匹配**：班排入库时，任务所需资质必须全部 verified 且未过期；否则产生 `ASSIGNMENT_TASK_BLOCKED`，任务不落班。
2. **容量与预留**：`ENROLLMENT_CONFIRMED` 后占用计数不得超过 `capacity`；`reserved_seats` 只允许 priority_tier=1 的儿童使用。
3. **兄弟姐妹联动**：同一 `sibling_group_id` 的确认/调班同批成功或同批回退，不出现一人入点一人落空。
4. **接送三要素**：签退放人必须匹配"当日有效授权 + 接送人核验 + （临时接送时）监护人确认码"，缺一即拒绝并记录 `PICKUP_REJECTED`。
5. **取消先保无人照看**：`SESSION_CANCELLED` 后，递补与跨点安置严格按 `needs_replacement_seat`/优先级排序，有人照看的家庭不插队。
6. **最小任务释放**：缺勤/到期只释放对应 `staff_assignment`，不级联取消该人员其他任务，也不取消班次。
7. **补签一次性**：同一 enrollment + kind + 实际发生时段只允许一条计时记录，重复条目标记 `duplicate_of_event_id`。
8. **外出闭合**：无全员同意、无有效急救员，不能 `OUTING_APPROVED`；首尾点名人数不一致，不能 `OUTING_RETURNED`。
9. **升级即换手**：案件升级后处置主责转移给持证社工与监护人，首报人退出处置链；此后所有案件事件为 sealed。
10. **更正追加化**：任何状态修正都以新事件表达，消费者按 aggregate_id + version 顺序归并，永不原地更新。
