import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { snapshot } from '../graphql/server'
import type {
  AuditEntry, Defect, DefectStatus, OutboxOp, OutboxOpType, OpPayload,
  RectificationAction, RetestResult, SpeedReason, SyncConflict, TrackSegment
} from '../types'

const DEVICE_KEY = 'gsb66:device-id'
const deviceId = localStorage.getItem(DEVICE_KEY) ?? `设备-${Math.random().toString(16).slice(2, 6)}`
localStorage.setItem(DEVICE_KEY, deviceId)
export { deviceId }

const LOCAL_KEY = `gsb66:local:${deviceId}`
const OUTBOX_KEY = `gsb66:outbox:${deviceId}`
let opSeq = Number(localStorage.getItem(`gsb66:op-seq:${deviceId}`) ?? '0')
let auditSeq = 10

function nextOpId(): string {
  opSeq += 1
  localStorage.setItem(`gsb66:op-seq:${deviceId}`, String(opSeq))
  return `OP-${deviceId}-${opSeq}`
}

interface LocalDb {
  segments: TrackSegment[]
  defects: Defect[]
  audit: AuditEntry[]
}

/** 本机库首次使用时以服务端快照为基线，之后离线修改只留在本机，等待回传合并 */
function loadLocal(): LocalDb {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (raw) return JSON.parse(raw) as LocalDb
  } catch {
    /* 损坏则按服务端基线重建 */
  }
  const server = snapshot()
  return { segments: server.segments, defects: server.defects, audit: server.audit }
}

function loadOutbox(): OutboxOp[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY)
    return raw ? (JSON.parse(raw) as OutboxOp[]) : []
  } catch {
    return []
  }
}

const PENDING: OutboxOp['status'][] = ['待回传', '同步中', '待重试', '冲突']

