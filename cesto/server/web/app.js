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
    renderContinente(s.continente);
    return s;
  }

  function renderContinente(c) {
    $('cmcp-available').textContent = tr(!c ? 'continente.unknown' : c.available ? 'continente.available' : 'continente.unavailable');
    $('cmcp-token').textContent = c ? tr(`continente.token_${c.token}`) : '';
    $('cmcp-fingerprint').textContent = c ? c.fingerprint : '';
    $('cmcp-approve').hidden = !c || c.token !== 'pending_approval';
    const link = $('cmcp-open');
    link.hidden = !(c && c.addon_slug);
    if (c && c.addon_slug) link.href = `/hassio/ingress/${encodeURIComponent(c.addon_slug)}`;
    clearTimeout(polling);
    if (c && (c.token === 'pending_approval' || c.signing_in)) polling = setTimeout(() => refresh().catch(fail), 5000);
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

  async function loadConnectors() {
    const { connectors } = await api('GET', 'admin/connectors');
    $('connectors').replaceChildren(...connectors.map(c => {
      const li = document.createElement('li');
      const caps = c.capabilities.map(k => tr(`connectors.capability.${k}`)).join(', ');
      li.textContent = caps ? `${c.name} (${caps})` : c.name;
      return li;
    }));
  }

  // Default LAN address: the host this page was opened from, on the add-on port. The admin can change it.
  $('pair-address').value = `http://${location.hostname}:8099`;
  $('pair-form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const p = await api('POST', 'admin/pair', { name: f.get('name'), address: f.get('address') });
      $('pair-qr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.qr_svg)}`;
      $('pair-address-value').textContent = p.address;
      $('pair-token-value').textContent = p.token;
      $('pair-result').hidden = false;
      e.target.elements.name.value = '';
      loadTokens().catch(fail);
    } catch (err) { fail(err); }
  };
  $('import').onclick = async () => {
    const file = $('import-file').files[0];
    if (!file) return;
    if (!confirm(tr('import.confirm'))) return;
    try {
      const { imported } = await api('POST', 'admin/import', JSON.parse(await file.text()));
      show('import.done', imported);
    } catch (err) { fail(err instanceof SyntaxError ? new Error('error.import_format') : err); }
  };

  (async () => {
    const s = await api('GET', 'admin/status');
    await loadLanguage(s.language || navigator.language || 'pt-PT');
    await refresh();
    await loadTokens();
    await loadConnectors();
  })().catch(fail);
})();
