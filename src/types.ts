export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'

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
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
}

export interface RetestResult {
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  testedAt: string
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
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

export type OfflineOpKind = '整治记录' | '复测' | '关闭缺陷' | '区段限速'
export type OfflineOpStatus = '待回传' | '已回传' | '冲突待复核' | '回传失败' | '已作废'

export interface OfflineOperation {
  id: string
  kind: OfflineOpKind
  segmentId: string
  defectId?: string
  crew: string
  operator: string
  summary: string
  baseDefectVersion?: number
  baseSegmentVersion: number
  action?: RectificationAction
  retest?: RetestResult
  speedLimit?: number
  temporarySpeedLimit?: number
  status: OfflineOpStatus
  attempts: number
  lastError?: string
  createdAt: string
  syncedAt?: string
}

export interface SyncConflict {
  id: string
  opId: string
  segmentId: string
  defectId?: string
  reason: string
  queuedSummary: string
  currentSummary: string
  status: '待复核' | '已复核'
  resolution?: '采用回传记录' | '保留现有记录'
  createdAt: string
  resolvedAt?: string
}

export interface SpeedRecalcRecord {
  id: string
  segmentId: string
  openLevelOne: number
  previousTemporary?: number
  nextTemporary?: number
  reason: string
  createdAt: string
}
