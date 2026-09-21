# 工作流衔接

按时序描述十一个环节如何由不同角色接力。每个转移都标注前置条件与失败路径；事件样例见 `data/event-samples.json`。

## 1. 家庭申请与资格审核

```
监护人 APPLICATION_SUBMITTED
  └─▶ 持证社工 ELIGIBILITY_REVIEWED（核实困境儿童/新就业群体等，定 priority_tier）
        ├─ 符合且有名额 ─▶ APPLICATION_APPROVED ─▶ ENROLLMENT_CONFIRMED
        ├─ 符合但满员   ─▶ APPLICATION_WAITLISTED（按 tier 排队，预留席不计入可占用普通席）
        └─ 需补充材料   ─▶ 退回补充（不产生通过事件，原申请保留）
```

- 兄弟姐妹在申请中互填 `sibling_ids`，入点时生成同一 `sibling_group_id`，同批确认。
- 保障原因详情只写受控库；运营处理入点时只见运营字段。

## 2. 监护授权与接送关系

```
GUARDIANSHIP_AUTHORIZED（scopes + 有效期）
  └─▶ PICKUP_AUTHORIZED（常规接送人）
        └─▶ 临时变更：PICKUP_CHANGED（单日 valid_on）
              ├─ 监护人在线确认 ─▶ PICKUP_CONFIRMED（发一次性接人码）─▶ 当日签退核验放行
              ├─ 无法联系监护人 ─▶ 不放行；来人坚持 ─▶ PICKUP_REJECTED 留痕，必要时转安全线索
              └─ 授权过期/撤销   ─▶ 等同未授权
```

家长侧"今天找谁确认临时接人"的答案固定：始终由**监护人本人在应用内确认**，点位负责人只执行核验，不代确认。

## 3. 点位容量与班次风险

- 团干部排班前先 `SESSION_PLANNED`，社工与团干部 `SESSION_RISK_REVIEWED`：逐任务写明资质门槛与最少人数。
- 容量 = 普通席 + `reserved_seats`；只有 tier=1 儿童可占预留席。
- 高风险课程（涉水、外出、心理团辅等）未过风险复核不得开放报名。

## 4. 排班、资质与签到

```
排班请求 ──资质齐备且在有效期、背景核查通过──▶ ASSIGNMENT_SCHEDULED
         ──缺资质/已过期──▶ ASSIGNMENT_TASK_BLOCKED（不落班，提示改派）

当日：
  人员请假 ─▶ STAFF_ABSENT ─▶ ASSIGNMENT_TASK_RELEASED（仅该任务挂空）
                                 └─▶ 有资质者跨点/本点认领 ─▶ ASSIGNMENT_TASK_RECLAIMED（回填来源 assignment）
  资质当日到期 ─▶ CREDENTIAL_EXPIRED ─▶ 同上，仅释放对应任务

签到：
  在线 ─▶ CHECKIN_RECORDED
  断网 ─▶ OFFLINE_CHECKIN_QUEUED（记实际时间）─▶ 恢复后 ATTENDANCE_RECONCILED
          · 以 offline_occurred_at 计时
          · 同人同段重复提交挂 duplicate_of_event_id，不累计时长
  离场 ─▶ CHECKOUT_RECORDED（临时接送须核验接人码，见流程 2）
```

班次在**每个任务的 min_staff 均满足**前不开放入场；急救岗位挂空期间，涉及外出或高风险环节暂停。

## 5. 外出活动

```
OUTING_PLANNED
  前置：逐人 outing_consent 授权齐全；带队人资格 + 急救员证有效；交通与目的地风险已评估
  └─▶ OUTING_APPROVED（团干部）
        └─▶ OUTING_DEPARTED（出发点名 = 名单人数）
              └─▶ 各节点点名（headcounts）
                    └─▶ OUTING_RETURNED（返回点名 = 出发人数；实际返回时间回填）
```

任一前置缺失：不批准、不出发；人数不符：就地停止转移并清点，必要时升级安全事件。未同意外出的儿童留在课堂正常排班照护。

