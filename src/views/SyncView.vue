<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTrackStore } from '../stores/track'

const store = useTrackStore()
const message = ref('')
const opHeaders = [
  { title: '回传单号', key: 'id' },
  { title: '类型', key: 'kind' },
  { title: '对象', key: 'target' },
  { title: '班组 / 操作人', key: 'crew' },
  { title: '内容', key: 'summary' },
  { title: '基准版本', key: 'base' },
  { title: '状态', key: 'status' },
  { title: '尝试', key: 'attempts' },
  { title: '记录时间', key: 'createdAt' }
]
const recalcHeaders = [
  { title: '时间', key: 'createdAt' },
  { title: '区段', key: 'segmentId' },
  { title: '未关闭一级', key: 'openLevelOne' },
  { title: '临时限速变化', key: 'change' },
  { title: '重算原因', key: 'reason' }
]
const queueRows = computed(() => [...store.offlineQueue].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
function runSync() {
  const result = store.syncNow()
  message.value = result.message
}
function resolve(id: string, resolution: '采用回传记录' | '保留现有记录') {
  const result = store.resolveConflict(id, resolution)
  message.value = result.message
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article><span>网络状态</span><strong :class="{ offline: !store.online }">{{ store.online ? '在线' : '离线' }}</strong><small>断网操作暂存本机</small></article>
      <article><span>待回传</span><strong>{{ store.pendingOps.length }}</strong><small>重启不丢失</small></article>
      <article><span>冲突待复核</span><strong>{{ store.openConflicts.length }}</strong><small>后到记录不覆盖</small></article>
      <article><span>已回传</span><strong>{{ store.offlineQueue.filter((item) => item.status === '已回传').length }}</strong><small>按缺陷/区段版本合并</small></article>
    </div>
    <div class="sync-toolbar">
      <v-btn :color="store.online ? 'error' : 'primary'" variant="outlined" @click="store.setOnline(!store.online)">{{ store.online ? '切换为离线' : '恢复网络并回传' }}</v-btn>
      <v-btn color="primary" :disabled="!store.online || !store.pendingOps.length" @click="runSync">立即回传 {{ store.pendingOps.length ? `(${store.pendingOps.length})` : '' }}</v-btn>
      <v-switch v-model="store.simulateDrop" color="warning" density="compact" hide-details label="弱网模拟：入库一条后中断，检验保留与重试" />
      <span v-if="message || store.lastSyncMessage" class="sync-message">{{ message || store.lastSyncMessage }}</span>
    </div>
    <h3 class="block-title">本机回传队列</h3>
    <v-data-table :headers="opHeaders" :items="queueRows" item-value="id" density="compact" :items-per-page="10">
      <template #item.target="{ item }">{{ item.defectId ?? item.segmentId }}</template>
      <template #item.crew="{ item }">{{ item.crew }} · {{ item.operator }}</template>
      <template #item.base="{ item }">缺陷V{{ item.baseDefectVersion ?? '-' }} / 区段V{{ item.baseSegmentVersion }}</template>
      <template #item.status="{ item }">
        <v-chip size="small" :color="item.status === '已回传' ? 'success' : item.status === '冲突待复核' ? 'error' : item.status === '已作废' ? 'default' : 'warning'">{{ item.status }}</v-chip>
        <small v-if="item.lastError" class="op-error">{{ item.lastError }}</small>
      </template>
      <template #item.createdAt="{ item }">{{ item.createdAt.replace('T', ' ').slice(0, 16) }}</template>
    </v-data-table>
    <h3 class="block-title">版本冲突复核</h3>
    <div v-if="!store.conflicts.length" class="empty-band">暂无冲突。两个班组同时提交同一缺陷时，后到的回传会在这里等待复核，不会覆盖已有记录。</div>
    <div v-for="item in store.conflicts" :key="item.id" class="conflict-card" :class="{ resolved: item.status === '已复核' }">
      <div class="conflict-head">
        <strong>{{ item.defectId ?? item.segmentId }}</strong>
        <v-chip size="small" :color="item.status === '待复核' ? 'error' : 'success'">{{ item.status }}</v-chip>
        <span>{{ item.createdAt.replace('T', ' ').slice(0, 16) }}</span>
      </div>
      <p class="conflict-reason">{{ item.reason }}</p>
      <div class="conflict-compare">
        <div><small>离线回传内容</small><span>{{ item.queuedSummary }}</span></div>
        <div><small>库内当前状态</small><span>{{ item.currentSummary }}</span></div>
      </div>
      <div v-if="item.status === '待复核'" class="conflict-actions">
        <v-btn size="small" color="primary" @click="resolve(item.id, '采用回传记录')">采用回传记录</v-btn>
        <v-btn size="small" variant="outlined" @click="resolve(item.id, '保留现有记录')">保留现有记录</v-btn>
      </div>
      <p v-else class="conflict-resolution">复核结论：{{ item.resolution }} · {{ item.resolvedAt?.replace('T', ' ').slice(0, 16) }}</p>
    </div>
    <h3 class="block-title">临时限速重算留痕</h3>
    <v-data-table :headers="recalcHeaders" :items="store.speedRecalcLog" item-value="id" density="compact" :items-per-page="8">
      <template #item.createdAt="{ item }">{{ item.createdAt.replace('T', ' ').slice(0, 16) }}</template>
      <template #item.change="{ item }">{{ item.previousTemporary ?? '无' }} → {{ item.nextTemporary ?? '无' }}</template>
    </v-data-table>
  </section>
</template>

<style scoped>
.metrics strong.offline { color: #a63e38; }
.sync-toolbar { display: flex; align-items: center; gap: 14px; background: white; border: 1px solid #dae2e3; padding: 12px 16px; margin-bottom: 16px; }
.sync-message { color: #8c6a2f; font-size: 12px; }
.block-title { font-size: 14px; margin: 18px 0 8px; }
.op-error { display: block; color: #a63e38; font-size: 10px; margin-top: 3px; }
.empty-band { background: white; border: 1px dashed #c3cdce; padding: 14px; color: #71807e; font-size: 12px; }
.conflict-card { background: white; border: 1px solid #dae2e3; border-left: 3px solid #b84239; padding: 13px 16px; margin-bottom: 10px; }
.conflict-card.resolved { border-left-color: #43876b; }
.conflict-head { display: flex; align-items: center; gap: 10px; }.conflict-head span { color: #8a9695; font-size: 11px; }
.conflict-reason { color: #a63e38; font-size: 12px; margin: 8px 0; }
.conflict-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.conflict-compare div { background: #f4f7f7; padding: 10px; display: grid; gap: 4px; }
.conflict-compare small { color: #8a9695; font-size: 10px; }.conflict-compare span { font-size: 12px; }
.conflict-actions { display: flex; gap: 10px; margin-top: 10px; }
.conflict-resolution { color: #43876b; font-size: 12px; margin: 10px 0 0; }
</style>
