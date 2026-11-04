const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state, kind = 'treasury', requestId, framework = 'csf', activeCheck = 'APR-002', tab = 'overview', busy = false;
const current = () => state.requests.find(r => r.id === requestId);
const pack = () => state.packs[kind];
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Mandate-Token': state.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
async function refresh() { state = await api('/api/state'); if (!state.requests.some(r => r.id === requestId && r.kind === kind)) requestId = state.requests.filter(r => r.kind === kind).at(-1).id; render(); }
async function action(fn) {
  if (busy) return; busy = true; $('error').hidden = true; setBusy(true);
  try { await fn(); await refresh(); } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
  finally { busy = false; if (state) render(); }
}
function setBusy(value) { for (const id of ['new-request', 'remediate', 'approve', 'attempt', 'agent']) $(id).disabled = value; }
function changeTab(value) { tab = value; document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); for (const id of ['overview', 'evidence', 'integration']) $(id).hidden = id !== tab; }
const labels = { 'request.created': 'Agent proposed a new action', 'request.updated': 'Action changed; prior approval invalidated', 'control.remediated': 'Required control evidence recorded', 'action.approved': 'Independent approval recorded', 'action.blocked': 'Action blocked before API submission', 'action.executed_simulated': 'Mock adapter accepted the action' };
function eventsHTML(events) { return events.map(e => `<div class="event"><span class="event-time">${escape(new Date(e.timestamp).toLocaleTimeString('en-GB'))}</span><span>${escape(labels[e.type] || e.type)}<span class="event-meta">${escape(e.data.actor || 'Mandate gateway')}${e.data.checks ? ' · ' + escape(e.data.checks.filter(c => !c.pass).map(c => c.id).join(', ') || 'All checks passed') : ''}</span></span><span class="event-type">${escape(e.type)}<br>#${e.sequence}</span></div>`).join(''); }
function field(name, label, value, options = null) { return `<label>${escape(label)}${options ? `<select name="${name}">${options.map(o => `<option${value === o ? ' selected' : ''}>${escape(o)}</option>`).join('')}</select>` : `<input name="${name}" value="${escape(value)}" required inputmode="${['amount', 'quantity', 'limitPrice'].includes(name) ? 'decimal' : 'text'}" autocomplete="off">`}</label>`; }
function renderMapping() {
  const req = current(), c = req.evaluation.checks.find(c => c.id === activeCheck) || req.evaluation.checks[0], f = state.frameworks[framework], m = f.mappings[c.kind];
  $('mapping').innerHTML = `<div><span class="eyebrow">${framework === 'iso' ? 'THEMATIC REFERENCE · REVIEW PENDING' : 'PROPOSED SUPPORTING MAPPING'}</span><div class="map-ref">${escape(f.name)} / ${escape(m.reference)}</div><div>${escape(m.title)}</div><p class="map-description">${escape(m.rationale)}</p><a class="small" href="${escape(f.source)}" target="_blank" rel="noopener noreferrer">Official framework reference ↗</a></div><div><span class="eyebrow">COMPANY CONTROL · ${escape(c.id)}</span><div class="map-ref">${escape(c.label)} · <span class="${c.pass ? 'pass' : 'fail'}">${c.pass ? 'Pass' : 'Fail'}</span></div><p class="map-description">Owner: ${escape(pack().owner)}<br>Policy: ${escape(req.evaluation.policy)}<br>Evidence: ${escape(c.reason)}</p></div>`;
}
function evidenceBundle() { return { application: 'Mandate', simulation: true, request: current(), fullLedger: state.requests.flatMap(r => r.events).sort((a,b) => a.sequence-b.sequence), chainVerified: state.evidenceValid, mappingVersion: state.frameworks.version, mappingStatus: state.frameworks.status }; }
function render() {
  const req = current(), p = pack(), ev = req.evaluation, failures = ev.checks.filter(c => !c.pass), executed = !!req.execution;
  $('loading').hidden = true; $('agent').value = kind; $('framework').value = framework;
  $('title').textContent = kind === 'treasury' ? 'A transfer with boundaries.' : 'An order within its mandate.';
  $('subtitle').textContent = 'Every action checked. Every decision recorded.';
  $('flow-agent').textContent = p.name; $('flow-adapter').textContent = kind === 'treasury' ? 'Mock bank' : 'Mock Binance Spot';
  $('verdict').className = ev.allowed ? 'good' : '';
  $('verdict').innerHTML = `<span class="verdict-icon">${ev.allowed ? '✓' : '!'}</span><div><div class="verdict-title">${executed ? 'Executed in simulation' : ev.allowed ? 'Authorised · ready to execute' : `Blocked · ${failures.length} policy failure${failures.length === 1 ? '' : 's'}`}</div><div class="verdict-detail">${escape(executed ? 'Mock receipt recorded. Retrying this request cannot execute it twice.' : ev.allowed ? 'Approval matches the exact action. Policy will be rechecked at execution.' : 'No adapter call made. ' + failures.map(c => c.id + ': ' + c.label).join(' · '))}</div></div>`;
  $('action-type').textContent = req.action;
  $('amount').textContent = kind === 'treasury' ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(ev.notional)) : new Intl.NumberFormat('en-GB').format(Number(ev.notional)) + ' USDT';
  $('amount-detail').textContent = kind === 'treasury' ? 'Working capital · UK subsidiary' : `${req.parameters.side} ${req.parameters.quantity} ${req.parameters.symbol} · synthetic limit price`;
  const rows = [['Agent', p.agentId], ...(kind === 'treasury' ? [['From', 'Group operating · •• 2041'], ['Beneficiary', req.parameters.destination]] : [['Market', req.parameters.symbol + ' · spot only'], ['Limit price', req.parameters.limitPrice + ' USDT']]), ['Policy pack', ev.policy], ['Policy owner', p.owner], ['Revision', req.revision], ['Request', req.id.slice(0, 8)]];
  $('request-meta').innerHTML = rows.map(([a,b]) => `<div><dt>${escape(a)}</dt><dd>${escape(b)}</dd></div>`).join('');
  $('fields').innerHTML = kind === 'treasury' ? field('amount', 'Amount (GBP)', req.parameters.amount) + field('destination', 'Beneficiary', req.parameters.destination, ['beneficiary-demo-8832', 'beneficiary-demo-9999']) : field('symbol', 'Trading pair', req.parameters.symbol, ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT']) + field('side', 'Side', req.parameters.side, ['BUY', 'SELL']) + field('quantity', 'Quantity', req.parameters.quantity) + field('limitPrice', 'Limit price (USDT)', req.parameters.limitPrice);
  $('edit-form').querySelector('button').disabled = executed || busy;
  $('agent-quote').textContent = kind === 'treasury' ? '“Fund next week’s subsidiary payments.”' : '“Propose a portfolio rebalancing order within the approved policy.”';
  $('checks-count').textContent = `${ev.checks.filter(c => c.pass).length} / ${ev.checks.length} passed`;
  $('checks').innerHTML = ev.checks.map(c => `<button type="button" class="check" data-check="${escape(c.id)}" aria-pressed="${activeCheck === c.id}"><span class="check-code">${escape(c.id)}</span><span class="check-heading"><span>${escape(c.label)}</span><span class="${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓ Pass' : '× Fail'}</span></span><span class="check-reason">${escape(c.reason)}</span></button>`).join('');
  $('checks').querySelectorAll('[data-check]').forEach(b => b.onclick = () => { activeCheck = b.dataset.check; render(); });
  const remedied = kind === 'treasury' ? state.agents.treasury.verified : !state.agents.binance.withdrawalsEnabled;
  $('remediate').textContent = kind === 'treasury' ? remedied ? 'Beneficiary verified' : 'Verify beneficiary' : remedied ? 'Withdrawals disabled' : 'Disable withdrawals';
  setBusy(busy); $('remediate').disabled = busy || remedied || executed;
  $('approve').disabled = busy || executed || !!req.approval || ev.checks.some(c => !c.pass && c.id !== 'APR-002');
  $('approve').textContent = req.approval ? 'Action approved' : 'Approve exact action';
  $('attempt').disabled = busy || executed; $('attempt').textContent = executed ? 'Completed ✓' : ev.allowed ? 'Execute in simulation →' : 'Retry action →';
  $('approval-detail').textContent = req.approval ? `Demo approver: ${req.approval.actor} · fingerprint ${req.approval.fingerprint.slice(0,12)}…` : 'Approval binds the agent, action, parameters and policy version.';
  renderMapping(); $('timeline').innerHTML = eventsHTML(req.events);
  $('ledger').innerHTML = eventsHTML(evidenceBundle().fullLedger);
  $('chain-status').textContent = `${state.evidenceValid ? '✓ Evidence chain verified' : 'Evidence verification failed'} · ${evidenceBundle().fullLedger.length} records across all requests`;
  $('evidence-json').textContent = JSON.stringify(evidenceBundle(), null, 2);
  $('profile-json').textContent = JSON.stringify({ agentId:p.agentId, owner:p.owner, adapter:p.adapter, policyPack:ev.policy, capabilities:{ allow:p.allow, requirePolicyCheck:p.guarded, deny:p.deny }, unknownActions:'deny', credentialCustody:'no live credentials — mock adapters only', inputSchema:Object.keys(p.defaultParameters), frameworkMappingVersion:state.frameworks.version }, null, 2);
  changeTab(tab);
}
function download() { window.location.assign(`/api/requests/${requestId}/evidence`); }
$('agent').onchange = () => { kind = $('agent').value; requestId = state.requests.filter(r => r.kind === kind).at(-1).id; activeCheck = 'APR-002'; $('error').hidden = true; render(); };
$('framework').onchange = () => { framework = $('framework').value; renderMapping(); };
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => changeTab(b.dataset.tab));
$('remediate').onclick = () => action(() => api(`/api/requests/${requestId}/remediate`, 'POST', {}));
$('approve').onclick = () => action(() => api(`/api/requests/${requestId}/approve`, 'POST', { actor: kind === 'treasury' ? 'demo-treasury-approver' : 'demo-trading-approver' }));
$('attempt').onclick = () => action(() => api(`/api/requests/${requestId}/attempt`, 'POST', {}));
$('new-request').onclick = () => action(async () => { const req = await api('/api/requests', 'POST', { kind, action:pack().action, parameters:pack().defaultParameters }); requestId = req.id; tab = 'overview'; });
$('edit-form').onsubmit = event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.target)); const parameters = { ...current().parameters, ...values }; action(() => api(`/api/requests/${requestId}`, 'PUT', { parameters })); };
$('download').onclick = download; $('download-overview').onclick = download;
refresh().catch(error => { $('loading').hidden = true; $('error').textContent = error.message; $('error').hidden = false; });
