// store 层验证：冲突转待复核 + 复核重放（keep/adopt）+ 同设备限速操作链自动平移
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
}
globalThis.window = { addEventListener: () => {} }

const { createPinia, setActivePinia } = await import('pinia')
setActivePinia(createPinia())
const { useTrackStore, registerSyncTrigger } = await import('../src/stores/track.ts')
const { useSyncStore } = await import('../src/stores/sync.ts')
const serverMod = await import('../src/graphql/server.ts')
const { commitOp, snapshot, resetServer } = serverMod

let pass = 0
let fail = 0
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name} ${extra}`) }
}

resetServer()
const track = useTrackStore()
const sync = useSyncStore()
registerSyncTrigger(() => {})

// 场景1：两班组并发整治同一缺陷 -> 本机判冲突转待复核 -> keep 重放（双方记录并存）
{
  const defectId = 'GD-260929-02'
  track.addAction(defectId, { method: '打磨', note: '本机打磨记录', operator: '周旭', recordedAt: new Date().toISOString() })
  const myOp = track.outbox.find((o) => o.payload.action?.note === '本机打磨记录')
  assert('本机操作进入发件箱待回传', !!myOp && myOp.status === '待回传')
  assert('本机缺陷乐观更新为待复测', track.defects.find((d) => d.id === defectId).status === '待复测')

  const serverDefect = snapshot().defects.find((d) => d.id === defectId)
  const peer = {
    id: `PEER-${Date.now()}`, deviceId: '设备-peer', type: 'rectification', entityId: defectId,
    baseVersion: serverDefect.version, status: '已入库', attempts: 1, createdAt: new Date().toISOString(),
    payload: { action: { method: '更换', note: '对端更换记录', operator: '魏强', recordedAt: new Date().toISOString() }, operator: '魏强' }
  }
  assert('对端记录先入服务端', commitOp(peer).kind === 'applied')

  await sync.syncAll()
  assert('本机操作判冲突而非覆盖', myOp.status === '冲突')
  const local = track.defects.find((d) => d.id === defectId)
  assert('本机缺陷转待复核并挂冲突标记', local.status === '待复核' && !!local.conflict)
  assert('冲突原因提示版本不一致', /版本不一致/.test(myOp.conflictReason ?? ''))

  sync.resolve(myOp.id, 'keep')
  await sync.syncAll()
  const finalServer = snapshot().defects.find((d) => d.id === defectId)
  const notes = finalServer.actions.map((a) => a.note)
  assert('keep 后对端记录仍在', notes.includes('对端更换记录'))
  assert('keep 后本机记录也入库（追加而非覆盖）', notes.includes('本机打磨记录'))
  const finalLocal = track.defects.find((d) => d.id === defectId)
  assert('keep 后本机冲突标记清除', !finalLocal.conflict && finalLocal.status !== '待复核')
}

// 场景2：adopt 采用服务端，放弃本机记录
{
  serverMod._seedDefect({ id: 'GD-ADOPT-1', segmentId: 'SEG-K208', mileage: 209400, type: '高低', severity: '二级', measuredValue: 9, limit: 8, status: '整治中', owner: '二工区', discoveredAt: new Date().toISOString(), dueDate: '2026-10-10', actions: [], retests: [], version: 1 })
  track.ingestServer(snapshot())
  track.addAction('GD-ADOPT-1', { method: '捣固', note: '本机将被放弃', operator: '甲', recordedAt: new Date().toISOString() })
  const myOp = track.outbox.find((o) => o.payload.action?.note === '本机将被放弃')
  const serverDefect = snapshot().defects.find((d) => d.id === 'GD-ADOPT-1')
  commitOp({ id: `PEER-${Date.now()}`, deviceId: '设备-peer', type: 'rectification', entityId: 'GD-ADOPT-1', baseVersion: serverDefect.version, status: '已入库', attempts: 1, createdAt: new Date().toISOString(), payload: { action: { method: '测量复核', note: '对端复核', operator: '乙', recordedAt: new Date().toISOString() }, operator: '乙' } })
  await sync.syncAll()
  assert('adopt 前先判冲突', myOp.status === '冲突')
  sync.resolve(myOp.id, 'adopt')
  await sync.syncAll()
  const finalServer = snapshot().defects.find((d) => d.id === 'GD-ADOPT-1')
  assert('adopt 后服务端无本机记录', !finalServer.actions.some((a) => a.note === '本机将被放弃'))
  assert('adopt 后服务端保留对端记录', finalServer.actions.some((a) => a.note === '对端复核'))
  assert('本机操作标记已拒绝', track.outbox.find((o) => o.id === myOp.id).status === '已拒绝')
}

// 场景3：同设备限速操作链自动平移——关闭一个一级缺陷触发系统重算（区段版本+1），
// 排队中的本机限速操作不被误判冲突，仍能正常入库
{
  serverMod._seedDefect({ id: 'GD-SPEED-1', segmentId: 'SEG-K208', mileage: 209600, type: '轨距', severity: '一级', measuredValue: 1450, limit: 1446, status: '整治中', owner: '二工区', discoveredAt: new Date().toISOString(), dueDate: '2026-10-10', actions: [], retests: [], version: 1 })
  serverMod._seedDefect({ id: 'GD-SPEED-2', segmentId: 'SEG-K208', mileage: 209800, type: '方向', severity: '一级', measuredValue: 12, limit: 10, status: '整治中', owner: '二工区', discoveredAt: new Date().toISOString(), dueDate: '2026-10-10', actions: [], retests: [], version: 1 })
  track.ingestServer(snapshot())

  // 先离线关闭 GD-SPEED-1（整治+复测合格，触发本机限速预重算）
  track.addAction('GD-SPEED-1', { method: '捣固', note: '现场整治', operator: '甲', recordedAt: new Date().toISOString() })
  track.addRetest('GD-SPEED-1', { round: 1, passed: true, measuredValue: 1440, limit: 1446, note: '合格', tester: '乙', testedAt: new Date().toISOString() })
  // 再离线登记区段临时限速（基于的区段版本尚未包含系统重算）
  const seg = snapshot().segments.find((x) => x.id === 'SEG-K208')
  const result = track.updateSegmentSpeed('SEG-K208', seg.speedLimit, 150, '现场调度登记临时限速')
  assert('本机限速操作入队', result.ok)
  const speedOp = track.outbox.find((o) => o.entityId === 'SEG-K208' && o.type === 'speed' && o.status === '待回传')

  await sync.syncAll()
  assert('系统重算派生的版本递增后，本机限速操作自动平移并入库', speedOp.status === '已入库', `实际=${speedOp.status} ${speedOp.conflictReason ?? ''}`)
  const finalSeg = snapshot().segments.find((x) => x.id === 'SEG-K208')
  assert('另一项一级缺陷仍在，限速保持并取本机登记值150', finalSeg.temporarySpeedLimit === 150)
  assert('GD-SPEED-2 仍未关闭', snapshot().defects.find((d) => d.id === 'GD-SPEED-2').status === '整治中')
}

// 场景4：对端调度改了区段版本时，本机限速操作不能被自动平移，必须转冲突
{
  const segBefore = snapshot().segments.find((x) => x.id === 'SEG-K102')
  track.updateSegmentSpeed('SEG-K102', segBefore.speedLimit, 100, '本机调度调整')
  const mySpeed = track.outbox.find((o) => o.entityId === 'SEG-K102' && o.type === 'speed' && o.status === '待回传')
  const curSeg = snapshot().segments.find((x) => x.id === 'SEG-K102')
  const peer = { id: `PEER-${Date.now()}`, deviceId: '设备-peer', type: 'speed', entityId: 'SEG-K102', baseVersion: curSeg.version, status: '已入库', attempts: 1, createdAt: new Date().toISOString(), payload: { speed: curSeg.speedLimit, temporary: 110, reason: '对端调度', operator: 'peer' } }
  assert('对端区段版本先入库', commitOp(peer).kind === 'applied')
  await sync.syncAll()
  assert('本机限速操作因对端改过区段而判冲突', mySpeed.status === '冲突', `实际=${mySpeed.status}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
