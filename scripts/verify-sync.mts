// 端到端逻辑验证：离线回传 / 版本冲突 / 失败保留重试 / 关闭联动限速重算
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
}
globalThis.window = { addEventListener: () => {} }

const { commitOp, setForceFail, snapshot, resetServer, _seedDefect } = await import('../src/graphql/server.ts')

let pass = 0
let fail = 0
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name} ${extra}`) }
}
function makeOp(over) {
  return { id: `T-${Math.random().toString(36).slice(2)}`, deviceId: '设备-A', status: '待回传', attempts: 0, createdAt: new Date().toISOString(), payload: {}, ...over }
}

// 场景1：断网期间现场两条操作留本机，恢复后逐条入库，版本递增
resetServer()
let s = snapshot()
const d1 = s.defects.find((d) => d.id === 'GD-260929-01')
const baseV = d1.version
const op1 = makeOp({ type: 'rectification', entityId: d1.id, baseVersion: baseV, payload: { action: { method: '垫板调整', note: '现场垫板', operator: '李海', recordedAt: new Date().toISOString() }, operator: '李海' } })
const op2 = makeOp({ type: 'retest', entityId: d1.id, baseVersion: baseV + 1, payload: { retest: { round: 1, passed: true, measuredValue: 1440, limit: 1446, note: '合格', tester: '王磊', testedAt: new Date().toISOString() }, operator: '王磊' } })
setForceFail(true)
let r1
try { commitOp(op1); throw new Error('应当抛网络错误') } catch (e) { r1 = e }
assert('断网时 commitOp 抛错且未入库', /网络/.test(r1.message) && snapshot().defects.find((d) => d.id === d1.id).version === baseV)
setForceFail(false)
r1 = commitOp(op1)
assert('恢复后整治操作入库', r1.kind === 'applied' && snapshot().defects.find((d) => d.id === d1.id).version === baseV + 1)
const r2 = commitOp(op2)
assert('复测合格入库并关闭缺陷', r2.kind === 'applied' && snapshot().defects.find((d) => d.id === d1.id).status === '已关闭')

// 场景2：两个班组同时提交同一缺陷，后到的不覆盖，判冲突
resetServer()
s = snapshot()
const d2 = s.defects.find((d) => d.id === 'GD-260929-01')
const peer = makeOp({ deviceId: '设备-peer', type: 'rectification', entityId: d2.id, baseVersion: d2.version, payload: { action: { method: '更换', note: '对端先到', operator: '魏强', recordedAt: new Date().toISOString() }, operator: '魏强' } })
const rp = commitOp(peer)
assert('对端班组先提交成功', rp.kind === 'applied')
const mine = makeOp({ type: 'rectification', entityId: d2.id, baseVersion: d2.version, payload: { action: { method: '捣固', note: '本机后到', operator: '李海', recordedAt: new Date().toISOString() }, operator: '李海' } })
const rm = commitOp(mine)
assert('本机旧版本提交被判冲突而非覆盖', rm.kind === 'conflict' && rm.serverVersion === d2.version + 1)
assert('服务端保留对端记录（后到未覆盖）', snapshot().defects.find((d) => d.id === d2.id).actions[0].note === '对端先到')

// 场景3：同步失败后已入库部分保留
resetServer()
s = snapshot()
const d3 = s.defects.find((d) => d.id === 'GD-260929-01')
const a = makeOp({ type: 'rectification', entityId: d3.id, baseVersion: d3.version, payload: { action: { method: '打磨', note: '第一条成功', operator: '甲', recordedAt: new Date().toISOString() }, operator: '甲' } })
assert('第一条入库', commitOp(a).kind === 'applied')
setForceFail(true)
const b = makeOp({ type: 'retest', entityId: d3.id, baseVersion: d3.version + 1, payload: { retest: { round: 1, passed: false, measuredValue: 9, limit: 8, note: '网络失败条', tester: '乙', testedAt: new Date().toISOString() }, operator: '乙' } })
let rb
try { commitOp(b); throw new Error('应失败') } catch (e) { rb = e }
setForceFail(false)
assert('第二条网络失败', /网络/.test(rb.message))
assert('第一条入库结果仍然保留（未回滚）', snapshot().defects.find((d) => d.id === d3.id).actions[0].note === '第一条成功')
const b2 = makeOp({ ...b, id: b.id + '-retry', baseVersion: d3.version + 1 })
assert('失败条恢复后重试成功', commitOp(b2).kind === 'applied')

// 场景4：一级缺陷关闭 -> 临时限速重算并留原因；区段版本递增
resetServer()
s = snapshot()
const seg = s.segments.find((x) => x.id === 'SEG-K102')
const beforeV = seg.version
assert('K102 初始有未关闭一级缺陷且临时限速120', seg.temporarySpeedLimit === 120)
const d4 = snapshot().defects.find((d) => d.id === 'GD-260929-01')
const closeOps = []
// 先补整治再复测合格
const rect = makeOp({ type: 'rectification', entityId: d4.id, baseVersion: d4.version, payload: { action: { method: '捣固', note: '整治', operator: '甲', recordedAt: new Date().toISOString() }, operator: '甲' } })
commitOp(rect)
const afterRect = snapshot().defects.find((d) => d.id === d4.id)
const retest = makeOp({ type: 'retest', entityId: d4.id, baseVersion: afterRect.version, payload: { retest: { round: 1, passed: true, measuredValue: 1440, limit: 1446, note: '合格', tester: '乙', testedAt: new Date().toISOString() }, operator: '乙' } })
const rr = commitOp(retest)
const segAfter = snapshot().segments.find((x) => x.id === 'SEG-K102')
assert('复测合格关闭一级缺陷', rr.kind === 'applied' && rr.recalc)
assert('临时限速因一级缺陷清零而解除', segAfter.temporarySpeedLimit === undefined)
assert('区段版本在关闭联动重算后递增', segAfter.version === beforeV + 1)
assert('重算原因留痕', /一级缺陷已全部关闭/.test(segAfter.lastSpeedReason?.reason ?? ''))
assert('审计包含临时限速解除记录', snapshot().audit.some((a) => a.action === '临时限速解除'))

// 场景5：仍有一级缺陷时关闭别的缺陷不会解除限速（内存权威库直接追加一项一级缺陷）
resetServer()
_seedDefect({ id: 'GD-X1', segmentId: 'SEG-K102', mileage: 103000, type: '方向', severity: '一级', measuredValue: 10, limit: 8, status: '整治中', owner: '工区', discoveredAt: new Date().toISOString(), dueDate: '2026-10-10', actions: [], retests: [], version: 1 })
{
  const d = snapshot().defects.find((x) => x.id === 'GD-260929-01')
  const rect = makeOp({ type: 'rectification', entityId: d.id, baseVersion: d.version, payload: { action: { method: '捣固', note: '整治', operator: '甲', recordedAt: new Date().toISOString() }, operator: '甲' } })
  commitOp(rect)
  const d2x = snapshot().defects.find((x) => x.id === d.id)
  const retest = makeOp({ type: 'retest', entityId: d.id, baseVersion: d2x.version, payload: { retest: { round: 1, passed: true, measuredValue: 1440, limit: 1446, note: '合格', tester: '乙', testedAt: new Date().toISOString() }, operator: '乙' } })
  const rr = commitOp(retest)
  const seg2 = snapshot().segments.find((x) => x.id === 'SEG-K102')
  assert('仍有一级缺陷时保持（重算）临时限速', seg2.temporarySpeedLimit !== undefined && rr.recalc?.value !== undefined)
  assert('原因列出剩余一级缺陷', /GD-X1/.test(seg2.lastSpeedReason?.reason ?? ''))
}

// 场景6：区段版本并发冲突
resetServer()
{
  const seg = snapshot().segments.find((x) => x.id === 'SEG-K208')
  const peer = makeOp({ deviceId: '设备-peer', type: 'speed', entityId: seg.id, baseVersion: seg.version, payload: { speed: 200, temporary: 160, reason: '对端调度', operator: 'peer' } })
  assert('对端限速版本先入库', commitOp(peer).kind === 'applied')
  const mine = makeOp({ type: 'speed', entityId: seg.id, baseVersion: seg.version, payload: { speed: 200, temporary: 180, reason: '本机调度', operator: 'me' } })
  const rm = commitOp(mine)
  assert('本机区段旧版本提交判冲突', rm.kind === 'conflict' && rm.serverSpeed === 200 && rm.serverTemp === 160)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
