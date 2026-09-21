'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-');
const shortId = (id) => (id ? id.replace(/^[a-z]+_/, '').slice(0, 8) : '-');

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text || ''; }
}

function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? '即将' : `${(ms / 1000).toFixed(1)}s 后`;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------------- 创建事件 ------------------------------- */

$('#event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const errEl = $('#form-error');
  errEl.textContent = '';
  const body = {
    name: form.name.value.trim(),
    behavior: form.behavior.value,
    secret: form.secret.value.trim() || undefined,
    max_retries: Number(form.max_retries.value),
    backoff_seconds: Number(form.backoff_seconds.value),
    payload: form.payload.value.trim() || '{}',
  };
  try {
    await api('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    form.reset();
    form.max_retries.value = 3;
    form.backoff_seconds.value = 2;
    refresh();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

/* ------------------------------- 事件列表 ------------------------------- */

async function renderEvents() {
  const events = await api('/api/events');
  const box = $('#events');
  if (!events.length) {
    box.innerHTML = '<p class="muted">暂无事件，先在上方创建一个。</p>';
    return;
  }
  box.innerHTML = `<table>
    <thead><tr>
      <th>名称</th><th>目标地址</th><th>重试策略</th><th>签名密钥</th><th>投递数</th><th>操作</th>
    </tr></thead>
    <tbody>${events.map((ev) => `<tr>
      <td><strong>${esc(ev.name)}</strong></td>
      <td class="mono id-cell" title="${esc(ev.target_url)}">${esc(ev.target_url)}</td>
      <td>最多重试 ${ev.max_retries} 次 · 退避 ${ev.backoff_seconds}s ×2ⁿ</td>
      <td class="mono id-cell" title="${esc(ev.secret)}">${esc(ev.secret.slice(0, 10))}…</td>
      <td>${ev.delivery_count}</td>
      <td class="row-actions">
        <button class="small" data-deliver="${ev.id}">立即投递</button>
        <button class="small danger" data-delete="${ev.id}">删除</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;

  box.querySelectorAll('[data-deliver]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/api/events/${btn.dataset.deliver}/deliver`, { method: 'POST' });
      refresh();
    }));
  box.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('删除该事件及其全部投递记录？')) return;
      await api(`/api/events/${btn.dataset.delete}`, { method: 'DELETE' });
      refresh();
    }));
}

/* ------------------------------- 投递时间线 ------------------------------- */

const expanded = new Set();

async function renderDeliveries() {
  const deliveries = await api('/api/deliveries');
  const box = $('#deliveries');
  if (!deliveries.length) {
    box.innerHTML = '<p class="muted">暂无投递。在事件列表点击「立即投递」。</p>';
    return;
  }
  box.innerHTML = deliveries.map((d) => {
    const isOpen = expanded.has(d.id);
    return `<div class="attempt">
      <h4>
        <span class="badge ${d.status}">${statusText(d.status)}</span>
        <strong>${esc(d.event_name)}</strong>
        <span class="mono kv">#${shortId(d.id)}</span>
        <span class="kv">尝试 ${d.attempt_count}/${d.max_attempts}</span>
        ${d.status === 'pending' ? `<span class="kv">下次重试：${countdown(d.next_attempt_at)}</span>` : ''}
        <span class="kv">${fmtTime(d.created_at)}</span>
        <span class="row-actions" style="float:right">
          <button class="small ghost" data-toggle="${d.id}">${isOpen ? '收起' : '详情'}</button>
          <button class="small" data-replay="${d.id}">重放</button>
        </span>
      </h4>
      <div class="kv mono">幂等键：${esc(d.idempotency_key)}</div>
      <div data-detail="${d.id}">${isOpen ? '<p class="muted">加载中…</p>' : ''}</div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggle;
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      renderDeliveries();
    }));
  box.querySelectorAll('[data-replay]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/api/deliveries/${btn.dataset.replay}/replay`, { method: 'POST' });
      refresh();
    }));

  // 填充展开的详情
  for (const id of expanded) {
    const slot = box.querySelector(`[data-detail="${id}"]`);
    if (!slot) continue;
    try {
      const detail = await api(`/api/deliveries/${id}`);
      slot.innerHTML = renderAttempts(detail);
    } catch (err) {
      slot.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }
}

function statusText(s) {
  return { pending: '等待中', delivering: '投递中', delivered: '已送达', failed: '已失败' }[s] || s;
}

function renderAttempts(delivery) {
  if (!delivery.attempts.length) return '<p class="muted">尚未发起请求。</p>';
  return `<div class="attempts">${delivery.attempts.map((a) => `
    <div class="attempt">
      <h4>第 ${a.attempt_no} 次尝试 · ${fmtTime(a.created_at)} · ${a.duration_ms}ms
        ${a.response_status !== null
          ? `<span class="badge ${a.response_status < 300 ? 'delivered' : 'failed'}">HTTP ${a.response_status}</span>`
          : `<span class="badge failed">网络错误</span>`}
      </h4>
      <div class="kv">请求头</div><pre>${esc(prettyJson(a.request_headers))}</pre>
      <div class="kv">请求体</div><pre>${esc(prettyJson(a.request_body))}</pre>
      ${a.error
        ? `<div class="kv">错误</div><pre>${esc(a.error)}</pre>`
        : `<div class="kv">响应 ${a.response_status}</div><pre>${esc(prettyJson(a.response_body))}</pre>`}
    </div>`).join('')}
  </div>`;
}

/* ------------------------------- 接收器日志 ------------------------------- */

async function renderReceiverLog() {
  const rows = await api('/api/receiver/log');
  const box = $('#receiver-log');
  if (!rows.length) {
    box.innerHTML = '<p class="muted">暂无记录。</p>';
    return;
  }
  box.innerHTML = `<table>
    <thead><tr>
      <th>时间</th><th>事件</th><th>行为</th><th>签名</th><th>幂等键</th><th>备注</th>
    </tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="mono">${fmtTime(r.created_at)}</td>
      <td>${esc(r.event_name || '-')}</td>
      <td>${esc(r.behavior || '-')}</td>
      <td>${r.signature_valid ? '<span class="badge sig-ok">✓ 有效</span>' : '<span class="badge sig-bad">✗ 无效</span>'}</td>
      <td class="mono id-cell" title="${esc(r.idempotency_key)}">${esc(shortId(r.idempotency_key))}</td>
      <td>${r.duplicate ? '<span class="badge dup">重复投递，已去重</span>' : ''}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

$('#clear-log').addEventListener('click', async () => {
  await api('/api/receiver/log', { method: 'DELETE' });
  refresh();
});

/* --------------------------------- 轮询 --------------------------------- */

function refresh() {
  renderEvents().catch(console.error);
  renderDeliveries().catch(console.error);
  renderReceiverLog().catch(console.error);
}

refresh();
setInterval(refresh, 2000);
