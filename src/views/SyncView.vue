<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useTrackStore } from '../stores/track'
import { useSyncStore } from '../stores/sync'
import { commitOp, glitch, resetServer, setForceFail, snapshot } from '../graphql/server'
import type { OutboxOp } from '../types'

const track = useTrackStore()
const sync = useSyncStore()
const online = ref(navigator.onLine)
const peerDefectId = ref(track.defects[0]?.id ?? '')
const peerMethod = ref('垫板调整')
const peerNote = ref('对端班组先提交整治')
const peerValue = ref<number>(0)
const peerTester = ref('魏强')
const peerSegmentId = ref(track.segments[0]?.id ?? '')
const peerSpeedLimit = ref(track.segments[0]?.speedLimit ?? 160)
const peerTemp = ref<number | undefined>(track.segments[0]?.temporarySpeedLimit)
const peerMessage = ref('')
const glitchLeft = ref(0)

const statusColor: Record<string, string> = {
  待回传: 'warning', 同步中: 'info', 待重试: 'error', 冲突: 'error', 已入库: 'success', 已拒绝: 'default'
}
const typeLabel: Record<string, string> = { rectification: '整治', retest: '复测', close: '关闭', assign: '派工', speed: '区段限速' }

const queue = computed(() => [...track.outbox].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const conflictOps = computed(() => queue.value.filter((op) => op.status === '冲突'))
const peerDefect = computed(() => {
  const local = track.defects.find((item) => item.id === peerDefectId.value)
  return snapshot().defects.find((item) => item.id === peerDefectId.value) ?? local
})

function goOnline() {
  setForceFail(false)
  window.dispatchEvent(new Event('online'))
  void sync.syncAll(true)
}
function goOffline() {
  setForceFail(true)
}
function makeGlitch() {
  glitch(8000)
  peerMessage.value = '已制造 8 秒网络抖动，期间回传会失败并自动重试'
  glitchLeft.value = 8
  const timer = setInterval(() => {
    glitchLeft.value -= 1
    if (glitchLeft.value <= 0) clearInterval(timer)
  }, 1000)
}

/** 模拟“对端班组”在另一台设备上在线提交同一缺陷（直接写权威库，按服务端版本校验） */
function peerRectification() {
  const server = snapshot()
  const defect = server.defects.find((item) => item.id === peerDefectId.value)
  if (!defect) return
  const op: OutboxOp = {
    id: `PEER-${Date.now()}`, deviceId: '设备-peer', type: 'rectification', entityId: defect.id,
    baseVersion: defect.version,
    payload: { action: { method: peerMethod.value as any, note: peerNote.value, operator: peerTester.value, recordedAt: new Date().toISOString() }, operator: peerTester.value },
    createdAt: new Date().toISOString(), status: '已入库', attempts: 1
  }
  const result = commitOp(op)
  peerMessage.value = result.kind === 'applied' ? `对端班组的整治已直接入库（服务端升至 V${result.server.defects.find((item) => item.id === defect.id)?.version}）` : `对端提交失败：${result.kind}`
  if (result.kind === 'applied') track.ingestServer(result.server)
}
function peerRetest(passed: boolean) {
  const server = snapshot()
  const defect = server.defects.find((item) => item.id === peerDefectId.value)
  if (!defect) return
  const value = peerValue.value || defect.limit - (passed ? 1 : 0.5)
  const round = defect.retests.length + 1
  const op: OutboxOp = {
    id: `PEER-${Date.now()}`, deviceId: '设备-peer', type: 'retest', entityId: defect.id,
    baseVersion: defect.version,
    payload: { retest: { round, passed, measuredValue: value, limit: defect.limit, note: passed ? '对端复测合格' : '对端复测仍超限', tester: peerTester.value, testedAt: new Date().toISOString() }, operator: peerTester.value },
    createdAt: new Date().toISOString(), status: '已入库', attempts: 1
  }
  const result = commitOp(op)
  peerMessage.value = result.kind === 'applied' ? `对端班组复测${passed ? '合格，缺陷已在服务端关闭' : '不合格'}（服务端 V${result.server.defects.find((item) => item.id === defect.id)?.version}）` : `对端提交失败：${result.kind}`
  if (result.kind === 'applied') track.ingestServer(result.server)
}
function peerClose() {
  const server = snapshot()
  const defect = server.defects.find((item) => item.id === peerDefectId.value)
  if (!defect) return
  const op: OutboxOp = {
    id: `PEER-${Date.now()}`, deviceId: '设备-peer', type: 'close', entityId: defect.id,
    baseVersion: defect.version, payload: { operator: peerTester.value },
    createdAt: new Date().toISOString(), status: '已入库', attempts: 1
  }
  const result = commitOp(op)
  peerMessage.value = result.kind === 'applied' ? `对端班组已关闭该缺陷（服务端 V${result.server.defects.find((item) => item.id === defect.id)?.version}）` : result.kind === 'rejected' ? `对端关闭被拒：${result.reason}` : '对端关闭冲突'
  if (result.kind === 'applied') track.ingestServer(result.server)
}
function submitPeerSpeed() {
  const server = snapshot()
  const segment = server.segments.find((item) => item.id === peerSegmentId.value)
  if (!segment) return
  const op: OutboxOp = {
    id: `PEER-${Date.now()}`, deviceId: '设备-peer', type: 'speed', entityId: segment.id,
    baseVersion: segment.version,
    payload: { speed: peerSpeedLimit.value, temporary: peerTemp.value ?? null, reason: '对端调度调整限速', operator: '工务二工区调度' },
    createdAt: new Date().toISOString(), status: '已入库', attempts: 1
  }
  const result = commitOp(op)
  peerMessage.value = result.kind === 'applied' ? `对端区段限速已入库（服务端 V${result.server.segments.find((item) => item.id === segment.id)?.version}）` : result.kind === 'rejected' ? `被拒：${result.reason}` : result.reason
  if (result.kind === 'applied') track.ingestServer(result.server)
}
function pullServer() {
  track.ingestServer(snapshot())
  peerMessage.value = '已重新拉取服务端权威数据（本机待回传实体继续保留现场版本）'
}
function resetAll() {
  resetServer()
  track.reset()
}

function time(value: string) {
  return value.replace('T', ' ').slice(5, 16)
}

onMounted(() => {
  window.addEventListener('online', up)
  window.addEventListener('offline', down)
})
onUnmounted(() => {
  window.removeEventListener('online', up)
  window.removeEventListener('offline', down)
})
function up() { online.value = true }
function down() { online.value = false }
</script>
<template>
  <section class="page sync-page">
    <div class="sync-status">
      <div class="status-card" :class="{ off: !online }">
        <span>网络</span>
        <strong>{{ !online ? '系统断网' : '在线（可用下方按钮模拟断网）' }}</strong>
        <small>本机 {{ track.deviceId }}</small>
      </div>
      <div class="status-card"><span>回传调度</span><strong>{{ sync.phase }}</strong><small>{{ sync.lastError ? sync.lastError : (sync.lastSyncAt ? `上次回传 ${time(sync.lastSyncAt)}` : '启动后自动回传') }}</small></div>
      <div class="status-card"><span>待回传 / 冲突</span><strong>{{ track.pendingOps.length }} / {{ track.conflicts.length }}</strong><small>逐条入库，失败保留已入库部分</small></div>
      <div class="status-card actions">
        <v-btn size="small" color="success" variant="flat" @click="goOnline">恢复网络并回传</v-btn>
        <v-btn size="small" color="error" variant="outlined" @click="goOffline">模拟断网</v-btn>
        <v-btn size="small" color="warning" variant="outlined" @click="makeGlitch">抖动8s{{ glitchLeft ? `(${glitchLeft}s)` : '' }}</v-btn>
        <v-btn size="small" variant="text" @click="resetAll">重置演示数据</v-btn>
      </div>
    </div>
    <p v-if="glitchLeft" class="glitch-tip">网络抖动剩余 {{ glitchLeft }}s：回传将失败转待重试，已入库条目不会回滚，恢复后自动补发。</p>

    <div class="peer-panel">
      <div class="panel-head"><h2>对端班组并发模拟</h2><p>不经过本机发件箱，直接写驻地权威库，用于复现两个班组同时提交同一缺陷 / 同一区段。</p></div>
      <div class="peer-grid">
        <v-select v-model="peerDefectId" :items="track.defects.map((d) => ({ title: `${d.id} · ${d.type} · ${d.owner}`, value: d.id }))" label="选择缺陷（对端视角以服务端版本为准）" density="compact" variant="outlined" hide-details />
        <v-text-field v-model="peerNote" label="整治说明" density="compact" variant="outlined" hide-details />
        <v-select v-model="peerMethod" :items="['打磨', '捣固', '更换', '垫板调整', '测量复核']" label="整治方式" density="compact" variant="outlined" hide-details />
        <v-text-field v-model="peerTester" label="对端操作人" density="compact" variant="outlined" hide-details />
        <v-btn color="secondary" variant="tonal" @click="peerRectification">对端提交整治</v-btn>
        <v-btn color="success" variant="tonal" @click="peerRetest(true)">对端复测合格关闭</v-btn>
        <v-btn color="error" variant="tonal" @click="peerRetest(false)">对端复测不合格</v-btn>
        <v-btn variant="tonal" @click="peerClose">对端直接关闭</v-btn>
      </div>
      <div v-if="peerDefect" class="peer-server">
        服务端现状：{{ peerDefect.id }} · {{ peerDefect.status }} · V{{ peerDefect.version }}
        <span v-if="peerDefect.actions[0]">最新整治：{{ peerDefect.actions[0].method }} / {{ peerDefect.actions[0].operator }}</span>
      </div>
      <div class="peer-grid segment">
        <v-select v-model="peerSegmentId" :items="track.segments.map((s) => ({ title: `${s.id} · ${s.line}`, value: s.id }))" label="选择区段" density="compact" variant="outlined" hide-details />
        <v-text-field v-model.number="peerSpeedLimit" type="number" label="对端正式限速" density="compact" variant="outlined" hide-details />
        <v-text-field v-model.number="peerTemp" type="number" label="对端临时限速（清空=解除）" density="compact" variant="outlined" hide-details clearable />
        <v-btn color="secondary" variant="tonal" @click="submitPeerSpeed">对端保存区段版本</v-btn>
        <v-btn variant="outlined" @click="pullServer">本机重新拉取服务端</v-btn>
      </div>
      <p v-if="peerMessage" class="peer-message">{{ peerMessage }}</p>
    </div>

    <div v-if="conflictOps.length" class="conflict-banner">
      <strong>{{ conflictOps.length }} 项冲突已转待复核</strong>
      <span>后到提交不会覆盖先入库记录，需调度逐条裁决后才会继续回传该实体的其余操作。</span>
    </div>

    <v-table density="compact" class="queue-table">
      <thead><tr><th>操作</th><th>本机操作号</th><th>实体</th><th>基于版本</th><th>状态</th><th>尝试</th><th>现场时间</th><th>说明 / 错误</th><th>复核</th></tr></thead>
      <tbody>
        <tr v-for="op in queue" :key="op.id" :class="{ conflict: op.status === '冲突' }">
          <td>{{ typeLabel[op.type] }}</td>
          <td class="mono">{{ op.id }}</td>
          <td>{{ op.entityId }}</td>
          <td>V{{ op.baseVersion }}</td>
          <td><v-chip size="small" :color="statusColor[op.status]">{{ op.status }}</v-chip></td>
          <td>{{ op.attempts }}</td>
          <td>{{ time(op.createdAt) }}</td>
          <td class="reason">{{ op.conflictReason || op.lastError || (op.status === '已入库' ? '已合并入库' : '') }}</td>
          <td>
            <template v-if="op.status === '冲突'">
              <v-btn size="x-small" color="success" variant="tonal" @click="sync.resolve(op.id, 'keep')">保留现场并重传</v-btn>
              <v-btn size="x-small" variant="outlined" @click="sync.resolve(op.id, 'adopt')">采用服务端</v-btn>
            </template>
            <v-btn v-else-if="op.status === '待重试'" size="x-small" variant="text" @click="sync.retryNow()">立即重试</v-btn>
          </td>
        </tr>
      </tbody>
    </v-table>
  </section>
</template>

<style scoped>
.sync-status { display: grid; grid-template-columns: 1.1fr 1.6fr 1fr 2.2fr; gap: 10px; margin-bottom: 12px; }
.status-card { background: white; border: 1px solid #dae2e3; border-top: 3px solid #4e7d63; padding: 12px 14px; display: grid; gap: 4px; }
.status-card.off { border-top-color: #b0463c; }
.status-card span { color: #778583; font-size: 11px; }
.status-card strong { font-size: 17px; color: #315b72; }
.status-card small { color: #8a9795; font-size: 10px; }
.status-card.actions { display: flex; flex-wrap: wrap; gap: 6px; align-content: center; }
.glitch-tip { background: #fbeceb; border-left: 3px solid #b0463c; padding: 8px 12px; font-size: 12px; color: #8a3a33; margin: 0 0 12px; }
.peer-panel { background: white; border: 1px solid #dae2e3; padding: 15px 16px; margin-bottom: 14px; }
.panel-head h2 { margin: 0 0 3px; font-size: 16px; }.panel-head p { margin: 0 0 12px; color: #71807f; font-size: 11px; }
.peer-grid { display: grid; grid-template-columns: 2fr 1.4fr 1fr 1fr repeat(4, auto); gap: 8px; align-items: center; }
.peer-grid.segment { grid-template-columns: 2fr 1fr 1.4fr auto auto; margin-top: 10px; }
.peer-server { margin-top: 10px; font-size: 12px; color: #425451; background: #f2f6f5; padding: 8px 10px; display: flex; gap: 16px; }
.peer-message { margin: 10px 0 0; color: #3f6b54; font-size: 12px; }
.conflict-banner { display: flex; gap: 14px; align-items: center; background: #fdeceb; border: 1px solid #e0b4af; padding: 10px 14px; margin-bottom: 10px; font-size: 12px; }
.conflict-banner strong { color: #a33a35; }.conflict-banner span { color: #7c5d59; }
.queue-table { background: white; }
.queue-table :deep(td), .queue-table :deep(th) { font-size: 12px; }
.queue-table tr.conflict { background: #fdf3f2; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #5a6b68; }
.reason { color: #8a4a44; max-width: 320px; }
</style>
