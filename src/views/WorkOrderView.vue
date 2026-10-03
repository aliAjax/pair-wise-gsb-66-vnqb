<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTrackStore } from '../stores/track'

const route = useRoute()
const store = useTrackStore()
const selectedId = ref(String(route.params.id || store.defects[0]?.id || ''))
const defect = computed(() => store.defects.find((item) => item.id === selectedId.value))
const action = reactive({ method: '捣固', note: '', operator: '李海' })
const retest = reactive({ measuredValue: 0, tester: '王磊', note: '' })
const message = ref('')
const pending = computed(() => (defect.value ? store.pendingOf(defect.value.id) : []))

function opStatus(opId?: string) {
  if (!opId) return ''
  return store.outbox.find((op) => op.id === opId)?.status ?? '已入库'
}
function addAction() {
  if (!defect.value || !action.note) return
  store.addAction(defect.value.id, { ...action, method: action.method as any, recordedAt: new Date().toISOString() })
  action.note = ''
}
function addRetest() {
  if (!defect.value) return
  const round = defect.value.retests.length + 1
  const passed = retest.measuredValue <= defect.value.limit
  store.addRetest(defect.value.id, { round, passed, measuredValue: retest.measuredValue, limit: defect.value.limit, note: retest.note || (passed ? '复测合格' : '仍超过限值'), tester: retest.tester, testedAt: new Date().toISOString() })
  message.value = passed ? '复测通过，缺陷已关闭（离线先留本机，一级缺陷数量变化已触发限速重算）' : '复测不合格，任务重新进入整治'
}
function closeDefect() {
  if (!defect.value) return
  const result = store.transition(defect.value.id, '已关闭')
  message.value = result.message
}
function time(value: string) {
  return value.replace('T', ' ').slice(5, 16)
}
</script>

<template>
  <section class="page">
    <div class="work-layout">
      <div class="work-list">
        <button v-for="item in store.defects" :key="item.id" :class="{ active: item.id === selectedId }" @click="selectedId = item.id">
          <span>{{ item.id }} · V{{ item.version }}<em v-if="store.pendingOf(item.id).length" class="flag">{{ store.pendingOf(item.id).length }}待传</em></span><strong>{{ item.type }}超限</strong><small>{{ item.owner }} · {{ item.status }}</small>
        </button>
      </div>
      <div v-if="defect" class="work-main">
        <div class="section-head"><div><span>{{ defect.segmentId }} · K{{ Math.floor(defect.mileage / 1000) }}+{{ String(defect.mileage % 1000).padStart(3, '0') }}</span><h2>{{ defect.type }}缺陷整治</h2><p>{{ defect.measuredValue }} / 限值 {{ defect.limit }} · {{ defect.severity }} · {{ defect.status }}</p></div><v-chip :color="defect.status === '待复核' ? 'error' : defect.status === '已关闭' ? 'success' : 'warning'">{{ defect.status }}</v-chip></div>

        <div v-if="defect.conflict" class="conflict-box">
          <strong>回传冲突，已转待复核</strong>
          <span>{{ defect.conflict.reason }}；服务端状态 {{ defect.conflict.serverStatus ?? '—' }} / V{{ defect.conflict.serverVersion }}。本机现场记录不会被覆盖，需调度裁决。</span>
          <RouterLink to="/sync">去离线回传页复核 →</RouterLink>
        </div>

        <div class="offline-band"><strong>离线补录模式 · {{ store.deviceId }}</strong><span>无网时整治、复测、关闭先写入本机发件箱，恢复后按缺陷版本合并；现场原始记录时间与复测轮次保留。</span></div>
        <div v-if="pending.length" class="queue-strip">
          本机待回传：
          <em v-for="op in pending" :key="op.id" :class="op.status">{{ op.status }}（基于V{{ op.baseVersion }}）</em>
        </div>
        <div class="action-form">
          <v-select v-model="action.method" :items="['打磨', '捣固', '更换', '垫板调整', '测量复核']" label="整治方式" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.note" label="现场记录" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.operator" label="操作人" density="compact" variant="outlined" hide-details />
          <v-btn color="primary" :disabled="!!defect.conflict || !action.note" @click="addAction">提交整治记录</v-btn>
        </div>
        <div class="action-form">
          <v-text-field v-model.number="retest.measuredValue" type="number" label="复测值" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.tester" label="复测人" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.note" label="复测说明" density="compact" variant="outlined" hide-details />
          <v-btn color="secondary" :disabled="!!defect.conflict" @click="addRetest">提交复测</v-btn>
        </div>
        <div v-if="message" class="validation-message">{{ message }}</div>
        <div class="two-column">
          <div><h3>整治记录</h3><div v-for="item in defect.actions" :key="item.recordedAt" class="record-item"><strong>{{ item.method }}<em class="sync-tag" :class="opStatus(item.opId)">{{ opStatus(item.opId) || '历史' }}</em></strong><span>{{ item.note }}</span><small>{{ item.operator }} · {{ time(item.recordedAt) }}</small></div></div>
          <div><h3>复测轮次</h3><div v-for="item in defect.retests" :key="item.round" class="record-item"><strong>第{{ item.round }}轮 {{ item.passed ? '通过' : '未通过' }}<em class="sync-tag" :class="opStatus(item.opId)">{{ opStatus(item.opId) || '历史' }}</em></strong><span>{{ item.measuredValue }} / {{ item.limit }}</span><small>{{ item.tester }} · {{ item.note }}</small></div></div>
        </div>
        <v-btn variant="outlined" :disabled="!!defect.conflict" @click="closeDefect">申请关闭缺陷</v-btn>
      </div>
    </div>
  </section>