export const useTrackStore = defineStore('track', () => {
  const initial = loadLocal()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const outbox = ref<OutboxOp[]>(loadOutbox())
  const lastSyncAt = ref<string>('')
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))
  const pendingOps = computed(() => outbox.value.filter((op) => PENDING.includes(op.status)))
  const conflicts = computed(() => outbox.value.filter((op) => op.status === '冲突'))

  function addAudit(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `A-${Date.now()}-${auditSeq++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  /** 入队：断网时操作留在本机，重启后仍在；记录时间为现场原始时间 */
  function enqueue(type: OutboxOpType, entityId: string, baseVersion: number, payload: OpPayload): OutboxOp {
    const op: OutboxOp = {
      id: nextOpId(), deviceId, type, entityId, baseVersion, payload,
      createdAt: new Date().toISOString(), status: '待回传', attempts: 0
    }
    outbox.value.push(op)
    persistOutbox()
    return op
  }

  function pendingOf(entityId: string): OutboxOp[] {
    return outbox.value
      .filter((op) => op.entityId === entityId && PENDING.includes(op.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // ---- 本机乐观应用（离线即时可见，回传确认后由服务端权威数据投影替换） ----

  function applyActionLocally(defect: Defect, action: RectificationAction, opId: string) {
    defect.actions.unshift({ ...action, opId })
    defect.status = '待复测'
    defect.version += 1
  }

  function applyRetestLocally(defect: Defect, retest: RetestResult, opId: string) {
    defect.retests.unshift({ ...retest, opId })
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    defect.version += 1
  }

  function applyCloseLocally(defect: Defect) {
    defect.status = '已关闭'
    defect.version += 1
  }

  function applyAssignLocally(defect: Defect, owner: string) {
    defect.owner = owner
    defect.status = '整治中'
    defect.version += 1
  }

  /**
   * 一级缺陷数量变化后重算区段临时限速（本机侧）。
   * 回传确认后以服务端重算结果为准，原因全程留痕。
   */
  function recalcLocal(segmentId: string, cause: string, opId: string, confirmed: boolean): SpeedReason | undefined {
    const segment = segments.value.find((item) => item.id === segmentId)
    if (!segment) return undefined
    const open = defects.value.filter((item) => item.segmentId === segmentId && item.severity === '一级' && !['已关闭', '待复核'].includes(item.status))
    const at = new Date().toISOString()
    if (open.length > 0) {
      const target = Math.min(segment.temporarySpeedLimit ?? segment.speedLimit - 20, segment.speedLimit - 20)
      segment.temporarySpeedLimit = target
      segment.version += 1
      const reason: SpeedReason = { value: target, reason: `${cause}：仍有${open.length}项未关闭一级缺陷（${open.map((item) => item.id).join('、')}），临时限速重算为 ${target} km/h${confirmed ? '' : '（离线预计算，待回传确认）'}`, at, opId }
      segment.lastSpeedReason = reason
      addAudit(segmentId, confirmed ? '临时限速重算' : '离线·临时限速预重算', '系统', reason.reason)
      return reason
    }
    const reason: SpeedReason = { value: undefined, reason: `${cause}：一级缺陷已全部关闭，临时限速解除，恢复正式限速 ${segment.speedLimit} km/h${confirmed ? '' : '（离线预计算，待回传确认）'}`, at, opId }
    segment.temporarySpeedLimit = undefined
    segment.version += 1
    segment.lastSpeedReason = reason
    addAudit(segmentId, confirmed ? '临时限速解除' : '离线·临时限速预解除', '系统', reason.reason)
    return reason
  }

  // ---- 业务操作：先入本机发件箱，再做本机乐观应用 ----

  function assign(defectIds: string[], owner: string) {
    for (const id of defectIds) {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) continue
      const op = enqueue('assign', id, defect.version, { owner, operator: '当前用户' })
      applyAssignLocally(defect, owner)
      addAudit(id, '批量派工（待回传）', '当前用户', `任务分配至${owner}，离线操作 ${op.id}`)
    }
    void triggerSync()
  }

  function addAction(id: string, action: RectificationAction) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    const op = enqueue('rectification', id, defect.version, { action, operator: action.operator })
    applyActionLocally(defect, action, op.id)
    addAudit(id, '提交整治记录（待回传）', action.operator, `${action.method}：${action.note}，离线操作 ${op.id}`)
    void triggerSync()
  }

  function addRetest(id: string, retest: RetestResult) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    const op = enqueue('retest', id, defect.version, { retest, operator: retest.tester })
    applyRetestLocally(defect, retest, op.id)
    addAudit(id, '提交复测（待回传）', retest.tester, `${retest.passed ? '复测通过缺陷关闭' : `第${retest.round}轮未通过`}，离线操作 ${op.id}`)
    if (retest.passed) recalcLocal(defect.segmentId, `缺陷 ${id} 复测合格关闭，一级缺陷数量变化`, op.id, false)
    void triggerSync()
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭') {
      if (!defect.retests.some((item) => item.passed)) return { ok: false, message: '没有合格复测记录，不能关闭' }
      const op = enqueue('close', id, defect.version, { operator: '当前用户' })
      applyCloseLocally(defect)
      addAudit(id, '关闭缺陷（待回传）', '当前用户', `离线操作 ${op.id}`)
      recalcLocal(defect.segmentId, `缺陷 ${id} 关闭，一级缺陷数量变化`, op.id, false)
      void triggerSync()
      return { ok: true, message: `已流转至${next}（待回传）` }
    }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    defect.status = next
    defect.version += 1
    addAudit(id, `状态流转：${next}`, '当前用户', `流转至${next}`)
    return { ok: true, message: `已流转至${next}` }
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined, reason: string) {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return { ok: false, message: '区段不存在' }
    const conflict = defects.value.some((item) => item.segmentId === id && !['已关闭', '待复核'].includes(item.status) && item.severity === '一级')
    if (conflict && (temporary === undefined || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
    const op = enqueue('speed', id, segment.version, { speed, temporary: temporary ?? null, reason, operator: '工务调度' })
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    const speedReason: SpeedReason = { value: temporary, reason: `${reason}（待回传）`, at: new Date().toISOString(), opId: op.id }
    segment.lastSpeedReason = speedReason
    addAudit(id, '更新区段速度版本（待回传）', '工务调度', `${reason}；正式限速${speed} km/h，临时限速${temporary ?? '解除'}，离线操作 ${op.id}`)
    void triggerSync()
    return { ok: true, message: '区段速度版本已保存到本机，等待回传' }
  }

  // ---- 回传合并 ----

  /** 用服务端权威数据做投影：有未回传操作的实体保留本机现场数据，其余整体替换 */
  function ingestServer(server: LocalDb) {
    const protectedEntities = new Set(pendingOps.value.map((op) => op.entityId))
    for (const serverDefect of server.defects) {
      const index = defects.value.findIndex((item) => item.id === serverDefect.id)
      if (protectedEntities.has(serverDefect.id)) continue
      if (index >= 0) defects.value.splice(index, 1, JSON.parse(JSON.stringify(serverDefect)))
      else defects.value.push(JSON.parse(JSON.stringify(serverDefect)))
    }
    for (const serverSegment of server.segments) {
      const index = segments.value.findIndex((item) => item.id === serverSegment.id)
      if (protectedEntities.has(serverSegment.id)) continue
      if (index >= 0) segments.value.splice(index, 1, JSON.parse(JSON.stringify(serverSegment)))
      else segments.value.push(JSON.parse(JSON.stringify(serverSegment)))
    }
    // 审计按ID合并，服务端（AS-）与本机（A-）记录都保留
    const merged = new Map<string, AuditEntry>()
    for (const entry of [...server.audit, ...audit.value]) merged.set(entry.id, entry)
    audit.value = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    lastSyncAt.value = new Date().toISOString()
  }

  function markConflict(op: OutboxOp, info: { reason: string; serverVersion: number; serverStatus?: DefectStatus; serverSpeed?: number; serverTemp?: number }) {
    const conflict: SyncConflict = { opId: op.id, reason: info.reason, localVersion: op.baseVersion, serverVersion: info.serverVersion, serverStatus: info.serverStatus, serverSpeed: info.serverSpeed, serverTemp: info.serverTemp, at: new Date().toISOString() }
    const defect = defects.value.find((item) => item.id === op.entityId)
    if (defect) {
      defect.conflict = conflict
      defect.status = '待复核'
    }
    const segment = segments.value.find((item) => item.id === op.entityId)
    if (segment) segment.conflict = conflict
    const opRef = outbox.value.find((item) => item.id === op.id)
    if (opRef) { opRef.status = '冲突'; opRef.conflictReason = info.reason }
    persistOutbox()
    addAudit(op.entityId, '回传冲突·转待复核', op.deviceId, `${info.reason}；操作 ${op.id}（${typeLabel(op.type)}）挂起，等待人工裁决`)
  }

  function markRejected(op: OutboxOp, reason: string) {
    const opRef = outbox.value.find((item) => item.id === op.id)
    if (opRef) { opRef.status = '已拒绝'; opRef.conflictReason = reason }
    persistOutbox()
    addAudit(op.entityId, '回传被拒', op.deviceId, `操作 ${op.id}（${typeLabel(op.type)}）被服务端拒绝：${reason}`)
  }

  function markApplied(op: OutboxOp) {
    const opRef = outbox.value.find((item) => item.id === op.id)
    if (opRef) { opRef.status = '已入库'; opRef.lastError = undefined; opRef.attempts += 1 }
    persistOutbox()
  }

  function markRetrying(op: OutboxOp, error: string) {
    const opRef = outbox.value.find((item) => item.id === op.id)
    if (opRef) { opRef.status = '待重试'; opRef.attempts += 1; opRef.lastError = error }
    persistOutbox()
  }

  /**
   * 冲突复核后，以服务端当前版本为基线，把该实体仍待回传的操作链整体重放：
   * - adopt：放弃冲突操作，重放后续现场操作；
   * - keep：冲突操作也保留，按新版本重传（不覆盖对端班组的追加记录）。
   */
  function resolveConflict(opId: string, decision: 'adopt' | 'keep', server: LocalDb) {
    const conflictOp = outbox.value.find((item) => item.id === opId)
    if (!conflictOp) return
    const entityId = conflictOp.entityId

    if (decision === 'adopt') {
      conflictOp.status = '已拒绝'
      conflictOp.conflictReason = '复核后采用服务端版本，本机记录放弃'
      addAudit(entityId, '冲突复核·采用服务端', '调度复核', `放弃操作 ${opId}（${typeLabel(conflictOp.type)}）`)
    } else {
      conflictOp.status = '待回传'
      conflictOp.conflictReason = undefined
      conflictOp.rebaseOf = opId
      conflictOp.attempts = 0
      addAudit(entityId, '冲突复核·保留现场记录', '调度复核', `操作 ${opId}（${typeLabel(conflictOp.type)}）按服务端 V${conflictOp.baseVersion} 之后的新版本重传，双方记录并存`)
    }

    // 清除冲突标记并以服务端数据重建该实体，再顺序重放未决操作
    const queued = outbox.value
      .filter((op) => op.entityId === entityId && ['待回传', '待重试'].includes(op.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    const serverDefect = server.defects.find((item) => item.id === entityId)
    if (serverDefect) {
      const base: Defect = JSON.parse(JSON.stringify(serverDefect))
      base.conflict = undefined
      if (base.status === '待复核') base.status = '整治中'
      for (const op of queued) {
        if (op.payload.action) applyActionLocally(base, op.payload.action, op.id)
        if (op.payload.retest) applyRetestLocally(base, op.payload.retest, op.id)
        if (op.type === 'close') applyCloseLocally(base)
        if (op.type === 'assign' && op.payload.owner) applyAssignLocally(base, op.payload.owner)
      }
      const index = defects.value.findIndex((item) => item.id === entityId)
      if (index >= 0) defects.value.splice(index, 1, base)
    }

    const serverSegment = server.segments.find((item) => item.id === entityId)
    if (serverSegment) {
      const base: TrackSegment = JSON.parse(JSON.stringify(serverSegment))
      base.conflict = undefined
      const index = segments.value.findIndex((item) => item.id === entityId)
      if (index >= 0) segments.value.splice(index, 1, base)
    }

    // 重排操作链的基线版本，避免后续操作再次撞版本
    let expected = serverDefect?.version ?? serverSegment?.version ?? 0
    for (const op of queued) {
      op.baseVersion = expected
      expected += 1
    }
    persistOutbox()
  }

  function opStatusOf(entityId: string): OutboxOp | undefined {
    return pendingOf(entityId)[0]
  }

  function persistOutbox() {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.value))
  }

  function reset() {
    localStorage.removeItem(LOCAL_KEY)
    localStorage.removeItem(OUTBOX_KEY)
    location.reload()
  }

  watch([segments, defects, audit], () => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ segments: segments.value, defects: defects.value, audit: audit.value }))
  }, { deep: true })

  return {
    deviceId, segments, defects, audit, outbox, lastSyncAt, keyword, status, selectedSegmentId,
    filtered, selectedSegment, pendingOps, conflicts,
    assign, addAction, addRetest, transition, updateSegmentSpeed, recalcLocal,
    ingestServer, markConflict, markRejected, markApplied, markRetrying, resolveConflict,
    pendingOf, opStatusOf, addAudit, reset, persistOutbox
  }
})

function typeLabel(type: OutboxOpType): string {
  return { rectification: '整治记录', retest: '复测', close: '关闭缺陷', assign: '派工', speed: '区段限速' }[type]
}

/** 由 sync store 注入，避免 store 之间的模块循环依赖 */
let triggerSync: () => void = () => {}
export function registerSyncTrigger(fn: () => void) {
  triggerSync = fn
}
