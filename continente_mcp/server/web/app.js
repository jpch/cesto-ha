// Add-on ingress page. All text comes from i18n/<lang>.json; URLs are relative to the ingress path.
(() => {
  let t = {};
  const tr = (key, vars = {}) => (t[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const $ = id => document.getElementById(id);
  const api = async (method, path, body) => {
    const res = await fetch(`api/v1/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message_key ?? 'error.internal');
    return data;
  };
  const show = (key, vars) => { $('message').textContent = tr(key, vars); };
  const fail = e => show(e.message);
  const fmt = iso => (iso ? new Date(iso).toLocaleString(document.documentElement.lang) : tr('common.never'));

  async function loadLanguage(lang) {
    const file = lang.toLowerCase().startsWith('en') ? 'en' : 'pt-PT';
    t = await (await fetch(`web/i18n/${file}.json`)).json();
    document.documentElement.lang = file;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
  }

  let polling;
  async function refresh() {
    const s = await api('GET', 'admin/status');
    $('test-mode').hidden = !s.test_mode;
    $('real-mode').hidden = !!s.test_mode;
    $('version').textContent = s.version;
    $('session').textContent = tr(s.session_valid === null ? 'status.session_unknown' : s.session_valid ? 'status.session_valid' : 'status.session_expired');
    $('queue').textContent = String(s.queue_length);
    $('account-state').textContent = s.credentials.configured ? tr('account.configured', { email: s.credentials.email }) : tr('account.missing');
    $('account-remove').hidden = !s.credentials.configured;
    renderLogin(s.login);
    return s;
  }

  function renderLogin(login) {
    $('login-state').textContent = tr(`login.state.${login.state}`);
    const active = login.state === 'starting' || login.state === 'waiting_user';
    $('login-start').hidden = active;
    $('login-cancel').hidden = !active;
    const frame = $('vnc');
    if (login.state === 'waiting_user' && frame.hidden) {
      const base = location.pathname.replace(/[^/]*$/, '').replace(/^\//, '');
      frame.src = `vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=${encodeURIComponent(base + 'vnc/websockify')}`;
      frame.hidden = false;
    } else if (!active) {
      frame.hidden = true;
      frame.removeAttribute('src');
    }
    clearTimeout(polling);
    if (active) polling = setTimeout(() => refresh().catch(fail), 2000);
  }

  async function loadTokens() {
    const { tokens } = await api('GET', 'admin/tokens');
    const body = $('tokens');
    body.replaceChildren(...tokens.filter(k => !k.revoked_at).map(k => {
      const row = document.createElement('tr');
      for (const text of [k.name, tr(`tokens.kind_${k.kind}`), fmt(k.last_used_at)]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      const cell = document.createElement('td');
      const btn = document.createElement('button');
      btn.textContent = tr('tokens.revoke');
      btn.onclick = async () => { if (!confirm(tr('tokens.revoke_confirm', { name: k.name }))) return; await api('DELETE', `admin/tokens/${k.id}`).catch(fail); loadTokens().catch(fail); };
      cell.append(btn); row.append(cell);
      return row;
    }));
  }

  $('check-session').onclick = async () => { show('status.checking'); await api('POST', 'admin/session/check').catch(fail); await refresh().catch(fail); show('common.done'); };
  $('account-form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('PUT', 'admin/credentials', { email: f.get('email'), password: f.get('password') }); e.target.reset(); show('account.saved'); } catch (err) { fail(err); }
    refresh().catch(fail);
  };
  $('account-remove').onclick = async () => { if (!confirm(tr('account.remove_confirm'))) return; await api('DELETE', 'admin/credentials').catch(fail); refresh().catch(fail); };
  $('login-start').onclick = async () => { try { renderLogin(await api('POST', 'admin/login')); } catch (e) { fail(e); } };
  $('login-cancel').onclick = async () => { await api('DELETE', 'admin/login').catch(fail); refresh().catch(fail); };
  $('token-form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const created = await api('POST', 'admin/tokens', { name: f.get('name'), kind: f.get('kind') });
      $('new-token-value').textContent = created.token;
      $('new-token').hidden = false;
      e.target.reset();
      loadTokens().catch(fail);
    } catch (err) { fail(err); }
  };

  (async () => {
    const s = await api('GET', 'admin/status');
    await loadLanguage(s.language || navigator.language || 'pt-PT');
    await refresh();
    await loadTokens();
  })().catch(fail);
})();
