export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭' | '待复核'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'

export type OutboxOpType = 'rectification' | 'retest' | 'close' | 'assign' | 'speed'
export type OutboxOpStatus = '待回传' | '同步中' | '已入库' | '冲突' | '待重试' | '已拒绝'

export interface GeometryMeasurement {
  id: string
  mileage: number
  gauge: number
  level: number
  alignment: number
  twist: number
  measuredAt: string
  detector: string
}

export interface TrackSegment {
  id: string
  line: string
  startMileage: number
  endMileage: number
  speedLimit: number
  temporarySpeedLimit?: number
  version: number
  measurements: GeometryMeasurement[]
  /** 最近一次临时限速（含解除）重算或设置的原因 */
  lastSpeedReason?: SpeedReason
  /** 回传合并冲突时挂起，人工复核解决前本机不覆盖任何一方 */
  conflict?: SyncConflict
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
  /** 产生该记录的离线操作ID，用于审计与回传状态关联 */
  opId?: string
}

export interface RetestResult {
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  testedAt: string
  opId?: string
}

export interface Defect {
  id: string
  segmentId: string
  mileage: number
  type: DefectType
  severity: Severity
  measuredValue: number
  limit: number
  status: DefectStatus
  owner: string
  discoveredAt: string
  dueDate: string
  actions: RectificationAction[]
  retests: RetestResult[]
  version: number
  /** 回传冲突挂起标记，解决后清除 */
  conflict?: SyncConflict
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

/** 离线操作携带的业务负载 */
export interface OpPayload {
  action?: RectificationAction
  retest?: RetestResult
  operator?: string
  owner?: string
  speed?: number
  /** null 表示显式解除临时限速 */
  temporary?: number | null
  reason?: string
}

/** 断网期间留在本机、恢复后回传的操作 */
export interface OutboxOp {
  id: string
  deviceId: string
  type: OutboxOpType
  /** 缺陷ID或区段ID */
  entityId: string
  /** 操作所基于的缺陷版本/区段版本，服务端按此合并 */
  baseVersion: number
  payload: OpPayload
  /** 现场原始记录时间，回传后保留 */
  createdAt: string
  status: OutboxOpStatus
  attempts: number
  lastError?: string
  conflictReason?: string
  /** 冲突复核后保留本机记录重传时，指向原冲突操作 */
  rebaseOf?: string
}

export interface SyncConflict {
  opId: string
  reason: string
  localVersion: number
  serverVersion: number
  serverStatus?: DefectStatus
  serverSpeed?: number
  serverTemp?: number
  at: string
}

export interface SpeedReason {
  /** 重算后的临时限速，undefined 表示解除 */
  value?: number
  reason: string
  at: string
  opId: string
}
