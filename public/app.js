'use strict';

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const view = $('#view');

let role = null;
let state = null;
let route = { tab: 'accounts', id: null };
let pollTimer = null;
let tick = 0;

const isAdmin = () => role === 'admin';
const workshopUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET' && method !== 'DELETE') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(url, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    // empty body
  }
  if (res.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error('Signed out');
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}

const tz = () => state?.timezone || 'UTC';
function fmtTime(ts) {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz(), dateStyle: 'short', timeStyle: 'short' }).format(ts);
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }
}
function fmtDate(ts) {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz(), dateStyle: 'medium' }).format(ts);
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}
function ago(ts) {
  if (!ts) return '—';
  const d = Math.round((Date.now() - ts) / 1000);
  const abs = Math.abs(d);
  const s = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 172800 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} days`;
  return d >= 0 ? `${s} ago` : `in ${s}`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Bytes as KB/MB/GB; unknown sizes (Steam reported none) show as a dash. */
function fmtSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n >= 100 || u === 0 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
}
/** A total with a note when some items have no size from Steam (yet). */
const sizeTotal = (bytes, unsized) => `${fmtSize(bytes)}${unsized ? ` <span class="small muted" title="Steam gave no size for these (yet)">+${unsized} unknown</span>` : ''}`;

const ACCOUNT_STATUS = {
  ok: ['ok', 'OK'], new: ['dim', 'New'], error: ['bad', 'Error'], rate_limited: ['warn', 'Rate limited'],
  login_wait: ['warn', 'Waiting to log in'], bad_credentials: ['bad', 'Wrong password'], needs_signin: ['warn', 'Needs sign-in'],
  disabled: ['dim', 'Disabled'],
};
const GROUP_STATE = {
  setup: ['dim', 'Not started'], scanning: ['', 'Reading lists'], preview: ['warn', 'Waiting for confirmation'],
  active: ['ok', 'Active'], paused: ['dim', 'Paused'],
};
const ITEM_STATE = { active: ['ok', 'Synced'], blocked: ['bad', 'Blocked'], removing: ['warn', 'Removing'], removed: ['dim', 'Removed'] };
const badge = (map, key) => {
  const [cls, label] = map[key] ?? ['dim', key];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
/** Opens the shared dialog. onSubmit(formData, buttonValue, form) may return true to keep it open. */
function openDialog(html, onSubmit, onClose) {
  const dlg = $('#dialog');
  const form = $('#dialogForm');
  form.innerHTML = html;
  form.onclick = null;
  // Not submit buttons: Enter belongs to the form's main button, and Cancel has to work on an unfinished form.
  $$('button[value=cancel]', form).forEach((b) => {
    b.type = 'button';
    b.onclick = () => dlg.close();
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    if (!btn) return dlg.close();
    const err = $('[data-error]', form);
    if (err) err.textContent = '';
    btn.disabled = true;
    try {
      const keep = await onSubmit(new FormData(form), btn.value, form);
      if (keep !== true) dlg.close();
    } catch (ex) {
      if (err) err.textContent = ex.message;
      else toast(ex.message, true);
    } finally {
      btn.disabled = false;
    }
  };
  dlg.onclose = () => onClose?.();
  dlg.showModal();
  return form;
}

function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    openDialog(`<h2>${esc(title)}</h2><p class="wrap">${esc(text)}</p>
      <div class="buttons"><button value="cancel">Cancel</button><button value="ok" class="${danger ? 'primary danger' : 'primary'}">${esc(okLabel)}</button></div>`,
    async () => {
      ok = true;
    }, () => resolve(ok));
  });
}

// ---------------------------------------------------------------------------
// Login, routing, polling
// ---------------------------------------------------------------------------
function showLogin() {
  stopPolling();
  role = null;
  view.innerHTML = '';
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginPlain').hidden = location.protocol === 'https:' || /^(localhost|127\.|\[::1\])/.test(location.hostname);
  $('#loginPassword').value = '';
  $('#loginPassword').focus();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const r = await api('POST', '/api/login', { password: $('#loginPassword').value });
    role = r.role;
    showApp();
  } catch (ex) {
    $('#loginError').textContent = ex.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
});

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#roleBadge').textContent = isAdmin() ? 'admin' : 'view only';
  $$('[data-admin]').forEach((el) => (el.hidden = !isAdmin()));
  await startPolling();
  onRoute();
}

function parseRoute() {
  const [tab, id] = location.hash.replace(/^#/, '').split('/');
  return { tab: tab || 'accounts', id: id ? Number(id) : null };
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) location.hash = b.dataset.tab;
});
window.addEventListener('hashchange', onRoute);

async function onRoute() {
  if (!role) return;
  route = parseRoute();
  if (!isAdmin() && (route.tab === 'settings' || route.tab === 'logs')) {
    location.hash = 'accounts';
    return;
  }
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === route.tab));
  const render = {
    accounts: renderAccounts, groups: route.id ? renderGroupDetail : renderGroups, main: renderMain, jobs: renderJobs,
    history: renderHistory, settings: renderSettings, logs: renderLogs,
  }[route.tab] ?? renderAccounts;
  view.onclick = null;
  view.oninput = null;
  view.onchange = null;
  try {
    await render();
  } catch (ex) {
    showLoadError(ex);
  }
}

function showLoadError(ex) {
  if (ex.message === 'Signed out') return;
  view.onclick = (e) => e.target.closest('[data-act=retry]') && onRoute();
  view.innerHTML = `<div class="card"><p class="error">This page could not be loaded: ${esc(ex.message)}</p><button data-act="retry">Try again</button></div>`;
}

let offlineSince = null;

async function refreshState() {
  try {
    state = await api('GET', '/api/state');
    offlineSince = null;
  } catch (ex) {
    if (ex.message !== 'Signed out') {
      offlineSince ??= Date.now();
      $('#banner').textContent = `Cannot reach the server since ${fmtTime(offlineSince)}. What you see here may be out of date.`;
      $('#banner').hidden = false;
    }
    return;
  }
  renderBanner();
  const n = state.approvals + state.held;
  $('#mainBadge').hidden = !n;
  $('#mainBadge').textContent = n;
  tick++;
  try {
    await pollHooks[route.tab]?.();
  } catch (ex) {
    console.warn('refresh failed', ex);
  }
}

const pollHooks = {
  accounts: () => drawAccounts(),
  groups: () => (route.id ? tick % 2 === 0 && loadGroupDetail(false) : drawGroups()),
  main: () => loadMain(),
  jobs: () => loadJobs(),
  logs: () => loadLogs(),
};

async function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!document.hidden) refreshState();
  }, 5000);
  await refreshState();
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && role) refreshState();
});

function renderBanner() {
  const s = state.scan;
  const now = state.now;
  const msgs = [];
  if (s.loginPausedUntil > now) msgs.push(`Steam is throttling logins: password logins resume at ${fmtTime(s.loginPausedUntil)}.`);
  if (s.writePausedUntil > now) msgs.push(`Steam throttled a write: subscribing paused until ${fmtTime(s.writePausedUntil)}.`);
  if (s.pausedUntil > now) msgs.push(`Steam rate limit: checks paused until ${fmtTime(s.pausedUntil)}.`);
  if (s.writesLastHour >= s.writesPerHour) msgs.push(`Hourly write limit reached (${s.writesPerHour} per hour): the rest continues automatically.`);
  if (state.telegram.failed) msgs.push(`${plural(state.telegram.failed, 'Telegram message')} could not be delivered.`);
  $('#banner').hidden = !msgs.length;
  $('#banner').textContent = msgs.join('  ');
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
function renderAccounts() {
  view.innerHTML = `
    <div id="accStats" class="stats"></div>
    <div class="toolbar">
      <h1 style="margin:0">Accounts</h1><span class="spacer"></span>
      ${isAdmin() ? `<button data-act="checkAll">Check all now</button><button data-act="import">Bulk import</button>
      <button data-act="add" class="primary">Add account</button>` : ''}
    </div>
    <div class="card table-wrap" id="accTable"><p class="muted">Loading…</p></div>`;
  view.onclick = onAccountsClick;
  drawAccounts();
}

function drawAccounts() {
  if (!state || route.tab !== 'accounts' || !$('#accTable')) return;
  const accs = state.accounts;
  const problems = accs.filter((a) => !['ok', 'new', 'disabled'].includes(a.status)).length;
  const pending = accs.reduce((n, a) => n + a.pending, 0);
  $('#accStats').innerHTML = `
    <div class="stat"><b>${accs.length}</b><span>accounts</span></div>
    <div class="stat"><b class="${problems ? 'error' : ''}">${problems}</b><span>with problems</span></div>
    <div class="stat"><b>${state.groups.filter((g) => g.state === 'active').length}</b><span>active groups</span></div>
    <div class="stat"><b>${pending}</b><span>changes waiting</span></div>
    <div class="stat"><b>${state.scan.writesLastHour}</b><span>writes in the last hour (max ${state.scan.writesPerHour})</span></div>`;
  if (!accs.length) {
    $('#accTable').innerHTML = '<p class="muted">No accounts yet. Add the game accounts and your main account.</p>';
    return;
  }
  const signin = (a) => {
    if (!a.signed_in) return '<span class="muted">—</span>';
    if (a.has_password && !a.interactive) return '<span class="muted">renews itself</span>';
    const soon = a.token_expires_at && a.token_expires_at - Date.now() < state.tokenWarnDays * 86400_000;
    return `<span class="${soon ? 'error' : ''}">until ${esc(fmtDate(a.token_expires_at))}</span>`;
  };
  $('#accTable').innerHTML = `<table>
    <thead><tr><th>Account</th><th>Status</th><th>Groups</th><th class="num">Subscribed</th><th class="num">Waiting</th>
      <th class="hide-sm">Last check</th><th class="hide-sm">Sign-in</th><th></th></tr></thead>
    <tbody>${accs.map((a) => `<tr>
      <td><b>${esc(a.username)}</b> ${a.is_main ? '<span class="badge">main</span>' : ''}
        ${a.note ? `<div class="small muted">${esc(a.note)}</div>` : ''}</td>
      <td>${badge(ACCOUNT_STATUS, a.status)}${a.status_msg && a.status !== 'ok' ? `<div class="small muted wrap">${esc(a.status_msg)}</div>` : ''}</td>
      <td>${a.groups.map((g) => `<a class="chip" href="#groups/${g.id}">${esc(g.name)}</a>`).join('') || '<span class="muted small">none</span>'}</td>
      <td class="num">${a.subscribed}</td>
      <td class="num">${a.pending || ''}${a.pending_bytes ? `<div class="small muted" title="still to download">${fmtSize(a.pending_bytes)}</div>` : ''}
        ${a.failing ? ` <span class="error small" title="refused by Steam, retried later">(${a.failing} failing)</span>` : ''}</td>
      <td class="hide-sm" title="${esc(fmtTime(a.last_check_at))}">${esc(ago(a.last_check_at))}</td>
      <td class="hide-sm small">${signin(a)}</td>
      <td class="actions">${isAdmin() ? `
        ${a.status === 'needs_signin' || !a.has_password ? `<button class="small ${a.status === 'needs_signin' ? 'primary' : ''}" data-act="signin" data-id="${a.id}">Sign in</button>` : ''}
        ${a.enabled ? `<button class="small" data-act="check" data-id="${a.id}">Check</button>` : ''}
        <button class="small" data-act="edit" data-id="${a.id}">Edit</button>
        <button class="small danger" data-act="delete" data-id="${a.id}">Delete</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}

const accountById = (id) => state?.accounts.find((a) => a.id === Number(id));

async function onAccountsClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const acc = accountById(b.dataset.id);
  try {
    switch (b.dataset.act) {
      case 'add': return accountDialog(null);
      case 'edit': return accountDialog(acc);
      case 'import': return importDialog();
      case 'signin': return signinDialog(acc);
      case 'checkAll':
        await api('POST', '/api/check');
        return toast('Checking every account');
      case 'check':
        await api('POST', `/api/accounts/${acc.id}/check`);
        toast(`Checking ${acc.username}`);
        return refreshState();
      case 'delete':
        if (!(await confirmDialog('Delete account', `Delete ${acc.username}? Its subscriptions on Steam stay as they are.`, 'Delete', true))) return;
        await api('DELETE', `/api/accounts/${acc.id}`);
        return refreshState();
    }
  } catch (ex) {
    toast(ex.message, true);
  }
}