</template>

<style scoped>
.work-layout { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.work-list { display: grid; gap: 8px; }
.work-list button { border: 1px solid #dae1e2; background: white; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; }
.work-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.work-list span, .work-list small { color: #738180; font-size: 11px; }
.work-list .flag { font-style: normal; background: #f3e3bd; color: #7d6126; padding: 0 5px; border-radius: 8px; margin-left: 6px; }
.work-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head span { color: #71807e; font-size: 11px; }.section-head h2 { margin: 4px 0; }.section-head p { margin: 0; color: #667573; }
.conflict-box { display: grid; gap: 4px; background: #fdeceb; border: 1px solid #e0b4af; padding: 10px 12px; margin-bottom: 12px; font-size: 12px; }
.conflict-box strong { color: #a33a35; }.conflict-box span { color: #7c5d59; }.conflict-box a { color: #315b72; text-decoration: none; }
.offline-band { display: flex; justify-content: space-between; padding: 11px; border-left: 3px solid #b08735; background: #fbf6e9; font-size: 12px; }.offline-band span { color: #736d5b; }
.queue-strip { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; font-size: 11px; color: #71807e; }
.queue-strip em { font-style: normal; padding: 1px 8px; border-radius: 9px; background: #eef2f2; }
.queue-strip em.冲突, .queue-strip em.待重试 { background: #fbe0de; color: #a33a35; }
.queue-strip em.已入库 { background: #e2f0e8; color: #3d6b52; }
.action-form { display: grid; grid-template-columns: 170px 1fr 140px auto; gap: 10px; margin: 13px 0; }
.validation-message { color: #a63e38; font-size: 12px; margin-bottom: 10px; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 18px 0; }.two-column h3 { font-size: 14px; }
.record-item { border-top: 1px solid #e2e7e7; padding: 10px 0; display: grid; gap: 4px; }.record-item span, .record-item small { color: #6d7b79; font-size: 11px; }
.sync-tag { font-style: normal; font-size: 10px; padding: 0 6px; border-radius: 8px; margin-left: 8px; background: #eef2f2; color: #647370; vertical-align: middle; }
.sync-tag.已入库 { background: #e2f0e8; color: #3d6b52; }.sync-tag.冲突 { background: #fbe0de; color: #a33a35; }.sync-tag.待重试 { background: #fbe0de; color: #a33a35; }
</style>