## 6. 家访

```
HOME_VISIT_SCHEDULED（持证社工主责 + 双人同行）
  └─▶ 监护人 HOME_VISIT_CONFIRMED
        └─▶ HOME_VISIT_COMPLETED（finding_ref 受控归档）
```

监护人不同意则改期或改为点位约谈；志愿者不参与家访处置；连续失约或拒访本身可构成安全线索，转流程 7。

## 7. 安全线索升级与事件处置

```
任何人发现 ─▶ SAFEGUARDING_CONCERN_RAISED（restricted，志愿者/教师到此为止）
  └─▶ 社工研判 ─▶ CASE_ESCALATED（sealed，处置权转社工+监护人）
        └─▶ CASE_ASSIGNED ─▶ GUARDIAN_NOTIFIED
              └─▶ INCIDENT_RECORDED ─▶ RECORD_RETENTION_LOCKED
                    └─▶ 持续跟进 ─▶ CASE_RESOLVED（记录继续密封留存）
```

- 升级后向运营只同步**状态与级别**（如"已升级、处置中、是否需点位配合"），不同步内容。
- 密封记录不可删除或改写；补正以新事件追加。
- 点位与企业得到的通知仅为配合动作（如关注某儿童情绪、配合接送核验），不含案情。

## 8. 取消课程与跨点调班

```
企业征用/极端天气等 ─▶ SESSION_CANCELLED（附 cancelled_seat_policy）
  安置顺序：
  1. needs_replacement_seat=true（无人照看）且 tier 最小者；
  2. 其余 tier=1；
  3. 其他在册儿童；
  4. 仍余名额才考虑等待队列。
  └─▶ REASSIGNMENT_OFFERED（监护人收到替代点位/班次）
        ├─ 监护人同意 + 接收点容量/资质齐备 ─▶ SESSION_REASSIGNED（兄弟姐妹整组移动）
        └─ 监护人拒绝 ─▶ 保留取消，记录原因（供连续性分析）
```

家庭主动取消（`ENROLLMENT_CANCELLED`）只释放自身席位；`needs_replacement_seat=false` 时不触发优先安置。

## 9. 读模型（由事件流归并得到，不新存敏感数据）

**家长端·今日看护卡**（回答"谁在看、出不出去、临时接送找谁"）：

- 当日点位与班次、当前在岗的**合格人员姓名与岗位**（从已满足资质的 assignment 归并）；
- 当日是否有外出：目的地、出发/预计返回时间、是否已同意；
- 接送：常规接送人、临时接送确认状态与一次性码、"变更须监护人本人确认"的入口；
- 看不到其他儿童与其他家庭任何信息。

**点位端·当日值守表**：任务-人员-资质状态、空岗与认领状态、签到在册数、外出名单与点名数。

**运营看板**：容量与预留占用、等待队列、排班缺口（按任务，不按原因）、签到/补签对账状态、外出审批状态、案件**状态/级别**计数；无保障原因、无案件内容、无家访记录。

**市项目组·连续性评估**：只消费 `DEIDENTIFIED_DATASET_RELEASED`：

- 重点家庭（化名）连续受服务周数、中断次数与原因类别（取消已调班 / 未调班 / 请假等）；
- 安全线索是否在规定时限内被跟进（只看布尔与时长，不看内容）；
- 跨点调班是否保持连续（同化名在新点位有接续出勤）；
- 据此识别"报名了但实际断档"的重点家庭，而不接触身份数据。

## 10. 断网与并发边界

- 离线期间所有写操作在本地只暂存**最小信封 + 实际发生时间**，恢复后统一对账；冲突时以实际发生时间为准，重复操作幂等丢弃。
- 同一席位的最后确认以事件日志顺序归并；超售时按优先级保留，被挤出者回到等待队列并通知，绝不无通知取消。
- 资质状态、授权有效期以**业务发生时刻**判定（如下单排班时急救证是否有效），事后到期不溯及已完成的任务。