function accountDialog(acc) {
  const isNew = !acc;
  const currentMain = state?.accounts.find((a) => a.is_main);
  const form = openDialog(`<h2>${isNew ? 'Add account' : `Edit ${esc(acc.username)}`}</h2>
    ${isNew ? '<label>Steam account name (the login name, not the profile name) <input name="username" required autocomplete="off"></label>' : ''}
    <label>Password ${isNew ? '' : '(blank = keep)'}
      <input type="password" name="password" autocomplete="new-password"></label>
    <p class="small muted">${isNew ? 'Leave the password empty for accounts with Steam Guard (like the main account) and sign them in from the list afterwards.' : ''}</p>
    ${!isNew && acc.has_password ? '<label class="check"><input type="checkbox" name="forget_password"> Forget the stored password</label>' : ''}
    <label>Note <input name="note" value="${esc(acc?.note ?? '')}"></label>
    <label class="check"><input type="checkbox" name="is_main" ${acc?.is_main ? 'checked' : ''}> Main account (plays every game, is in every group and decides removals)</label>
    <p class="small error" data-mainnote hidden></p>
    ${!isNew ? `<label class="check"><input type="checkbox" name="enabled" ${acc.enabled ? 'checked' : ''}> Enabled</label>` : ''}
    <p class="error" data-error></p>
    <div class="buttons"><button value="cancel">Cancel</button><button value="save" class="primary">Save</button></div>`,
  async (fd) => {
    const body = { note: fd.get('note'), is_main: fd.get('is_main') === 'on' };
    if (fd.get('password')) body.password = fd.get('password');
    if (isNew) {
      body.username = fd.get('username');
      const r = await api('POST', '/api/accounts', body);
      toast(r.result === 'added' ? 'Account added' : 'Account updated');
      await refreshState();
      const added = accountById(r.id);
      if (added && !added.has_password) setTimeout(() => signinDialog(added), 50);
    } else {
      body.enabled = fd.get('enabled') === 'on';
      if (fd.get('forget_password') === 'on') body.forget_password = true;
      await api('PUT', `/api/accounts/${acc.id}`, body);
      toast('Saved');
      refreshState();
    }
  });
  const main = $('[name=is_main]', form);
  const syncMain = () => {
    const pw = $('[name=password]', form);
    pw.disabled = main.checked;
    pw.placeholder = main.checked ? "The main account's password is never stored" : '';
    if (main.checked) pw.value = '';
    const note = $('[data-mainnote]', form);
    note.textContent = main.checked ? [
      currentMain && currentMain.id !== acc?.id ? `This replaces ${currentMain.username} as the main account: from then on this account decides removals.` : '',
      acc?.has_password ? 'Its stored password will be removed.' : '',
    ].filter(Boolean).join(' ') : '';
    note.hidden = !note.textContent;
  };
  main.onchange = syncMain;
  syncMain();
}

