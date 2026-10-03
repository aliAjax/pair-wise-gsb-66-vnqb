import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedOfflineQueue, seedRecalcLog, seedSegments } from '../data/seed'
import type { AuditEntry, Defect, DefectStatus, OfflineOperation, RectificationAction, RetestResult, SpeedRecalcRecord, SyncConflict, TrackSegment } from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
const SYNC_STORAGE_KEY = 'gsb66:offline-sync'
let idSeed = 10

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : { segments: seedSegments, defects: seedDefects, audit: seedAudit }
  } catch {
    return { segments: seedSegments, defects: seedDefects, audit: seedAudit }
  }
}

function loadSync() {
  try {
    const raw = localStorage.getItem(SYNC_STORAGE_KEY)
    return raw ? JSON.parse(raw) : { queue: seedOfflineQueue, conflicts: [], recalcLog: seedRecalcLog }
  } catch {
    return { queue: seedOfflineQueue, conflicts: [], recalcLog: seedRecalcLog }
  }
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  const syncInitial = loadSync()
  const offlineQueue = ref<OfflineOperation[]>(syncInitial.queue)
  const conflicts = ref<SyncConflict[]>(syncInitial.conflicts)
  const speedRecalcLog = ref<SpeedRecalcRecord[]>(syncInitial.recalcLog)
  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)
  const syncing = ref(false)
  const simulateDrop = ref(false)
  const lastSyncMessage = ref('')

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))
  const pendingOps = computed(() => offlineQueue.value.filter((item) => item.status === '待回传' || item.status === '回传失败'))
  const openConflicts = computed(() => conflicts.value.filter((item) => item.status === '待复核'))
  const pendingDefectIds = computed(() => new Set(pendingOps.value.map((item) => item.defectId).filter(Boolean)))

  function assign(defectIds: string[], owner: string) {
    for (const id of defectIds) {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) continue
      defect.owner = owner
      defect.status = '整治中'
      defect.version += 1
      addAudit(id, '批量派工', '当前用户', `任务分配至${owner}`)
    }
  }

  function addAction(id: string, action: RectificationAction, crew = '工务一工区') {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (!online.value) {
      enqueue({ kind: '整治记录', segmentId: defect.segmentId, defectId: id, crew, operator: action.operator, summary: `${action.method}：${action.note}`, baseDefectVersion: defect.version, baseSegmentVersion: segmentVersion(defect.segmentId), action })
      addAudit(id, '离线暂存整治记录', action.operator, `${action.method}：${action.note}（断网暂存本机，待回传）`)
      return { ok: true, message: '当前离线，整治记录已暂存本机，网络恢复后回传' }
    }
    defect.actions.unshift(action)
    defect.status = '待复测'
    defect.version += 1
    addAudit(id, '提交整治记录', action.operator, `${action.method}：${action.note}`)
    return { ok: true, message: '整治记录已提交，缺陷转入待复测' }
  }

  function addRetest(id: string, retest: RetestResult, crew = '工务一工区') {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (!online.value) {
      enqueue({ kind: '复测', segmentId: defect.segmentId, defectId: id, crew, operator: retest.tester, summary: `复测${retest.measuredValue} / 限值${retest.limit}，第${retest.round}轮${retest.passed ? '通过' : '未通过'}`, baseDefectVersion: defect.version, baseSegmentVersion: segmentVersion(defect.segmentId), retest })
      addAudit(id, '离线暂存复测', retest.tester, `第${retest.round}轮复测${retest.passed ? '通过' : '未通过'}（断网暂存本机，待回传）`)
      return { ok: true, message: '当前离线，复测结果已暂存本机，网络恢复后回传' }
    }
    defect.retests.unshift(retest)
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    defect.version += 1
    addAudit(id, '提交复测', retest.tester, retest.passed ? '复测通过' : `第${retest.round}轮未通过`)
    if (retest.passed) recalcSegmentSpeed(defect.segmentId, `缺陷${id}复测通过关闭`)
    return { ok: true, message: retest.passed ? '复测通过，缺陷已关闭' : '复测不合格，任务重新进入整治' }
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (!online.value && next === '已关闭') {
      if (!defect.retests.some((item) => item.passed)) return { ok: false, message: '没有合格复测记录，不能关闭' }
      enqueue({ kind: '关闭缺陷', segmentId: defect.segmentId, defectId: id, crew: defect.owner, operator: '当前用户', summary: `申请关闭缺陷（当前${defect.status}）`, baseDefectVersion: defect.version, baseSegmentVersion: segmentVersion(defect.segmentId) })
      addAudit(id, '离线暂存关闭申请', '当前用户', '断网暂存本机，待回传')
      return { ok: true, message: '当前离线，关闭申请已暂存本机，网络恢复后回传' }
    }
    if (!online.value) return { ok: false, message: '离线状态仅支持关闭申请暂存' }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    const from = defect.status
    defect.status = next
    defect.version += 1
    addAudit(id, `状态流转：${next}`, '当前用户', `由${from}流转至${next}`)
    if (next === '已关闭') recalcSegmentSpeed(defect.segmentId, `缺陷${id}关闭`)
    return { ok: true, message: `已流转至${next}` }
  }

  function addAudit(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `A-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return { ok: false, message: '区段不存在' }
    if (!online.value) {
      enqueue({ kind: '区段限速', segmentId: id, crew: '工务调度', operator: '工务调度', summary: `正式限速${speed} km/h，临时限速${temporary ?? '无'}`, baseSegmentVersion: segment.version, speedLimit: speed, temporarySpeedLimit: temporary })
      addAudit(id, '离线暂存限速调整', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'}（断网暂存本机，待回传）`)
      return { ok: true, message: '当前离线，限速调整已暂存本机，网络恢复后回传' }
    }
    const conflict = defects.value.some((item) => item.segmentId === id && item.status !== '已关闭' && item.severity === '一级')
    if (conflict && (!temporary || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
    const previous = segment.temporarySpeedLimit
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    addAudit(id, '更新区段速度版本', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'}`)
    logSpeedRecalc(id, `调度手工调整：正式限速${speed} km/h，临时限速${temporary ?? '无'}`, previous, temporary)
    return { ok: true, message: '区段速度版本已更新' }
  }

  // 缺陷关闭后一级缺陷数量变化，按当前未关闭一级缺陷重算临时限速并留原因
  function recalcSegmentSpeed(segmentId: string, trigger: string) {
    const segment = segments.value.find((item) => item.id === segmentId)
    if (!segment) return
    const openLevelOne = defects.value.filter((item) => item.segmentId === segmentId && item.severity === '一级' && item.status !== '已关闭').length
    const previous = segment.temporarySpeedLimit
    let next: number | undefined
    let reason: string
    if (openLevelOne > 0) {
      next = previous !== undefined && previous < segment.speedLimit ? previous : Math.max(45, segment.speedLimit - 40)
      reason = `${trigger}；仍有${openLevelOne}项一级缺陷未关闭，${previous === next ? '维持' : '设置'}临时限速${next} km/h`
    } else {
      next = undefined
      reason = `${trigger}；一级缺陷已全部关闭，${previous === undefined ? '无需临时限速' : '取消临时限速，恢复正式限速'}`
    }
    if (next !== previous) {
      segment.temporarySpeedLimit = next
      segment.version += 1
    }
    logSpeedRecalc(segmentId, reason, previous, next, openLevelOne)
  }

  function logSpeedRecalc(segmentId: string, reason: string, previous: number | undefined, next: number | undefined, openLevelOne?: number) {
    const count = openLevelOne ?? defects.value.filter((item) => item.segmentId === segmentId && item.severity === '一级' && item.status !== '已关闭').length
    speedRecalcLog.value.unshift({ id: `SR-${Date.now()}-${idSeed++}`, segmentId, openLevelOne: count, previousTemporary: previous, nextTemporary: next, reason, createdAt: new Date().toISOString() })
    addAudit(segmentId, '重算临时限速', '系统', reason)
  }

  function segmentVersion(segmentId: string) {
    return segments.value.find((item) => item.id === segmentId)?.version ?? 0
  }

  function enqueue(op: Omit<OfflineOperation, 'id' | 'status' | 'attempts' | 'createdAt'>) {
    offlineQueue.value.push({ ...op, id: `OP-${Date.now()}-${idSeed++}`, status: '待回传', attempts: 0, createdAt: new Date().toISOString() })
  }

  // 网络恢复后逐条回传：按缺陷版本/区段版本合并，版本不一致转待复核，不覆盖已有记录；
  // 中断时已入库部分保留，剩余条目留在队列中等待重试。
  function syncNow() {
    if (!online.value) {
      lastSyncMessage.value = '当前离线，无法回传'
      return { ok: false, message: lastSyncMessage.value }
    }
    if (syncing.value) return { ok: false, message: '正在回传中' }
    syncing.value = true
    let committed = 0
    let conflicted = 0
    let dropped = false
    for (const op of offlineQueue.value) {
      if (op.status !== '待回传' && op.status !== '回传失败') continue
      op.attempts += 1
      const outcome = applyOp(op)
      if (outcome === 'applied') committed += 1
      else conflicted += 1
      if (simulateDrop.value && committed >= 1) {
        dropped = true
        break
      }
    }
    syncing.value = false
    const remaining = pendingOps.value.length
    if (dropped) lastSyncMessage.value = `回传中断（弱网模拟）：已入库${committed}条并保留，冲突待复核${conflicted}条，剩余${remaining}条可重试`
    else if (!committed && !conflicted) lastSyncMessage.value = '没有待回传记录'
    else lastSyncMessage.value = `回传完成：入库${committed}条，冲突待复核${conflicted}条${remaining ? `，剩余${remaining}条待重试` : ''}`
    return { ok: !dropped, message: lastSyncMessage.value }
  }

  function applyOp(op: OfflineOperation): 'applied' | 'conflict' {
    if (op.kind === '区段限速') {
      const segment = segments.value.find((item) => item.id === op.segmentId)
      if (!segment) return toConflict(op, '区段不存在，无法回传限速调整')
      if (segment.version !== op.baseSegmentVersion) return toConflict(op, `区段版本不一致：离线时基于V${op.baseSegmentVersion}，当前V${segment.version}`)
      const openLevelOne = defects.value.some((item) => item.segmentId === op.segmentId && item.severity === '一级' && item.status !== '已关闭')
      if (openLevelOne && (op.temporarySpeedLimit === undefined || op.temporarySpeedLimit >= (op.speedLimit ?? segment.speedLimit))) return toConflict(op, '一级缺陷未关闭，回传的限速方案未设置更低临时限速')
      const previous = segment.temporarySpeedLimit
      segment.speedLimit = op.speedLimit ?? segment.speedLimit
      segment.temporarySpeedLimit = op.temporarySpeedLimit
      segment.version += 1
      markSynced(op)
      addAudit(segment.id, '离线回传区段限速', op.operator, op.summary)
      logSpeedRecalc(segment.id, `离线回传限速调整：${op.summary}`, previous, op.temporarySpeedLimit)
      return 'applied'
    }
    const defect = defects.value.find((item) => item.id === op.defectId)
    if (!defect) return toConflict(op, '缺陷不存在或已删除')
    if (defect.version !== op.baseDefectVersion) return toConflict(op, `缺陷版本不一致：现场基于V${op.baseDefectVersion}录入，当前已为V${defect.version}，后到记录不覆盖`)
    if (op.kind === '关闭缺陷' && !defect.retests.some((item) => item.passed)) return toConflict(op, '缺少合格复测记录，无法关闭')
    applyOpPayload(op, defect)
    markSynced(op)
    addAudit(defect.id, `离线回传${op.kind}`, op.operator, op.summary)
    if (defect.status === '已关闭') recalcSegmentSpeed(defect.segmentId, `缺陷${defect.id}经离线回传关闭`)
    return 'applied'
  }

  function applyOpPayload(op: OfflineOperation, defect: Defect) {
    if (op.kind === '整治记录' && op.action) {
      defect.actions.unshift(op.action)
      defect.status = '待复测'
    } else if (op.kind === '复测' && op.retest) {
      const roundConflict = defect.retests.some((item) => item.round === op.retest!.round)
      defect.retests.unshift({ ...op.retest, round: roundConflict ? Math.max(0, ...defect.retests.map((item) => item.round)) + 1 : op.retest.round })
      defect.status = op.retest.passed ? '已关闭' : '复测不合格'
    } else if (op.kind === '关闭缺陷') {
      defect.status = '已关闭'
    }
    defect.version += 1
  }

  function markSynced(op: OfflineOperation) {
    op.status = '已回传'
    op.syncedAt = new Date().toISOString()
    op.lastError = undefined
  }

  function toConflict(op: OfflineOperation, reason: string): 'conflict' {
    op.status = '冲突待复核'
    op.lastError = reason
    const defect = op.defectId ? defects.value.find((item) => item.id === op.defectId) : undefined
    const segment = segments.value.find((item) => item.id === op.segmentId)
    const currentSummary = defect
      ? `当前${defect.status} · V${defect.version} · 整治${defect.actions.length}条 · 复测${defect.retests.length}轮`
      : `区段V${segment?.version ?? '?'} · 正式限速${segment?.speedLimit ?? '?'} km/h · 临时限速${segment?.temporarySpeedLimit ?? '无'}`
    conflicts.value.unshift({
      id: `CF-${Date.now()}-${idSeed++}`, opId: op.id, segmentId: op.segmentId, defectId: op.defectId, reason,
      queuedSummary: `${op.kind}｜${op.summary}（${op.crew} ${op.operator}，基于缺陷V${op.baseDefectVersion ?? '-'} / 区段V${op.baseSegmentVersion}）`,
      currentSummary, status: '待复核', createdAt: new Date().toISOString()
    })
    addAudit(op.defectId ?? op.segmentId, '回传冲突待复核', op.operator, reason)
    return 'conflict'
  }

  function resolveConflict(conflictId: string, resolution: '采用回传记录' | '保留现有记录') {
    const conflict = conflicts.value.find((item) => item.id === conflictId)
    if (!conflict || conflict.status !== '待复核') return { ok: false, message: '冲突不存在或已复核' }
    const op = offlineQueue.value.find((item) => item.id === conflict.opId)
    if (resolution === '采用回传记录' && op) {
      const defect = op.defectId ? defects.value.find((item) => item.id === op.defectId) : undefined
      if (op.kind !== '区段限速' && !defect) return { ok: false, message: '缺陷不存在，无法采用回传记录' }
      if (op.kind === '关闭缺陷' && defect && !defect.retests.some((item) => item.passed)) return { ok: false, message: '仍缺少合格复测记录，不能关闭' }
      if (op.kind === '区段限速') {
        const segment = segments.value.find((item) => item.id === op.segmentId)
        if (!segment) return { ok: false, message: '区段不存在，无法采用回传记录' }
        const previous = segment.temporarySpeedLimit
        segment.speedLimit = op.speedLimit ?? segment.speedLimit
        segment.temporarySpeedLimit = op.temporarySpeedLimit
        segment.version += 1
        logSpeedRecalc(segment.id, `复核采用离线限速：${op.summary}`, previous, op.temporarySpeedLimit)
      } else if (defect) {
        applyOpPayload(op, defect)
        if (defect.status === '已关闭') recalcSegmentSpeed(defect.segmentId, `缺陷${defect.id}经复核采用回传记录关闭`)
      }
      markSynced(op)
    } else if (op) {
      op.status = '已作废'
    }
    conflict.status = '已复核'
    conflict.resolution = resolution
    conflict.resolvedAt = new Date().toISOString()
    addAudit(conflict.defectId ?? conflict.segmentId, `冲突复核：${resolution}`, '当前用户', conflict.reason)
    return { ok: true, message: `已复核：${resolution}` }
  }

  function setOnline(value: boolean) {
    online.value = value
    if (value) syncNow()
    else lastSyncMessage.value = '已切换到离线，新提交将暂存本机'
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => setOnline(true))
    window.addEventListener('offline', () => setOnline(false))
  }

  function reset() {
    segments.value = structuredClone(seedSegments)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    offlineQueue.value = structuredClone(seedOfflineQueue)
    conflicts.value = []
    speedRecalcLog.value = structuredClone(seedRecalcLog)
    lastSyncMessage.value = ''
  }

  watch([segments, defects, audit], () => localStorage.setItem(STORAGE_KEY, JSON.stringify({ segments: segments.value, defects: defects.value, audit: audit.value })), { deep: true, flush: 'sync' })
  watch([offlineQueue, conflicts, speedRecalcLog], () => localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify({ queue: offlineQueue.value, conflicts: conflicts.value, recalcLog: speedRecalcLog.value })), { deep: true, flush: 'sync' })

  return { segments, defects, audit, keyword, status, selectedSegmentId, filtered, selectedSegment, assign, addAction, addRetest, transition, updateSegmentSpeed, reset, offlineQueue, conflicts, speedRecalcLog, online, syncing, simulateDrop, lastSyncMessage, pendingOps, openConflicts, pendingDefectIds, syncNow, resolveConflict, setOnline, recalcSegmentSpeed }
})
