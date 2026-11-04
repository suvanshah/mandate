import test from 'node:test';
import assert from 'node:assert/strict';
import { Mandate, packs, decimal } from '../src/engine.js';
const setup = kind => { const engine = new Mandate(); const request = engine.list().requests.find(r => r.kind === kind); return { engine, request }; };
for (const kind of ['treasury', 'binance']) {
  test(`${kind}: blocked → remediated → approved → executed, with immutable failed evidence`, () => {
    const { engine:e, request:r } = setup(kind), actor = kind === 'treasury' ? 'demo-treasury-approver' : 'demo-trading-approver';
    assert.equal(e.attempt(r.id).execution, null);
    assert.throws(() => e.approve(r.id, actor), /Resolve/);
    e.remediate(r.id); assert.equal(e.view(r.id).evaluation.allowed, false);
    e.approve(r.id, actor); assert.equal(e.view(r.id).evaluation.allowed, true);
    const executed = e.attempt(r.id), eventCount = e.state.events.length;
    assert.ok(executed.execution.receipt.startsWith('SIM-'));
    assert.equal(e.attempt(r.id).execution.receipt, executed.execution.receipt);
    assert.equal(e.state.events.length, eventCount);
    assert.equal(e.evidence(r.id).chainVerified, true);
    assert.ok(e.view(r.id).events.find(v => v.type === 'action.blocked').data.checks.some(c => !c.pass));
    assert.throws(() => e.update(r.id, r.parameters), /cannot be edited/);
  });
}
test('editing any parameter invalidates approval; over-limit actions remain blocked', () => {
  const {engine:e,request:r}=setup('treasury'); e.remediate(r.id); e.approve(r.id);
  const old = e.get(r.id).approval.fingerprint;
  e.update(r.id, {...r.parameters, amount:'80000.00'});
  assert.equal(e.get(r.id).approval,null); assert.notEqual(e.evaluate(r.id).fingerprint,old);
  assert.equal(e.attempt(r.id).execution,null);
  e.update(r.id,{...r.parameters,amount:'100000.01'});
  assert.equal(e.evaluate(r.id).checks.find(c=>c.id==='LIM-003').pass,false);
  assert.throws(()=>e.approve(r.id),/Resolve/);
});
test('roles and unsupported capabilities fail closed', () => {
  const {engine:e,request:r}=setup('treasury'); e.remediate(r.id);
  assert.throws(()=>e.approve(r.id,'treasury-agent-01'),/role/);
  assert.throws(()=>e.approve(r.id,'demo-trading-approver'),/role/);
  assert.throws(()=>e.createRequest('treasury',r.parameters,'withdrawal.create'),/outside/);
  assert.throws(()=>e.createRequest('__proto__',{}),/Unknown/);
  e.update(r.id,{...r.parameters,destination:'beneficiary-demo-9999'});
  assert.throws(()=>e.remediate(r.id),/allowlist/);
  assert.equal(e.evaluate(r.id).allowed,false);
});
test('daily trading limit accumulates across requests and is rechecked after approval', () => {
  const {engine:e,request:r}=setup('binance'); e.remediate(r.id);
  const other=e.createRequest('binance',packs.binance.defaultParameters);
  e.approve(r.id,'demo-trading-approver'); e.approve(other.id,'demo-trading-approver');
  assert.ok(e.attempt(r.id).execution);
  assert.equal(e.attempt(other.id).execution,null);
  assert.equal(e.evaluate(other.id).checks.find(c=>c.id==='LIM-003').pass,false);
});
test('schema, precision, non-finite and negative values are rejected', () => {
  const {engine:e,request:r}=setup('treasury');
  for(const amount of ['0','-1','NaN','Infinity','1e5','2.001',500]) assert.throws(()=>e.update(r.id,{...r.parameters,amount}));
  assert.throws(()=>e.update(r.id,{...r.parameters,approval:true}),/schema/);
  assert.equal(decimal('25000.01'),2500001n);
});
test('evidence mutation is detected, snapshots survive serialization', () => {
  const e=new Mandate(),state=JSON.parse(JSON.stringify(e.state));
  assert.equal(new Mandate(state).verifyEvidence(),true);
  state.events[0].data.parameters.amount='1.00';
  assert.throws(()=>new Mandate(state),/verification failed/);
});