function importDialog() {
  openDialog(`<h2>Bulk import</h2>
    <p class="small muted">One account per line: <span class="mono">name:password</span> or <span class="mono">name&lt;TAB&gt;password&lt;TAB&gt;note</span>
      (paste from a spreadsheet), or a JSON list. Accounts with Steam Guard are added one at a time and signed in.</p>
    <label>Accounts <textarea name="text" rows="10" required></textarea></label>
    <p class="error" data-error></p>
    <div class="buttons"><button value="cancel">Cancel</button><button value="go" class="primary">Import</button></div>`,
  async (fd) => {
    const r = await api('POST', '/api/accounts/import', { text: fd.get('text') });
    toast(`${plural(r.count, 'account')} imported${r.skipped?.length ? `. Skipped the main account, whose password is never stored: ${r.skipped.join(', ')}` : ''}`);
    refreshState();
  });
}

function signinDialog(acc) {
  if (!acc) return;
  let sid = null;
  let timer = null;
  let finished = false;
  let shownQr = '';
  const form = openDialog(`<h2>Sign in ${esc(acc.username)}</h2>
    <p class="small muted">For accounts with Steam Guard. The app keeps the sign-in Steam hands out (valid for about 7 months) and warns
      before it runs out. ${acc.is_main ? "The main account's password is never stored." : 'The password is only stored if you tick "remember".'}</p>
    <div class="toolbar"><button type="button" data-mode="qr">QR code (Steam mobile app)</button><button type="button" data-mode="pw">Password and code</button></div>
    <div data-pane="qr" hidden><div class="qr" data-qr><p class="muted">Getting a code from Steam…</p></div></div>
    <div data-pane="pw" hidden>
      <label>Password <input type="password" name="password" autocomplete="off"></label>
      ${acc.is_main ? '' : '<label class="check"><input type="checkbox" name="remember"> Remember the password</label>'}
      <label data-codebox hidden>Steam Guard code <input name="code" autocomplete="one-time-code" inputmode="text"></label>
    </div>
    <p data-msg class="wrap"></p>
    <p class="error" data-error></p>
    <div class="buttons"><button value="cancel">Close</button><button value="go" class="primary" data-go hidden>Sign in</button></div>`,
  async (fd) => {
    if (!sid || $('[data-codebox]', form).hidden) {
      const pw = fd.get('password');
      if (!pw) throw new Error('Enter the password');
      show(await api('POST', `/api/accounts/${acc.id}/signin/password`, { password: pw, remember: fd.get('remember') === 'on' }));
    } else {
      show(await api('POST', `/api/signin/${sid}/code`, { code: fd.get('code') }));
    }
    return true;
  },
  () => {
    clearInterval(timer);
    if (sid && !finished) api('DELETE', `/api/signin/${sid}`).catch(() => {});
    refreshState();
  });

  const show = (s) => {
    sid = s.id;
    $('[data-msg]', form).textContent = s.message || '';
    $('[data-msg]', form).className = `wrap ${s.state === 'failed' ? 'error' : ''}`;
    if (s.qrSvg && s.qrSvg !== shownQr) {
      shownQr = s.qrSvg;
      $('[data-qr]', form).innerHTML = s.qrSvg;
    }
    const needCode = s.state === 'need_code';
    $('[data-codebox]', form).hidden = !needCode;
    $('[data-go]', form).textContent = needCode ? 'Submit code' : 'Sign in';
    if (needCode) $('[name=code]', form).focus();
    if (s.state === 'done') {
      finished = true;
      clearInterval(timer);
      toast(`${acc.username} signed in`);
      setTimeout(() => $('#dialog').close(), 900);
    } else if (s.state === 'failed') {
      clearInterval(timer);
      timer = null;
    } else if (!timer) {
      timer = setInterval(async () => {
        try {
          show(await api('GET', `/api/signin/${sid}`));
        } catch (ex) {
          clearInterval(timer);
          timer = null;
          $('[data-error]', form).textContent = ex.message;
        }
      }, 2000);
    }
  };

  form.onclick = async (e) => {
    const m = e.target.closest('[data-mode]');
    if (!m) return;
    clearInterval(timer);
    timer = null;
    if (sid) api('DELETE', `/api/signin/${sid}`).catch(() => {});
    sid = null;
    $('[data-error]', form).textContent = '';
    $('[data-msg]', form).textContent = '';
    $$('[data-mode]', form).forEach((b) => b.classList.toggle('primary', b === m));
    $('[data-pane=qr]', form).hidden = m.dataset.mode !== 'qr';
    $('[data-pane=pw]', form).hidden = m.dataset.mode !== 'pw';
    $('[data-go]', form).hidden = m.dataset.mode !== 'pw';
    $('[data-codebox]', form).hidden = true;
    if (m.dataset.mode === 'qr') {
      shownQr = '';
      $('[data-qr]', form).innerHTML = '<p class="muted">Getting a code from Steam…</p>';
      try {
        show(await api('POST', `/api/accounts/${acc.id}/signin/qr`));
      } catch (ex) {
        $('[data-error]', form).textContent = ex.message;
      }
    } else {
      $('[name=password]', form).focus();
    }
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------
function renderGroups() {
  view.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Groups</h1><span class="spacer"></span>
      ${isAdmin() ? '<button data-act="new" class="primary">New group</button>' : ''}</div>
    <p class="muted small">Every member of a group shares the subscriptions it picks up for the group's games with all the others.
      The main account is in every group; what disappears from it is removed from the members too.</p>
    <div id="groupCards" class="group-cards"></div>`;
  view.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (b?.dataset.act === 'new') return groupDialog(null);
    const card = e.target.closest('[data-group]');
    if (card) location.hash = `groups/${card.dataset.group}`;
  };
  drawGroups();
}

function drawGroups() {
  const el = $('#groupCards');
  if (!state || route.tab !== 'groups' || route.id || !el) return;
  if (!state.groups.length) {
    el.innerHTML = '<p class="muted">No groups yet. A group is a set of accounts (usually for one game) that share their Workshop subscriptions.</p>';
    return;
  }
  el.innerHTML = state.groups.map((g) => {
    const pct = g.cells ? Math.round((100 * g.synced) / g.cells) : 0;
    return `<div class="card group-card" data-group="${g.id}">
      <div class="title"><span>${esc(g.name)}</span>${badge(GROUP_STATE, g.state)}</div>
      <div class="small muted">Games ${g.apps.map((a) => `<span class="chip">${a}</span>`).join('')} · ${plural(g.members, 'member')}</div>
      <div class="small">${g.items.active} synced${g.items.active ? ` · ${sizeTotal(g.bytes, g.unsized)}` : ''}${g.items.blocked ? ` · ${g.items.blocked} blocked` : ''}${g.items.removing ? ` · ${g.items.removing} removing` : ''}</div>
      ${g.state === 'active' || g.state === 'paused' ? `<div class="progress" title="${g.synced} of ${g.cells} subscriptions in place"><div style="width:${pct}%"></div></div>
        <div class="small muted">${pct}% in place</div>` : ''}
    </div>`;
  }).join('');
}

function groupDialog(detail) {
  const g = detail?.group;
  const memberIds = new Set(detail?.members.map((m) => m.id) ?? []);
  const accs = state.accounts;
  openDialog(`<h2>${g ? `Edit ${esc(g.name)}` : 'New group'}</h2>
    <label>Name <input name="name" required maxlength="64" value="${esc(g?.name ?? '')}"></label>
    <label>Games (Steam app IDs, comma separated) <input name="appids" required value="${esc(g?.apps.join(', ') ?? '')}" placeholder="730"></label>
    <p class="small muted">Examples: Counter-Strike 2 = 730, Squad = 393380. The app ID is the number in the game's store URL.</p>
    <div class="small muted" style="margin-bottom:4px">Members</div>
    <div class="member-list">${accs.map((a) => `<label class="check"><input type="checkbox" name="m" value="${a.id}"
      ${a.is_main || memberIds.has(a.id) ? 'checked' : ''} ${a.is_main ? 'disabled' : ''}> ${esc(a.username)}
      ${a.is_main ? '<span class="badge">main, always a member</span>' : ''}${a.note ? `<span class="muted small">${esc(a.note)}</span>` : ''}</label>`).join('') ||
      '<p class="muted">Add accounts first.</p>'}</div>
    ${g && g.state !== 'setup' ? '<p class="small muted">New members and games are read in full first; their items are then shared like any new item.</p>' : ''}
    <p class="error" data-error></p>
    <div class="buttons"><button value="cancel">Cancel</button><button value="save" class="primary">${g ? 'Save' : 'Create'}</button></div>`,
  async (fd) => {
    const body = { name: fd.get('name'), appids: fd.get('appids'), members: fd.getAll('m').map(Number) };
    if (g) {
      await api('PUT', `/api/groups/${g.id}`, body);
      toast('Saved');
      loadGroupDetail(true);
    } else {
      const r = await api('POST', '/api/groups', body);
      location.hash = `groups/${r.id}`;
    }
    refreshState();
  });
}

let gDetail = null;
let gItems = [];
let gFilter = { state: 'active', search: '', page: 0 };
const PAGE = 100;
/** Items whose per-account row is open, so it stays open when the list is redrawn. */
const openCells = new Set();

function renderGroupDetail() {
  gDetail = null;
  gItems = [];
  gFilter = { state: 'active', search: '', page: 0 };
  openCells.clear();
  view.innerHTML = `
    <div class="toolbar"><a href="#groups">← Groups</a><span class="spacer"></span><span id="gButtons"></span></div>
    <div id="gHead" class="card"><p class="muted">Loading…</p></div>
    <div id="gPreview"></div>
    <div class="grid2">
      <div class="card table-wrap" id="gMembers"></div>
      <div class="card">
        <h2>Add items</h2>
        ${isAdmin() ? `<p class="small muted">Paste Workshop links or ids, one per line. A collection adds all its items, and items added to it later.</p>
        <textarea id="gAddText" rows="4" placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…"></textarea>
        <div class="toolbar" style="margin-top:8px"><button data-act="addItems" class="primary">Add to group</button><span id="gAddResult" class="small"></span></div>` : ''}
        <h3>Collections</h3><div id="gColls" class="small"></div>
      </div>
    </div>
    <div class="card">
      <div class="toolbar">
        <h2 style="margin:0">Items</h2><span class="spacer"></span>
        <select id="gState"><option value="active">Synced</option><option value="blocked">Blocked</option><option value="removing">Removing</option>
          <option value="removed">Removed</option><option value="">All</option></select>
        <input id="gSearch" type="search" placeholder="Search title or id">
      </div>
      <div id="gItems" class="table-wrap"></div>
    </div>`;
  view.onclick = onGroupClick;
  $('#gState').onchange = (e) => {
    gFilter.state = e.target.value;
    gFilter.page = 0;
    drawItems();
  };
  $('#gSearch').oninput = (e) => {
    gFilter.search = e.target.value.trim().toLowerCase();
    gFilter.page = 0;
    drawItems();
  };
  loadGroupDetail(true);
}

async function loadGroupDetail(withItems) {
  const id = route.id;
  try {
    const [d, items] = await Promise.all([
      api('GET', `/api/groups/${id}`),
      withItems || !gItems.length || tick % 6 === 0 ? api('GET', `/api/groups/${id}/items`) : null,
    ]);
    if (route.id !== id) return;
    gDetail = d;
    if (items) gItems = items.items;
    drawGroupDetail(!!items);
  } catch (ex) {
    if (ex.status === 404) {
      toast('Group not found', true);
      location.hash = 'groups';
    } else if (!gDetail && $('#gHead')) {
      $('#gHead').innerHTML = `<p class="error">This group could not be loaded: ${esc(ex.message)}. Trying again…</p>`;
    }
  }
}

/** redrawItems = false keeps the items table (and any opened rows) as it is. */
function drawGroupDetail(redrawItems = true) {
  const { group: g } = gDetail;
  const pct = gDetail.cells ? Math.round((100 * gDetail.synced) / gDetail.cells) : 0;
  const btn = (act, label, cls = '') => `<button data-act="${act}" class="${cls}">${label}</button>`;
  $('#gButtons').innerHTML = isAdmin() ? [
    g.state === 'setup' ? btn('start', 'Start', 'primary') : '',
    g.state === 'active' ? btn('pause', 'Pause') : '',
    g.state === 'paused' ? btn('resume', 'Resume', 'primary') : '',
    btn('edit', 'Edit'), btn('deleteGroup', 'Delete', 'danger'),
  ].join(' ') : '';
  const stateText = {
    setup: 'Not started. Starting reads every member\'s subscriptions for these games and shows what the first sync would do before anything is changed.',
    scanning: 'Reading every member\'s subscriptions. A preview follows; nothing is changed before you confirm it.',
    preview: 'The first read is done. Check the preview below and start syncing.',
    active: 'Syncing.',
    paused: 'Paused: nothing is read or changed for this group.',
  }[g.state];
  $('#gHead').innerHTML = `<div class="toolbar" style="margin:0"><h1 style="margin:0">${esc(g.name)}</h1>${badge(GROUP_STATE, g.state)}</div>
    <p class="muted">${esc(stateText)}</p>
    <div class="stats" style="margin:0">
      <div class="stat"><b>${g.apps.join(', ')}</b><span>games</span></div>
      <div class="stat"><b>${gDetail.members.length}</b><span>members</span></div>
      <div class="stat"><b>${gDetail.items.active}</b><span>synced items</span></div>
      <div class="stat"><b>${sizeTotal(gDetail.bytes, gDetail.unsized)}</b><span>total size</span></div>
      <div class="stat"><b>${gDetail.synced} / ${gDetail.cells}</b><span>subscriptions in place (${pct}%)</span></div>
      ${gDetail.items.blocked ? `<div class="stat"><b>${gDetail.items.blocked}</b><span>blocked</span></div>` : ''}
      ${gDetail.items.removing ? `<div class="stat"><b>${gDetail.items.removing}</b><span>being removed</span></div>` : ''}
    </div>`;

  const p = g.preview;
  $('#gPreview').innerHTML = g.state === 'preview' && p ? `<div class="card">
      <h2>Preview of the first sync</h2>
      <p>${plural(p.items.length, 'item')} (${sizeTotal(p.bytes, p.unsized)}) will be shared with every member: ${plural(p.writes, 'subscription')} to make.
        ${p.unsubscribes ? `${plural(p.unsubscribes, 'subscription')} of blocked or removed items will be unsubscribed.` : ''}
        ${p.approvals.length ? `${plural(p.approvals.length, 'item')} on the main account also match another group and will wait for you to pick one.` : ''}</p>
      <table><thead><tr><th>Account</th><th class="num">Already has</th><th class="num">Will get</th><th class="num">To download</th><th></th></tr></thead>
      <tbody>${p.perAccount.map((a) => `<tr><td>${esc(a.username)} ${a.is_main ? '<span class="badge">main</span>' : ''}</td>
        <td class="num">${a.has}</td><td class="num">${a.missing}</td><td class="num">${a.missing ? fmtSize(a.missingBytes) : ''}</td>
        <td>${a.unreadable ? '<span class="badge bad">could not be read: it gets its share once it works</span>' : ''}</td></tr>`).join('')}</tbody></table>
      ${isAdmin() ? `<div class="toolbar" style="margin-top:12px">${btn('confirm', 'Start syncing', 'primary')}${btn('start', 'Read again')}</div>` : ''}
      <p class="small muted">Steam is not touched until you start. Sizes fill in over a few minutes after the first read.</p>
    </div>` : '';

  $('#gMembers').innerHTML = `<h2>Members</h2><table>
    <thead><tr><th>Account</th><th>Status</th><th class="num">Has</th><th class="num">To download</th><th class="num">Failing</th></tr></thead>
    <tbody>${gDetail.members.map((m) => `<tr>
      <td>${esc(m.username)} ${m.is_main ? '<span class="badge">main</span>' : ''}</td>
      <td>${badge(ACCOUNT_STATUS, m.status)} ${m.read ? '' : '<span class="badge dim">not read yet</span>'}</td>
      <td class="num">${m.has} / ${gDetail.available}</td>
      <td class="num">${m.has < gDetail.available ? fmtSize(m.missing_bytes) : ''}</td>
      <td class="num">${m.failing ? `<span class="error">${m.failing}</span>` : ''}</td></tr>`).join('')}</tbody></table>`;

  $('#gColls').innerHTML = gDetail.collections.length ? `<table><tbody>${gDetail.collections.map((c) => `<tr>
      <td><a href="${workshopUrl(c.collection_id)}" target="_blank" rel="noopener">${esc(c.title || c.collection_id)}</a>
        <div class="muted">${c.child_count} items · read ${esc(ago(c.resolved_at))}${c.last_error ? ` · <span class="error">${esc(c.last_error)}</span>` : ''}</div></td>
      <td class="actions">${isAdmin() ? `<button class="small" data-act="dropColl" data-id="${esc(c.collection_id)}" title="Stops adding new items from it; items stay">Stop following</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p class="muted">None.</p>';
  if (redrawItems) drawItems();
}

function drawItems() {
  const list = gItems.filter((i) => (!gFilter.state || i.state === gFilter.state)
    && (!gFilter.search || i.id.includes(gFilter.search) || (i.title || '').toLowerCase().includes(gFilter.search)));
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  gFilter.page = Math.min(gFilter.page, pages - 1);
  const shown = list.slice(gFilter.page * PAGE, (gFilter.page + 1) * PAGE);
  const members = gDetail?.members.length ?? 0;
  const actions = (i) => {
    if (!isAdmin()) return '';
    const b = (act, label, cls = '') => `<button class="small ${cls}" data-act="${act}" data-id="${esc(i.id)}">${label}</button>`;
    if (i.state === 'active') return b('block', 'Block') + b('remove', 'Remove', 'danger');
    if (i.state === 'blocked') return b('unblock', 'Unblock');
    return b('restore', 'Add back');
  };
  $('#gItems').innerHTML = list.length ? `<table>
    <thead><tr><th>Item</th><th class="num">Size</th><th>State</th><th class="num">On accounts</th><th class="hide-sm">Source</th><th></th></tr></thead>
    <tbody>${shown.map((i) => `<tr data-row="${esc(i.id)}">
      <td>${i.preview_url ? `<img class="thumb" loading="lazy" src="${esc(i.preview_url)}" alt="">` : ''}
        <a href="${workshopUrl(i.id)}" target="_blank" rel="noopener">${esc(i.title || i.id)}</a>
        ${i.status !== 'ok' ? '<span class="badge bad">unavailable on Steam</span>' : ''}
        ${i.in_filter ? '' : '<span class="badge dim">game not in this group</span>'}
        <div class="small muted mono">${esc(i.id)} · app ${i.appid}</div></td>
      <td class="num" style="white-space:nowrap">${fmtSize(i.file_size)}</td>
      <td>${badge(ITEM_STATE, i.state)}</td>
      <td class="num"><a href="#" data-act="cells" data-id="${esc(i.id)}">${i.present} / ${members}</a>
        ${i.failing ? `<div class="small error">${i.failing} failing</div>` : ''}</td>
      <td class="hide-sm small muted">${esc(i.source)}</td>
      <td class="actions">${actions(i)}</td></tr>`).join('')}</tbody></table>
    ${pages > 1 ? `<div class="pager"><button class="small" data-act="page" data-id="-1" ${gFilter.page ? '' : 'disabled'}>‹</button>
      <span class="small">Page ${gFilter.page + 1} of ${pages} · ${list.length} items</span>
      <button class="small" data-act="page" data-id="1" ${gFilter.page < pages - 1 ? '' : 'disabled'}>›</button></div>` : ''}`
    : '<p class="muted">No items here.</p>';
  for (const id of openCells) {
    const row = $(`tr[data-row="${CSS.escape(id)}"]`);
    if (row) showCells(id, row).catch(() => {});
  }
}

async function toggleCells(itemId, rowEl) {
  const next = rowEl.nextElementSibling;
  if (next?.dataset.cells) {
    openCells.delete(itemId);
    return next.remove();
  }
  openCells.add(itemId);
  await showCells(itemId, rowEl);
}

async function showCells(itemId, rowEl) {
  const { cells } = await api('GET', `/api/groups/${route.id}/items/${itemId}`);
  if (rowEl.nextElementSibling?.dataset.cells) rowEl.nextElementSibling.remove();
  const tr = document.createElement('tr');
  tr.dataset.cells = '1';
  tr.innerHTML = `<td colspan="6"><div class="cells">${cells.map((c) => {
    const cls = c.present ? 'ok' : c.write_error ? 'bad' : c.removal_held ? 'warn' : c.read ? 'dim' : 'dim';
    const what = c.present ? 'subscribed' : c.removal_held ? 'removal held' : !c.read ? 'not read yet' : c.write_error ? c.write_error : 'not subscribed';
    const retry = c.write_error && c.write_next_at ? ` (retry ${ago(c.write_next_at)})` : '';
    return `<span class="badge ${cls}" title="${esc(what + retry)}">${esc(c.username)}${c.is_main ? ' (main)' : ''}: ${esc(what.length > 40 ? `${what.slice(0, 40)}…` : what)}</span>`;
  }).join('')}</div></td>`;
  rowEl.after(tr);
}

async function onGroupClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  e.preventDefault();
  const id = route.id;
  const g = gDetail?.group;
  const item = gItems.find((i) => i.id === b.dataset.id);
  const label = item ? item.title || item.id : '';
  try {
    switch (b.dataset.act) {
      case 'edit': return groupDialog(gDetail);
      case 'page':
        gFilter.page += Number(b.dataset.id);
        return drawItems();
      case 'cells': return await toggleCells(b.dataset.id, b.closest('tr'));
      case 'deleteGroup':
        if (!(await confirmDialog('Delete group', `Delete ${g.name}? Nothing is unsubscribed: every account keeps what it has.`, 'Delete', true))) return;
        await api('DELETE', `/api/groups/${id}`);
        location.hash = 'groups';
        return refreshState();
      case 'start':
      case 'confirm':
      case 'pause':
      case 'resume':
        if (b.dataset.act === 'confirm' && !(await confirmDialog('Start syncing', `Share ${plural(g.preview?.items.length ?? 0, 'item')} with every member of ${g.name} (${plural(g.preview?.writes ?? 0, 'subscription')}${g.preview?.unsubscribes ? `, and ${g.preview.unsubscribes} to remove` : ''})?`, 'Start syncing'))) return;
        await api('POST', `/api/groups/${id}/${b.dataset.act}`);
        toast({ start: 'Reading the members\' lists', confirm: 'Syncing started', pause: 'Paused', resume: 'Resumed' }[b.dataset.act]);
        await loadGroupDetail(true);
        return refreshState();
      case 'block':
        if (!(await confirmDialog('Block item', `Block "${label}"? It is unsubscribed from every member of ${g.name}, and again whenever it comes back.`, 'Block', true))) return;
        break;
      case 'remove':
        if (!(await confirmDialog('Remove item', `Unsubscribe "${label}" from every member of ${g.name}, including the main account? ` +
          'Accounts that another group syncs it to keep it. If an account picks it up again later, it is synced again.', 'Remove', true))) return;
        break;
      case 'unblock':
      case 'restore':
        break;
      case 'dropColl':
        await api('DELETE', `/api/groups/${id}/collections/${b.dataset.id}`);
        return loadGroupDetail(false);
      case 'addItems': {
        const text = $('#gAddText').value.trim();
        if (!text) return;
        b.disabled = true;
        $('#gAddResult').textContent = 'Looking the items up on Steam…';
        try {
          const r = await api('POST', `/api/groups/${id}/items`, { text });
          $('#gAddText').value = '';
          $('#gAddResult').innerHTML = esc(`Added ${plural(r.added, 'item')}${r.collections ? ` (${plural(r.collections, 'collection')})` : ''}.`) +
            (r.skipped.length ? ` <span class="error">${esc(`Skipped: ${r.skipped.map((s) => `${s.id} (${s.reason})`).join('; ')}`)}</span>` : '');
          await loadGroupDetail(true);
        } catch (ex) {
          $('#gAddResult').innerHTML = `<span class="error">${esc(ex.message)}</span>`;
        } finally {
          b.disabled = false;
        }
        return;
      }
      default:
        return;
    }
    await api('POST', `/api/groups/${id}/items/${encodeURIComponent(b.dataset.id)}/${b.dataset.act}`);
    toast('Done');
    loadGroupDetail(true);
  } catch (ex) {
    toast(ex.message, true);
  }
}

// ---------------------------------------------------------------------------
// Main account: picks and held removals
// ---------------------------------------------------------------------------
async function renderMain() {
  const main = state?.accounts.find((a) => a.is_main);
  view.innerHTML = `<h1>Main account</h1>
    <p class="muted">${main ? `The main account is <b>${esc(main.username)}</b>. It is in every group, receives every group's items, and an item that disappears from it is removed from the members.`
      : 'No main account yet. Mark one with Accounts → Edit → Main account.'}</p>
    <div class="card" id="heldBox"><p class="muted">Loading…</p></div>
    <div class="card" id="apprBox"></div>`;
  view.onclick = onMainClick;
  mainShown = '';
  await loadMain();
}

let mainShown = '';

async function loadMain() {
  if (route.tab !== 'main') return;
  const data = await api('GET', '/api/approvals');
  const shown = JSON.stringify(data);
  if (!$('#heldBox') || shown === mainShown) return;
  mainShown = shown;
  const { approvals, held } = data;
  const ticked = new Set($$('[data-held]:checked').map((c) => c.value));
  $('#heldBox').innerHTML = `<h2>Held removals</h2>
    <p class="small muted">More items left the main account at once than the hold threshold in Settings, or Steam refused the main account an item. Nothing was removed from the members yet.</p>
    ${held.length ? `<table><thead><tr><th>${isAdmin() ? '<input type="checkbox" data-all>' : ''}</th><th>Item</th><th>Account</th><th>When</th><th>Why</th></tr></thead>
      <tbody>${held.map((h) => `<tr><td>${isAdmin() ? `<input type="checkbox" data-held value="${esc(h.item_id)}">` : ''}</td>
        <td><a href="${workshopUrl(h.item_id)}" target="_blank" rel="noopener">${esc(h.title || h.item_id)}</a> <span class="muted small">app ${h.appid}</span></td>
        <td>${esc(h.username)}</td><td>${esc(fmtTime(h.lost_at))}</td><td class="small wrap">${esc(h.held_reason || 'Disappeared from the list')}</td></tr>`).join('')}</tbody></table>
      ${isAdmin() ? `<div class="toolbar" style="margin-top:10px">
        <button data-act="held" data-mode="approve" class="danger">Remove selected from the members</button>
        <button data-act="held" data-mode="restore" class="primary">Subscribe the main account to them again</button></div>` : ''}`
      : '<p class="muted">Nothing held.</p>'}`;
  $('#apprBox').innerHTML = `<h2>Pick a group</h2>
    <p class="small muted">New items on the main account whose game is synced by more than one group.</p>
    ${approvals.length ? `<table><tbody>${approvals.map((a) => `<tr>
      <td>${a.preview_url ? `<img class="thumb" loading="lazy" src="${esc(a.preview_url)}" alt="">` : ''}
        <a href="${workshopUrl(a.item_id)}" target="_blank" rel="noopener">${esc(a.title || a.item_id)}</a>
        <div class="small muted">app ${a.appid} · found ${esc(ago(a.created_at))}</div></td>
      <td class="actions">${isAdmin() ? a.groups.map((g) => `<button class="small primary" data-act="pick" data-item="${esc(a.item_id)}" data-group="${g.id}">${esc(g.name)}</button>`).join('') +
        `<button class="small" data-act="pick" data-item="${esc(a.item_id)}" data-group="">Ignore</button>` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Nothing waiting.</p>'}`;
  $$('[data-held]').forEach((c) => (c.checked = ticked.has(c.value)));
}

async function onMainClick(e) {
  if (e.target.matches('[data-all]')) {
    $$('[data-held]').forEach((c) => (c.checked = e.target.checked));
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  try {
    if (b.dataset.act === 'pick') {
      await api('POST', `/api/approvals/${encodeURIComponent(b.dataset.item)}`, { group_id: b.dataset.group ? Number(b.dataset.group) : null });
    } else if (b.dataset.act === 'held') {
      const items = $$('[data-held]:checked').map((c) => c.value);
      if (!items.length) return toast('Select items first', true);
      const approve = b.dataset.mode === 'approve';
      if (approve && !(await confirmDialog('Remove from members', `Unsubscribe ${plural(items.length, 'item')} from every member of their groups?`, 'Remove', true))) return;
      await api('POST', '/api/held', { items, action: b.dataset.mode });
    }
    toast('Done');
    await loadMain();
    refreshState();
  } catch (ex) {
    toast(ex.message, true);
  }
}

// ---------------------------------------------------------------------------
// One-shot jobs
// ---------------------------------------------------------------------------
function renderJobs() {
  const accs = state?.accounts ?? [];
  view.innerHTML = `<h1>Jobs</h1>
    ${isAdmin() ? `<div class="card">
      <h2>New job</h2>
      <p class="small muted">Subscribe or unsubscribe items once, on the accounts you pick. Nothing is kept in sync afterwards.
        Unsubscribing an item from every member of a group also takes it out of that group.</p>
      <div class="grid2">
        <div>
          <label>Action <select id="jAction"><option value="">Choose…</option><option value="unsubscribe">Unsubscribe</option><option value="subscribe">Subscribe</option></select></label>
          <label>Items (Workshop links or ids; collections are expanded) <textarea id="jText" rows="6"></textarea></label>
        </div>
        <div>
          <div class="toolbar"><span class="small muted">Accounts</span><span class="spacer"></span>
            <button class="small" data-act="selAll">All</button><button class="small" data-act="selNone">None</button>
            <select id="jGroup"><option value="">Members of group…</option>${(state?.groups ?? []).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
          <div class="member-list">${accs.map((a) => `<label class="check"><input type="checkbox" data-acc value="${a.id}"> ${esc(a.username)}
            ${a.is_main ? '<span class="badge">main</span>' : ''}</label>`).join('')}</div>
        </div>
      </div>
      <div id="jConflicts"></div>
      <div class="toolbar" style="margin-top:10px"><button class="primary" data-act="submit">Run job</button><span id="jResult" class="small"></span></div>
    </div>` : ''}
    <div class="card table-wrap"><h2>Recent jobs</h2><div id="jobList"><p class="muted">Loading…</p></div></div>`;
  view.onclick = onJobsClick;
  const sel = $('#jGroup');
  if (sel) {
    sel.onchange = async () => {
      if (!sel.value) return;
      try {
        const d = await api('GET', `/api/groups/${sel.value}`);
        const ids = new Set(d.members.map((m) => m.id));
        $$('[data-acc]').forEach((c) => (c.checked = ids.has(Number(c.value))));
      } catch (ex) {
        toast(ex.message, true);
      }
      sel.value = '';
    };
  }
  return loadJobs();
}

async function loadJobs() {
  if (route.tab !== 'jobs') return;
  const { jobs } = await api('GET', '/api/jobs');
  const el = $('#jobList');
  if (!el) return;
  el.innerHTML = jobs.length ? `<table><thead><tr><th>#</th><th>Created</th><th>Job</th><th>Progress</th><th>Status</th><th></th></tr></thead>
    <tbody>${jobs.map((j) => `<tr><td>${j.id}</td><td>${esc(fmtTime(j.created_at))}</td><td>${esc(j.label)}</td>
      <td>${j.done} done${j.failed ? `, <span class="error">${j.failed} failed</span>` : ''}${j.pending ? `, ${j.pending} waiting` : ''} of ${j.total}</td>
      <td>${badge({ running: ['', 'Running'], done: ['ok', 'Done'], cancelled: ['dim', 'Cancelled'] }, j.status)}</td>
      <td class="actions">${j.failed || j.pending ? `<button class="small" data-act="jobInfo" data-id="${j.id}">Details</button>` : ''}
        ${isAdmin() && j.status === 'running' ? `<button class="small danger" data-act="cancel" data-id="${j.id}">Cancel</button>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No jobs yet.</p>';
}

/** A job on its way, and the exact job the clash warning on screen is about. */
let jobBusy = false;
let jobClash = '';

function showClash(job, conflicts) {
  jobClash = JSON.stringify(job);
  $('#jConflicts').innerHTML = `<div class="card" style="background:var(--warn-bg);margin-top:10px"><b>This job clashes with a group</b>
    <ul>${conflicts.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    <button data-act="force" class="danger">Run it anyway</button></div>`;
}

async function onJobsClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  try {
    switch (b.dataset.act) {
      case 'selAll':
        return $$('[data-acc]').forEach((c) => (c.checked = true));
      case 'selNone':
        return $$('[data-acc]').forEach((c) => (c.checked = false));
      case 'submit':
      case 'force': {
        if (jobBusy) return;
        const job = { action: $('#jAction').value, text: $('#jText').value, accounts: $$('[data-acc]:checked').map((c) => Number(c.value)) };
        if (!job.action) return toast('Choose what the job should do', true);
        // "Run it anyway" only stands for the job the warning showed: an edited one is checked again.
        const force = b.dataset.act === 'force' && jobClash === JSON.stringify(job);
        const run = $('[data-act=submit]');
        jobBusy = true;
        run.disabled = true;
        $('#jResult').textContent = 'Looking the items up on Steam…';
        $('#jConflicts').innerHTML = '';
        jobClash = '';
        try {
          if (job.action === 'unsubscribe' && !force) {
            const p = await api('POST', '/api/jobs', { ...job, preview: true });
            $('#jResult').textContent = '';
            if (p.conflicts.length) return showClash(job, p.conflicts);
            const leaving = p.takenOut ? ` ${plural(p.takenOut, 'item')} will also leave ${p.groups.join(', ')}.` : '';
            if (!(await confirmDialog('Unsubscribe', `Unsubscribe ${plural(p.items, 'item')} from ${plural(p.accounts, 'account')} (${plural(p.writes, 'write')})?${leaving}`, 'Unsubscribe', true))) return;
          }
          const r = await api('POST', '/api/jobs', { ...job, confirm: force });
          $('#jResult').textContent = `Job ${r.id} queued.${r.skipped?.length ? ` Skipped ${r.skipped.length} unknown item(s).` : ''}`;
          $('#jText').value = '';
          loadJobs();
        } catch (ex) {
          $('#jResult').textContent = '';
          if (ex.status === 409 && ex.data?.conflicts) showClash(job, ex.data.conflicts);
          else throw ex;
        } finally {
          jobBusy = false;
          run.disabled = false;
        }
        return;
      }
      case 'cancel':
        await api('POST', `/api/jobs/${b.dataset.id}/cancel`);
        return loadJobs();
      case 'jobInfo': {
        const { items, total } = await api('GET', `/api/jobs/${b.dataset.id}`);
        return openDialog(`<h2>Job ${esc(b.dataset.id)}</h2>${total > items.length ? `<p class="small muted">Showing the first ${items.length} of ${total}.</p>` : ''}
          <div class="table-wrap" style="max-height:60vh"><table>
          <thead><tr><th>Account</th><th>Item</th><th>State</th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.username)}</td>
          <td><a href="${workshopUrl(i.item_id)}" target="_blank" rel="noopener">${esc(i.title || i.item_id)}</a></td>
          <td>${i.state === 'failed' ? `<span class="error">${esc(i.error)}</span>` : 'waiting'}</td></tr>`).join('')}</tbody></table></div>
          <div class="buttons"><button value="cancel">Close</button></div>`, async () => {});
      }
    }
  } catch (ex) {
    toast(ex.message, true);
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
const EVENT_TYPES = ['discovered', 'reapplied', 'removed', 'removal_held', 'lost', 'blocked_back', 'approval', 'write', 'write_failed',
  'problem', 'login', 'signin', 'token_expiring', 'group', 'collection', 'job', 'admin'];

function renderHistory() {
  view.innerHTML = `<div class="toolbar"><h1 style="margin:0">History</h1><span class="spacer"></span>
      <select id="hAccount"><option value="">All accounts</option>${(state?.accounts ?? []).map((a) => `<option>${esc(a.username)}</option>`).join('')}</select>
      <select id="hType"><option value="">All events</option>${EVENT_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
      <label class="check" style="margin:0"><input type="checkbox" id="hAlerts"> Important only</label>
      <button data-act="reload">Refresh</button></div>
    <div class="card table-wrap" id="hList"><p class="muted">Loading…</p></div>`;
  view.onchange = () => loadHistory().catch(showLoadError);
  view.onclick = (e) => e.target.closest('[data-act=reload]') && loadHistory().catch(showLoadError);
  return loadHistory();
}

async function loadHistory() {
  const qs = new URLSearchParams({ limit: '300' });
  if ($('#hAccount').value) qs.set('account', $('#hAccount').value);
  if ($('#hType').value) qs.set('type', $('#hType').value);
  if ($('#hAlerts').checked) qs.set('alerts', '1');
  const { events } = await api('GET', `/api/events?${qs}`);
  $('#hList').innerHTML = events.length ? `<table><thead><tr><th>Time</th><th>Account</th><th>Event</th><th>Details</th></tr></thead>
    <tbody>${events.map((ev) => `<tr><td class="small" style="white-space:nowrap">${esc(fmtTime(ev.ts))}</td><td>${esc(ev.username)}</td>
      <td><span class="badge ${ev.alerted ? 'warn' : 'dim'}">${esc(ev.type)}</span></td><td class="wrap">${esc(ev.message)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nothing yet.</p>';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const SETTING_GROUPS = [
  ['Checking', [
    ['check_interval_seconds', 'Check every account every (seconds)', 'number', 'A check normally costs one page per game.'],
    ['full_read_hours', 'Read every list in full at least every (hours)', 'number'],
    ['concurrency', 'Accounts in parallel', 'number'],
    ['request_timeout_seconds', 'Request timeout (seconds)', 'number'],
  ]],
  ['Writes', [
    ['write_gap_ms', 'Pause between two writes of one account (ms)', 'number'],
    ['writes_per_run', 'Writes per account per round', 'number'],
    ['writes_per_hour', 'Writes per hour, all accounts', 'number', 'In testing Steam took 160 writes in 4 minutes without throttling; hourly or daily limits are unknown.'],
    ['login_gap_seconds', 'Pause between password logins (seconds)', 'number'],
  ]],
  ['Main account', [
    ['removal_hold_threshold', 'Hold removals when more than this many items disappear at once', 'number'],
    ['token_warn_days', 'Warn this many days before a sign-in expires', 'number'],
    ['collection_refresh_hours', 'Read collections again every (hours)', 'number'],
  ]],
  ['General', [
    ['timezone', 'Time zone', 'text'],
    ['history_retention_days', 'Keep history for (days)', 'number'],
  ]],
  ['Telegram', [
    ['telegram_enabled', 'Send Telegram messages', 'flag'],
    ['telegram_bot_token', 'Bot token', 'secret'],
    ['telegram_chat_id', 'Chat id', 'text'],
    ['notify_discovered', 'New items found', 'flag'],
    ['notify_reapplied', 'Items subscribed again', 'flag'],
    ['notify_removed', 'Items removed through the main account, and held removals', 'flag'],
    ['notify_account_problems', 'Account problems and expiring sign-ins', 'flag'],
  ]],
  ['Message templates', [
    ['template_discovered', 'New items ({group} {count} {accounts} {items})', 'area'],
    ['template_reapplied', 'Subscribed again ({group} {count} {accounts} {items})', 'area'],
    ['template_removed', 'Removed ({group} {count} {accounts} {items})', 'area'],
    ['template_held', 'Removal held ({account} {count} {items})', 'area'],
    ['template_approval', 'Pick a group ({count} {items})', 'area'],
    ['template_problem', 'Account problem ({account} {message})', 'area'],
  ]],
];

async function renderSettings() {
  view.innerHTML = '<h1>Settings</h1><p class="muted">Loading…</p>';
  const { settings: s, defaults } = await api('GET', '/api/settings');
  const field = ([key, label, type, hint]) => {
    const def = defaults[key] !== undefined && type !== 'area' && type !== 'secret' && type !== 'flag' ? ` <span class="muted">(default ${esc(defaults[key])})</span>` : '';
    const h = hint ? `<div class="small muted">${esc(hint)}</div>` : '';
    if (type === 'flag') return `<label class="check"><input type="checkbox" name="${key}" ${s[key] === '1' ? 'checked' : ''}> ${esc(label)}</label>`;
    if (type === 'area') return `<label>${esc(label)}<textarea name="${key}" rows="4">${esc(s[key])}</textarea></label>`;
    if (type === 'secret') {
      return `<label>${esc(label)} ${s[`${key}_set`] ? '<span class="badge ok">set</span>' : ''}<input type="password" name="${key}" placeholder="${s[`${key}_set`] ? 'blank = keep' : ''}" autocomplete="off"></label>
        ${s[`${key}_set`] ? `<label class="check"><input type="checkbox" name="${key}_clear"> Remove the saved ${esc(label.toLowerCase())}</label>` : ''}`;
    }
    return `<label>${esc(label)}${def}<input name="${key}" type="${type}" value="${esc(s[key])}">${h}</label>`;
  };
  view.innerHTML = `<h1>Settings</h1><form id="settingsForm">
    <div class="grid2">${SETTING_GROUPS.map(([title, fields]) => `<div class="card"><h2>${esc(title)}</h2>${fields.map(field).join('')}
      ${title === 'Telegram' ? '<button type="button" data-act="tgTest">Send a test message</button>' : ''}</div>`).join('')}
      <div class="card"><h2>View-only access</h2>
        <p class="small muted">A second password that can see everything but change nothing. ${s.viewer_password_set ? '<span class="badge ok">set</span>' : '<span class="badge dim">off</span>'}</p>
        <label>New viewer password <input type="password" name="viewer_password" autocomplete="new-password"></label>
        ${s.viewer_password_set ? '<label class="check"><input type="checkbox" name="viewer_password_clear"> Turn view-only access off</label>' : ''}
      </div>
    </div>
    <div class="toolbar"><button type="submit" class="primary">Save settings</button><span id="sResult" class="small"></span></div></form>`;
  const form = $('#settingsForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const [, fields] of SETTING_GROUPS) {
      for (const [key, , type] of fields) {
        const el = form.elements[key];
        body[key] = type === 'flag' ? (el.checked ? '1' : '0') : el.value;
      }
    }
    if (form.elements.telegram_bot_token_clear?.checked) body.telegram_bot_token_clear = true;
    body.viewer_password = form.elements.viewer_password.value;
    if (form.elements.viewer_password_clear?.checked) body.viewer_password_clear = true;
    try {
      await api('PUT', '/api/settings', body);
      toast('Settings saved');
      renderSettings();
    } catch (ex) {
      $('#sResult').innerHTML = `<span class="error">${esc(ex.message)}</span>`;
    }
  };
  view.onclick = async (e) => {
    if (!e.target.closest('[data-act=tgTest]')) return;
    try {
      await api('POST', '/api/telegram/test', { telegram_bot_token: form.elements.telegram_bot_token.value, telegram_chat_id: form.elements.telegram_chat_id.value });
      toast('Test message sent');
    } catch (ex) {
      toast(ex.message, true);
    }
  };
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
function renderLogs() {
  view.innerHTML = '<div class="toolbar"><h1 style="margin:0">Logs</h1></div><div class="card"><pre id="logBox" class="logs">Loading…</pre></div>';
  logsShown = '';
  return loadLogs();
}

let logsShown = '';

async function loadLogs() {
  if (route.tab !== 'logs' || !isAdmin()) return;
  const { logs } = await api('GET', '/api/logs');
  const box = $('#logBox');
  if (!box) return;
  const html = logs.map((l) => `<span class="lvl-${l.level}">${esc(fmtTime(l.ts))} ${esc(l.msg)}</span>`).join('\n');
  const selection = getSelection();
  // Someone copying a line: the page catches up once the selection is gone.
  if (html === logsShown || (selection && !selection.isCollapsed && box.contains(selection.anchorNode))) return;
  logsShown = html;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.innerHTML = html;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const me = await api('GET', '/api/me');
    role = me.role;
    showApp();
  } catch (ex) {
    if (ex.message !== 'Signed out') showLogin();
  }
})();
