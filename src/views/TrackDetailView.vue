<script setup lang="ts">
import { computed, ref } from 'vue'
import MileageCanvas from '../components/MileageCanvas.vue'
import { useTrackStore } from '../stores/track'

const store = useTrackStore()
const speed = ref(store.selectedSegment?.speedLimit ?? 160)
const temporary = ref<number | undefined>(store.selectedSegment?.temporarySpeedLimit)
const reason = ref('')
const message = ref('')
const segmentDefects = computed(() => store.defects.filter((item) => item.segmentId === store.selectedSegmentId))
const openLevel1 = computed(() => segmentDefects.value.filter((item) => item.severity === '一级' && item.status !== '已关闭' && item.status !== '待复核'))
const segmentOp = computed(() => store.pendingOf(store.selectedSegmentId)[0])

function selectSegment(id: string) {
  store.selectedSegmentId = id
  const segment = store.segments.find((item) => item.id === id)
  speed.value = segment?.speedLimit ?? 160
  temporary.value = segment?.temporarySpeedLimit
  reason.value = ''
}
function saveSpeed() {
  if (!reason.value.trim()) {
    message.value = '请填写限速调整原因，版本合并与审计需要留因'
    return
  }
  const result = store.updateSegmentSpeed(store.selectedSegmentId, speed.value, temporary.value, reason.value.trim())
  message.value = result.message
  if (result.ok) reason.value = ''
}
</script>

<template>
  <section class="page">
    <div class="split">
      <div class="segment-list">
        <button v-for="segment in store.segments" :key="segment.id" :class="{ active: segment.id === store.selectedSegmentId }" @click="selectSegment(segment.id)">
          <span>{{ segment.id }} · V{{ segment.version }}<em v-if="store.pendingOf(segment.id).length" class="pending-flag">待回传×{{ store.pendingOf(segment.id).length }}</em></span>
          <strong>{{ segment.line }}</strong>
          <small>K{{ Math.floor(segment.startMileage / 1000) }}+{{ String(segment.startMileage % 1000).padStart(3, '0') }} - K{{ Math.floor(segment.endMileage / 1000) }}+{{ String(segment.endMileage % 1000).padStart(3, '0') }}</small>
        </button>
      </div>
      <div v-if="store.selectedSegment" class="track-main">
        <div class="section-head">
          <div><span>{{ store.selectedSegment.id }}<template v-if="store.selectedSegment.conflict"> · <b class="conflict-text">待复核（版本冲突）</b></template></span><h2>{{ store.selectedSegment.line }}</h2><p>正式限速 {{ store.selectedSegment.speedLimit }} km/h · 临时限速 {{ store.selectedSegment.temporarySpeedLimit ?? '已解除' }} km/h</p></div>
          <v-chip :color="store.selectedSegment.conflict ? 'error' : 'warning'">区段版本 V{{ store.selectedSegment.version }}</v-chip>
        </div>
        <div v-if="store.selectedSegment.conflict" class="conflict-box">
          <strong>回传冲突：{{ store.selectedSegment.conflict.reason }}</strong>
          <span>服务端 V{{ store.selectedSegment.conflict.serverVersion }}，正式限速 {{ store.selectedSegment.conflict.serverSpeed }}，临时限速 {{ store.selectedSegment.conflict.serverTemp ?? '解除' }}；本机记录已挂起。</span>
          <RouterLink to="/sync">前往离线回传页裁决 →</RouterLink>
        </div>
        <MileageCanvas :segment="store.selectedSegment" :defects="segmentDefects" />
        <div class="speed-panel">
          <div>
            <strong>速度与限速联查</strong>
            <p>当前未关闭一级缺陷 <b :class="{ warn: openLevel1.length }">{{ openLevel1.length }}</b> 项<template v-if="openLevel1.length">（{{ openLevel1.map((d) => d.id).join('、') }}）</template>；关闭联动重算临时限速并留因。</p>
          </div>
          <v-text-field v-model.number="speed" type="number" label="正式限速" suffix="km/h" density="compact" variant="outlined" hide-details />
          <v-text-field v-model.number="temporary" type="number" label="临时限速（清空解除）" suffix="km/h" density="compact" variant="outlined" hide-details clearable />
          <v-btn color="primary" :disabled="!!segmentOp" @click="saveSpeed">保存速度版本</v-btn>
          <v-text-field v-model="reason" label="调整/解除原因（必填，随版本回传）" density="compact" variant="outlined" hide-details />
        </div>
        <div v-if="message" class="validation-message">{{ message }}</div>
        <div v-if="store.selectedSegment.lastSpeedReason" class="reason-trail">
          <strong>最近一次临时限速{{ store.selectedSegment.lastSpeedReason.value === undefined ? '解除' : '重算' }}</strong>
          <span>{{ store.selectedSegment.lastSpeedReason.reason }}</span>
          <small>{{ store.selectedSegment.lastSpeedReason.at.replace('T', ' ').slice(5, 16) }} · 操作 {{ store.selectedSegment.lastSpeedReason.opId }}</small>
        </div>
        <v-table density="compact">
          <thead><tr><th>关联缺陷</th><th>里程</th><th>类型</th><th>严重度</th><th>状态</th></tr></thead>
          <tbody><tr v-for="item in segmentDefects" :key="item.id"><td>{{ item.id }}</td><td>K{{ Math.floor(item.mileage / 1000) }}+{{ String(item.mileage % 1000).padStart(3, '0') }}</td><td>{{ item.type }}</td><td>{{ item.severity }}</td><td><v-chip size="small" :color="item.status === '待复核' ? 'error' : item.status === '已关闭' ? 'success' : 'warning'">{{ item.status }}</v-chip></td></tr></tbody>
        </v-table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.split { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.segment-list { display: grid; gap: 8px; }
.segment-list button { background: white; border: 1px solid #dae1e2; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; border-radius: 4px; }
.segment-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.segment-list span, .segment-list small { color: #748180; font-size: 11px; }
.pending-flag { font-style: normal; background: #f3e3bd; color: #7d6126; padding: 1px 6px; border-radius: 8px; margin-left: 8px; }
.track-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }
.section-head span { color: #738180; font-size: 11px; }.section-head h2 { margin: 4px 0; font-size: 20px; }.section-head p { margin: 0; color: #60706f; }
.conflict-text { color: #b0463c; }
.conflict-box { display: grid; gap: 4px; background: #fdeceb; border: 1px solid #e0b4af; padding: 10px 12px; margin-bottom: 12px; font-size: 12px; }
.conflict-box strong { color: #a33a35; }.conflict-box span { color: #7c5d59; }.conflict-box a { color: #315b72; text-decoration: none; }
.speed-panel { display: grid; grid-template-columns: 1.7fr 120px 150px auto 1.4fr; gap: 10px; align-items: center; margin: 14px 0; padding: 12px; background: #f4f7f7; }
.speed-panel p { margin: 4px 0 0; color: #71807f; font-size: 11px; }
.speed-panel b.warn { color: #b0463c; }
.validation-message { color: #a33a35; font-size: 12px; margin-bottom: 10px; }
.reason-trail { display: grid; gap: 3px; border-left: 3px solid #b08735; background: #fbf6e9; padding: 9px 12px; margin-bottom: 12px; font-size: 12px; }
.reason-trail strong { font-size: 12px; }.reason-trail span { color: #5f563f; }.reason-trail small { color: #93886c; }
</style>
