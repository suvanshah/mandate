import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const packs = JSON.parse(readFileSync(new URL('../policies/packs.json', import.meta.url)));
export const frameworks = JSON.parse(readFileSync(new URL('../policies/frameworks.json', import.meta.url)));
export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
export function decimal(value, places = 2) {
  if (typeof value !== 'string' || !new RegExp(`^\\d{1,9}(?:\\.\\d{1,${places}})?$`).test(value)) throw new InputError(`Use a positive decimal string with at most ${places} decimal places.`);
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
  if (units <= 0n) throw new InputError('Amounts must be greater than zero.');
  return units;
}
const money = units => `${units / 100n}.${String(units % 100n).padStart(2, '0')}`;
const now = () => new Date().toISOString();
function parameters(kind, input) {
  const expected = Object.keys(packs[kind].defaultParameters);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !expected.includes(k)) || expected.some(k => !(k in input))) throw new InputError('Parameters must match this agent’s action schema.');
  if (kind === 'treasury') {
    decimal(input.amount);
    if (input.currency !== 'GBP' || input.source !== 'acct-demo-2041' || typeof input.destination !== 'string' || !/^beneficiary-demo-\d{4}$/.test(input.destination)) throw new InputError('Invalid treasury parameters.');
  } else {
    decimal(input.quantity, 8); decimal(input.limitPrice);
    if (!['BUY', 'SELL'].includes(input.side) || input.type !== 'LIMIT' || input.quoteAsset !== 'USDT' || typeof input.symbol !== 'string' || !/^[A-Z]{3,12}USDT$/.test(input.symbol)) throw new InputError('Invalid spot order parameters.');
  }
  return Object.fromEntries(expected.map(k => [k, input[k]]));
}
export class Mandate {
  constructor(state = null) {
    this.state = state ? copy(state) : { version: 1, requests: {}, agents: { treasury: { verified: false }, binance: { withdrawalsEnabled: true } }, events: [] };
    if (!this.verifyEvidence()) throw new Error('Evidence chain verification failed. Restore a valid data file.');
    if (!state) for (const kind of Object.keys(packs)) { const req = this.createRequest(kind, packs[kind].defaultParameters); this.attempt(req.id); }
  }
  record(type, requestId, data) {
    const previousHash = this.state.events.at(-1)?.hash ?? '0'.repeat(64);
    const entry = { sequence: this.state.events.length + 1, timestamp: now(), type, requestId, data: copy(data), previousHash };
    const result = { ...entry, hash: hash(entry) }; this.state.events.push(result); return result;
  }
  verifyEvidence() {
    let previous = '0'.repeat(64), sequence = 0;
    return this.state.events.every(event => { const { hash: digest, ...body } = event; const valid = body.previousHash === previous && body.sequence === ++sequence && hash(body) === digest; previous = digest; return valid; });
  }
  get(id) { const req = this.state.requests[id]; if (!req) throw new InputError('Request not found.', 404); return req; }
  fingerprint(req) { return hash({ agentId: packs[req.kind].agentId, action: req.action, parameters: req.parameters, policy: `${packs[req.kind].id}/${packs[req.kind].version}` }); }
  createRequest(kind, input, action = packs[kind]?.action) {
    if (!Object.hasOwn(packs, kind)) throw new InputError('Unknown agent.');
    if (action !== packs[kind].action) throw new InputError('Action is outside this agent’s mandate.', 403);
    const req = { id: randomUUID(), kind, action, parameters: parameters(kind, input), approval: null, execution: null, createdAt: now(), revision: 1 };
    this.state.requests[req.id] = req; this.record('request.created', req.id, { actor: packs[kind].agentId, parameters: req.parameters, policyVersion: packs[kind].version }); return copy(req);
  }
  update(id, input) {
    const req = this.get(id); if (req.execution) throw new InputError('Executed requests cannot be edited. Create a new request.', 409);
    req.parameters = parameters(req.kind, input); req.approval = null; req.revision++;
    this.record('request.updated', id, { actor: packs[req.kind].agentId, parameters: req.parameters, revision: req.revision, approvalInvalidated: true }); return this.view(id);
  }
  notional(req) { return req.kind === 'treasury' ? decimal(req.parameters.amount) : (decimal(req.parameters.quantity, 8) * decimal(req.parameters.limitPrice) + 99999999n) / 100000000n; }
  dailyUsed() {
    const today = now().slice(0, 10);
    return Object.values(this.state.requests).filter(r => r.kind === 'binance' && r.execution?.timestamp.startsWith(today)).reduce((total, r) => total + this.notional(r), decimal(packs.binance.baselineDailyUsed));
  }
  evaluate(id) {
    const req = this.get(id), pack = packs[req.kind], amount = this.notional(req), resource = req.kind === 'treasury' ? req.parameters.destination : req.parameters.symbol;
    const inScope = pack.allowedResources.includes(resource), requiresApproval = amount > decimal(pack.approvalAbove);
    const validApproval = !!req.approval && req.approval.fingerprint === this.fingerprint(req) && req.approval.actor !== pack.agentId;
    const scopeReady = req.kind === 'treasury' ? this.state.agents.treasury.verified : !this.state.agents.binance.withdrawalsEnabled;
    const daily = req.kind !== 'binance' || req.execution || this.dailyUsed() + amount <= decimal(pack.dailyLimit);
    const checks = [
      { id: req.kind === 'treasury' ? 'BEN-001' : 'KEY-001', kind: 'scope', label: req.kind === 'treasury' ? 'Verified beneficiary' : 'Withdrawals disabled', pass: inScope && scopeReady, reason: !inScope ? `Resource ${resource} is outside the approved list.` : scopeReady ? 'Required control evidence is present.' : req.kind === 'treasury' ? 'Independent beneficiary verification is missing.' : 'Demo trading key permits withdrawals.' },
      { id: 'APR-002', kind: 'approval', label: 'Independent approval', pass: !requiresApproval || validApproval, reason: !requiresApproval ? `Below the ${pack.approvalAbove} ${pack.currency} approval threshold.` : validApproval ? 'Approval matches the exact action fingerprint.' : `Above ${pack.approvalAbove} ${pack.currency}; exact-action approval is missing.` },
      { id: 'LIM-003', kind: 'limits', label: 'Activity limits', pass: amount <= decimal(pack.maxAmount) && !!daily, reason: amount > decimal(pack.maxAmount) ? `Notional ${money(amount)} exceeds ${pack.maxAmount} ${pack.currency} per action.` : !daily ? `Daily activity would exceed ${pack.dailyLimit} USDT.` : `Notional ${money(amount)} is within policy limits.` },
      { id: 'IAM-004', kind: 'scope', label: 'Controlled execution', pass: req.action === pack.action, reason: 'Mock adapter is invoked only by the policy engine. No real credentials exist.' }
    ];
    return { allowed: checks.every(c => c.pass), checks, notional: money(amount), currency: pack.currency, fingerprint: this.fingerprint(req), policy: `${pack.id}/${pack.version}`, mappingVersion: frameworks.version };
  }
  remediate(id) {
    const req = this.get(id); if (req.execution) throw new InputError('Request already executed.', 409);
    if (req.kind === 'treasury') { if (!packs.treasury.allowedResources.includes(req.parameters.destination)) throw new InputError('Cannot verify a destination outside the policy allowlist.', 403); this.state.agents.treasury.verified = true; }
    else this.state.agents.binance.withdrawalsEnabled = false;
    this.record('control.remediated', id, { actor: 'demo-operations', control: req.kind === 'treasury' ? 'BEN-001' : 'KEY-001', simulation: true }); return this.view(id);
  }
  approve(id, actor = 'demo-treasury-approver') {
    const req = this.get(id); if (req.execution) throw new InputError('Request already executed.', 409);
    const expected = req.kind === 'treasury' ? 'demo-treasury-approver' : 'demo-trading-approver';
    if (actor !== expected) throw new InputError('This demo role cannot approve this agent’s actions.', 403);
    if (this.evaluate(id).checks.some(c => !c.pass && c.id !== 'APR-002')) throw new InputError('Resolve other policy failures before approval.', 409);
    req.approval = { actor, fingerprint: this.fingerprint(req), timestamp: now(), simulation: true };
    this.record('action.approved', id, req.approval); return this.view(id);
  }
  attempt(id) {
    const req = this.get(id); if (req.execution) return { ...this.view(id), replay: true };
    const evaluation = this.evaluate(id);
    if (evaluation.allowed) req.execution = { receipt: `SIM-${randomUUID()}`, timestamp: now(), adapter: packs[req.kind].adapter, simulation: true };
    this.record(evaluation.allowed ? 'action.executed_simulated' : 'action.blocked', id, { ...evaluation, parameters: req.parameters, approval: req.approval, execution: req.execution, actor: 'mandate-gateway', frameworkReferences: frameworks });
    return this.view(id);
  }
  view(id) { const req = this.get(id); return { ...copy(req), evaluation: this.evaluate(id), events: copy(this.state.events.filter(e => e.requestId === id)) }; }
  list() { return { simulation: true, packs, frameworks, requests: Object.keys(this.state.requests).map(id => this.view(id)), agents: copy(this.state.agents), evidenceValid: this.verifyEvidence(), dailyUsed: money(this.dailyUsed()) }; }
  evidence(id) { return { application: 'Mandate', simulation: true, exportedAt: now(), mappingStatus: frameworks.status, request: this.view(id), chainVerified: this.verifyEvidence(), chainHead: this.state.events.at(-1)?.hash, fullLedger: copy(this.state.events), limitations: ['Demo roles are simulated; no production authentication.', 'Hash chaining detects edits only relative to a trusted chain head; it is not a signature or external timestamp.', 'Framework references are proposed supporting mappings, not certification.'] }; }
}
