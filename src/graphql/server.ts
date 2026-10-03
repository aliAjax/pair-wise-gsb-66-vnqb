import type { AuditEntry, Defect, OutboxOp, TrackSegment } from '../types'
import { seedAudit, seedDefects, seedSegments } from '../data/seed'

/**
 * 模拟“驻地服务端”：
 * - 权威数据独立持久化（gsb66:server），不与任何一台现场设备的本机库混用；
 * - 跨标签页通过 storage 事件同步，两个班组可各开一个标签页真实并发提交；
 * - 每条变更按缺陷版本 / 区段版本做乐观锁校验，版本不一致直接判冲突，绝不后到覆盖。
 */

const SERVER_KEY = 'gsb66:server'
const FORCE_FAIL_KEY = 'gsb66:force-fail'
const FAIL_UNTIL_KEY = 'gsb66:fail-until'
const seqKey = 'gsb66:server-seq'

interface ServerData {
  segments: TrackSegment[]
  defects: Defect[]
  audit: AuditEntry[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function loadServer(): ServerData {
  try {
    const raw = localStorage.getItem(SERVER_KEY)
    if (raw) return JSON.parse(raw) as ServerData
  } catch {
    /* 损坏则重建种子库 */
  }
  const data: ServerData = { segments: clone(seedSegments), defects: clone(seedDefects), audit: clone(seedAudit) }
  localStorage.setItem(SERVER_KEY, JSON.stringify(data))
  return data
}

let data: ServerData = loadServer()

/** 其他标签页（其他班组设备）提交后，通过 storage 事件把权威库推送到本页 */
window.addEventListener('storage', (event) => {
  if (event.key === SERVER_KEY && event.newValue) {
    try {
      data = JSON.parse(event.newValue) as ServerData
    } catch {
      /* 保留上一份可用数据 */
    }
  }
})

function persist() {
  localStorage.setItem(SERVER_KEY, JSON.stringify(data))
}

function nextAuditId(): string {
  const seq = Number(localStorage.getItem(seqKey) ?? '100') + 1
  localStorage.setItem(seqKey, String(seq))
  return `AS-${seq}`
}

function serverAudit(entityId: string, action: string, operator: string, detail: string, at: string) {
  data.audit.unshift({ id: nextAuditId(), entityId, action, operator, detail, createdAt: at })
}

/** 一级缺陷数量变化后重算临时限速：存在未关闭一级缺陷时临时限速必须低于正式限速，全部关闭后解除 */
function recalcTemporary(segment: TrackSegment, opId: string, at: string, cause: string): { value?: number; reason: string } {
  const open = data.defects.filter((item) => item.segmentId === segment.id && item.severity === '一级' && item.status !== '已关闭' && item.status !== '待复核')
  if (open.length > 0) {
    const target = Math.min(segment.temporarySpeedLimit ?? segment.speedLimit - 20, segment.speedLimit - 20)
    segment.version += 1
    const reason = `${cause}：区段仍有${open.length}项未关闭一级缺陷（${open.map((item) => item.id).join('、')}），临时限速重算为 ${target} km/h（区段版本 V${segment.version}）`
    segment.temporarySpeedLimit = target
    segment.lastSpeedReason = { value: target, reason, at, opId }
    serverAudit(segment.id, '临时限速重算', '系统', reason, at)
    return { value: target, reason }
  }
  segment.version += 1
  const reason = `${cause}：一级缺陷已全部关闭，临时限速解除，恢复正式限速 ${segment.speedLimit} km/h（区段版本 V${segment.version}）`
  segment.temporarySpeedLimit = undefined
  segment.lastSpeedReason = { value: undefined, reason, at, opId }
  serverAudit(segment.id, '临时限速解除', '系统', reason, at)
  return { value: undefined, reason }
}

export type SyncResult =
  | { kind: 'applied'; server: ServerData; recalc?: { value?: number; reason: string } }
  | { kind: 'conflict'; reason: string; serverVersion: number; serverStatus?: Defect['status']; serverSpeed?: number; serverTemp?: number }
  | { kind: 'rejected'; reason: string }

/** 校验网络：可注入“同步失败”窗口，用于演示失败保留与重试 */
export function ensureNetwork(): void {
  if (localStorage.getItem(FORCE_FAIL_KEY) === '1') throw new Error('模拟网络不可用（已强制断网）')
  const until = Number(localStorage.getItem(FAIL_UNTIL_KEY) ?? '0')
  if (until && Date.now() < until) throw new Error('网络抖动，服务端暂不可达')
}

export function setForceFail(on: boolean) {
  if (on) localStorage.setItem(FORCE_FAIL_KEY, '1')
  else localStorage.removeItem(FORCE_FAIL_KEY)
}

export function isForceFail(): boolean {
  return localStorage.getItem(FORCE_FAIL_KEY) === '1'
}

/** 制造一次 8 秒的网络抖动窗口（跨标签页生效） */
export function glitch(ms = 8000) {
  localStorage.setItem(FAIL_UNTIL_KEY, String(Date.now() + ms))
}

/**
 * 把一条离线操作应用到权威库。每次调用独立提交：
 * 同步在某一条处失败时，此前已提交的条目不会回滚。
 */
export function commitOp(op: OutboxOp): SyncResult {
  ensureNetwork()

  if (op.type === 'speed') {
    const segment = data.segments.find((item) => item.id === op.entityId)
    if (!segment) return { kind: 'rejected', reason: '区段不存在' }
    if (segment.version !== op.baseVersion) {
      return { kind: 'conflict', reason: `区段版本不一致（本机基于 V${op.baseVersion}，服务端已到 V${segment.version}）`, serverVersion: segment.version, serverSpeed: segment.speedLimit, serverTemp: segment.temporarySpeedLimit }
    }
    const speed = op.payload.speed
    const temporary = op.payload.temporary === null ? undefined : op.payload.temporary
    if (typeof speed !== 'number') return { kind: 'rejected', reason: '缺少正式限速' }
    const hasOpenLevel1 = data.defects.some((item) => item.segmentId === segment.id && item.severity === '一级' && item.status !== '已关闭' && item.status !== '待复核')
    if (hasOpenLevel1 && (temporary === undefined || temporary >= speed)) {
      return { kind: 'rejected', reason: '一级缺陷未关闭时必须设置低于正式限速的临时限速' }
    }
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    const reasonText = op.payload.reason ?? '调度保存速度版本'
    segment.lastSpeedReason = { value: temporary, reason: `${reasonText}（区段版本 V${segment.version}）`, at: op.createdAt, opId: op.id }
    serverAudit(segment.id, '更新区段速度版本', op.payload.operator ?? '工务调度', `${reasonText}；正式限速 ${speed} km/h，临时限速 ${temporary ?? '解除'}`, op.createdAt)
    persist()
    return { kind: 'applied', server: snapshot() }
  }

  const defect = data.defects.find((item) => item.id === op.entityId)
  if (!defect) return { kind: 'rejected', reason: '缺陷不存在' }

  // 核心规则：两个班组同时提交同一缺陷时，baseVersion 落后即冲突，不能后到覆盖
  if (defect.version !== op.baseVersion) {
    return {
      kind: 'conflict',
      reason: `缺陷版本不一致（本机基于 V${op.baseVersion}，服务端已到 V${defect.version}），疑似另一班组已提交`,
      serverVersion: defect.version,
      serverStatus: defect.status
    }
  }
  if (defect.status === '已关闭') return { kind: 'rejected', reason: '缺陷在服务端已关闭，操作被拒绝' }

  const operator = op.payload.operator ?? '现场班组'

  if (op.type === 'rectification') {
    const action = op.payload.action
    if (!action) return { kind: 'rejected', reason: '缺少整治记录' }
    defect.actions.unshift({ ...action, opId: op.id })
    defect.status = '待复测'
    defect.version += 1
    serverAudit(defect.id, '离线回传·提交整治记录', operator, `${action.method}：${action.note}（现场时间 ${op.createdAt.replace('T', ' ').slice(0, 16)}，版本升至 V${defect.version}）`, new Date().toISOString())
    persist()
    return { kind: 'applied', server: snapshot() }
  }

  if (op.type === 'retest') {
    const retest = op.payload.retest
    if (!retest) return { kind: 'rejected', reason: '缺少复测记录' }
    defect.retests.unshift({ ...retest, opId: op.id })
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    defect.version += 1
    serverAudit(defect.id, '离线回传·提交复测', retest.tester, `${retest.passed ? `第${retest.round}轮复测通过，缺陷关闭` : `第${retest.round}轮复测未通过`}（版本升至 V${defect.version}）`, new Date().toISOString())
    let recalc: { value?: number; reason: string } | undefined
    if (retest.passed) {
      const segment = data.segments.find((item) => item.id === defect.segmentId)
      if (segment) recalc = recalcTemporary(segment, op.id, new Date().toISOString(), `缺陷 ${defect.id} 复测合格关闭，一级缺陷数量变化`)
    }
    persist()
    return { kind: 'applied', server: snapshot(), recalc }
  }

  if (op.type === 'close') {
    if (!defect.retests.some((item) => item.passed)) return { kind: 'rejected', reason: '没有合格复测记录，不能关闭' }
    defect.status = '已关闭'
    defect.version += 1
    serverAudit(defect.id, '离线回传·关闭缺陷', operator, `缺陷关闭（版本升至 V${defect.version}）`, new Date().toISOString())
    const segment = data.segments.find((item) => item.id === defect.segmentId)
    const recalc = segment ? recalcTemporary(segment, op.id, new Date().toISOString(), `缺陷 ${defect.id} 关闭，一级缺陷数量变化`) : undefined
    persist()
    return { kind: 'applied', server: snapshot(), recalc }
  }

  if (op.type === 'assign') {
    const owner = op.payload.owner
    if (!owner) return { kind: 'rejected', reason: '缺少责任工区' }
    defect.owner = owner
    defect.status = '整治中'
    defect.version += 1
    serverAudit(defect.id, '离线回传·批量派工', operator, `任务分配至${owner}（版本升至 V${defect.version}）`, new Date().toISOString())
    persist()
    return { kind: 'applied', server: snapshot() }
  }

  return { kind: 'rejected', reason: '未知操作类型' }
}

export function snapshot(): ServerData {
  return clone(data)
}

export function resetServer() {
  data = { segments: clone(seedSegments), defects: clone(seedDefects), audit: clone(seedAudit) }
  localStorage.removeItem(seqKey)
  persist()
}

/** 仅供逻辑验证脚本播种内存权威库 */
export function _seedDefect(defect: Defect) {
  data.defects.push(clone(defect))
  persist()
}
