import { ref } from 'vue'
import { defineStore } from 'pinia'
import { commitOp, ensureNetwork, snapshot } from '../graphql/server'
import { registerSyncTrigger, useTrackStore } from './track'
import type { OutboxOp } from '../types'

type SyncPhase = '空闲' | '同步中' | '待重试'

/**
 * 离线回传调度：
 * - 逐条提交，已入库的即时落盘；中途网络失败只中断后续条目，已提交部分不回滚；
 * - 失败自动指数退避重试，也可手动重试；重启后发件箱由持久化恢复，不丢失；
 * - 某实体出现冲突后，该实体其余待回传操作一律挂起，待复核重放。
 */
export const useSyncStore = defineStore('sync', () => {
  const track = useTrackStore()
  const phase = ref<SyncPhase>('空闲')
  const lastError = ref('')
  const lastSyncAt = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false

  const ACTIVE: OutboxOp['status'][] = ['待回传', '待重试', '同步中']

  async function syncAll(manual = false): Promise<void> {
    if (running) return
    running = true
    phase.value = '同步中'
    try {
      ensureNetwork()
    } catch (error) {
      running = false
      phase.value = '待重试'
      lastError.value = (error as Error).message
      scheduleRetry()
      if (manual) track.addAudit('SYNC', '回传中断', '系统', `网络不可用：${lastError.value}，待回传内容已保留`)
      return
    }

    const queue = track.outbox
      .filter((op) => ACTIVE.includes(op.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    let stoppedByNetwork = false
    for (const op of queue) {
      // 同一实体已有冲突条目时，后续操作挂起，等待复核时统一重放
      if (track.outbox.some((item) => item.entityId === op.entityId && item.status === '冲突')) {
        if (op.status === '同步中') { op.status = '待重试'; track.persistOutbox() }
        continue
      }

      op.status = '同步中'
      track.persistOutbox()

      try {
        const result = commitOp(op)
        if (result.kind === 'applied') {
          // 一级缺陷关闭触发服务端限速重算（区段版本+1）：
          // 同一设备排队中的区段限速操作是同一操作链的延续，自动平移基线；
          // 对端班组改过的区段版本不会被平移，仍按冲突转待复核。
          if (result.recalc && (op.type === 'retest' || op.type === 'close')) {
            rebaseOwnSpeedOps(op.entityId)
          }
          track.markApplied(op)
          track.ingestServer(result.server)
          lastError.value = ''
        } else if (result.kind === 'conflict') {
          track.markConflict(op, { reason: result.reason, serverVersion: result.serverVersion, serverStatus: result.serverStatus, serverSpeed: result.serverSpeed, serverTemp: result.serverTemp })
        } else {
          track.markRejected(op, result.reason)
        }
      } catch (error) {
        // 同步失败：本条转待重试，后面的不再提交；之前已入库的条目不受影响
        track.markRetrying(op, (error as Error).message)
        lastError.value = (error as Error).message
        stoppedByNetwork = true
        phase.value = '待重试'
        scheduleRetry()
        break
      }
    }

    running = false
    if (!stoppedByNetwork) {
      phase.value = '空闲'
      lastSyncAt.value = new Date().toISOString()
    }
  }

  function rebaseOwnSpeedOps(entityId: string) {
    const defect = track.defects.find((item) => item.id === entityId)
    if (!defect) return
    const segmentId = defect.segmentId
    const serverSegment = snapshot().segments.find((item) => item.id === segmentId)
    if (!serverSegment) return
    const ownSpeedOps = track.outbox
      .filter((item) => item.entityId === segmentId && item.type === 'speed' && ACTIVE.includes(item.status) && item.deviceId === track.deviceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    // 仅当排队限速操作的基线正好落后服务端一个版本（即系统重算所致）才平移；
    // 若对端又改过区段，则不连续，仍走冲突复核，不能自动放行。
    let expected = serverSegment.version - ownSpeedOps.length
    for (const item of ownSpeedOps) {
      if (item.baseVersion === expected) item.baseVersion += 1
      expected += 1
    }
    track.persistOutbox()
  }

  function scheduleRetry() {
    if (timer) clearTimeout(timer)
    const maxAttempts = Math.max(1, ...track.outbox.map((op) => op.attempts))
    const delay = Math.min(2000 * 2 ** Math.min(maxAttempts - 1, 4), 30000)
    timer = setTimeout(() => void syncAll(), delay)
  }

  function resolve(opId: string, decision: 'adopt' | 'keep') {
    track.resolveConflict(opId, decision, snapshot())
    void syncAll()
  }

  function retryNow() {
    if (timer) clearTimeout(timer)
    void syncAll(true)
  }

  function start() {
    window.addEventListener('online', () => void syncAll())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void syncAll()
    })
    // 重启后待回传内容从持久化恢复，立即尝试回传
    void syncAll()
  }

  return { phase, lastError, lastSyncAt, syncAll, resolve, retryNow, start }
})

export function bootSync() {
  const sync = useSyncStore()
  registerSyncTrigger(() => void sync.syncAll())
  sync.start()
}
