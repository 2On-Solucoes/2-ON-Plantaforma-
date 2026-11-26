/**
 * 2 ON Streaming — Lobby (escolher → criar | entrar)
 *
 * Responsabilidade ÚNICA: a interface do lobby (vistas, validação, foco, histórico).
 * Não sabe nada de rede. Comunica com o streaming.js por eventos no `document`:
 *
 *   emite  → lobby:create  { name }
 *            lobby:join    { name, code }
 *   recebe ← lobby:error   { message }          erro do servidor / da ligação
 *            lobby:reset                         voltar à vista inicial (saiu da sala, sessão expirou…)
 *            lobby:show    { view, code? }       abrir uma vista (ex.: link de convite)
 *
 * Vistas: "choose" (escolha), "create" (só o painel de criar), "join" (só o painel de entrar).
 * Cada vista, exceto "choose", tem um botão "Voltar ao Streaming".
 */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    nameKey: 'assistir_juntos_name',
    nameMax: 24,
    codeLength: 5,
    busyTimeoutMs: 12000,
    hashes: { create: '#criar', join: '#entrar' }
  });
  const VIEWS = ['choose', 'create', 'join'];

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const emit = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail }));
  const storage = {
    get: key => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* sem armazenamento */ } }
  };

  const root = $('[data-lobby]');
  if (!root) return;

  const views = Object.fromEntries(VIEWS.map(v => [v, $(`[data-lobby-view="${v}"]`, root)]));
  const els = {
    hostName: $('#host-name'), viewerName: $('#viewer-name'), code: $('#input-code'),
    create: $('#btn-create'), join: $('#btn-join'), paste: $('#btn-paste-code'),
    errors: { create: $('#error-create'), join: $('#error-join') }
  };
  const BUSY_LABEL = { create: 'A criar…', join: 'A entrar…' };

  const state = { view: 'choose', busy: null, busyTimer: 0, lastTrigger: null, lastAction: 'create' };

  /* ---------- utilitários ---------- */
  const cleanName = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, CONFIG.nameMax);
  const cleanCode = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CONFIG.codeLength);
  const lobbyIsVisible = () => !!root.offsetParent || root.classList.contains('active');

  function setError(view, message) {
    const el = els.errors[view];
    if (el) el.textContent = message || '';
    const input = view === 'create' ? els.hostName : null;
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
  const clearErrors = () => { setError('create', ''); setError('join', ''); els.viewerName.removeAttribute('aria-invalid'); els.code.removeAttribute('aria-invalid'); };

  /* ---------- estado "a trabalhar" ---------- */
  function setBusy(action) {
    clearTimeout(state.busyTimer);
    state.busy = action;
    const buttons = { create: els.create, join: els.join };
    Object.entries(buttons).forEach(([name, btn]) => {
      const busy = action === name;
      btn.disabled = !!action;
      btn.setAttribute('aria-busy', String(busy));
      btn.classList.toggle('is-busy', busy);
      if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
      btn.textContent = busy ? BUSY_LABEL[name] : btn.dataset.label;
    });
    if (action) {
      state.busyTimer = setTimeout(() => fail('Sem resposta do servidor. Verifica a ligação e tenta outra vez.'), CONFIG.busyTimeoutMs);
    }
  }

  function fail(message) {
    setBusy(null);
    const target = state.view === 'choose' ? state.lastAction : state.view;
    if (state.view === 'choose') show(target, { focus: false, push: false });
    setError(target, message);
  }

  /* ---------- vistas ---------- */
  function show(view, { focus = true, push = true } = {}) {
    if (!VIEWS.includes(view)) view = 'choose';
    const previous = state.view;
    state.view = view;
    root.dataset.view = view;

    VIEWS.forEach(v => {
      const el = views[v];
      const active = v === view;
      el.hidden = !active;
      el.classList.toggle('is-entering', active && v !== previous);
    });

    if (view === 'choose') {
      clearErrors();
    } else {
      state.lastAction = view;
    }

    // Só se cria entrada de histórico ao ABRIR um painel (choose → create|join); voltar usa history.back().
    if (push && view !== 'choose' && previous === 'choose') {
      try { history.pushState({ lobby: view }, '', CONFIG.hashes[view]); } catch { /* sem history */ }
    }
    if (focus) moveFocus(view, previous);
    if (view !== 'choose') root.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  function moveFocus(view, previous) {
    requestAnimationFrame(() => {
      if (view === 'choose') {
        const back = state.lastTrigger && document.contains(state.lastTrigger) ? state.lastTrigger : $('[data-lobby-go="' + (previous === 'join' ? 'join' : 'create') + '"]', views.choose);
        back?.focus({ preventScroll: true });
        return;
      }
      const input = view === 'create' ? (els.hostName.value ? els.create : els.hostName)
                                      : (!els.viewerName.value ? els.viewerName : (els.code.value.length < CONFIG.codeLength ? els.code : els.join));
      input.focus({ preventScroll: true });
    });
  }

  /** "Voltar": se o painel foi aberto por nós, recua no histórico (o popstate muda a vista); senão, limpa o endereço. */
  function goBack() {
    if (history.state && history.state.lobby && history.state.lobby !== 'choose') { history.back(); return; }
    show('choose', { push: false });
    if (location.hash === CONFIG.hashes.create || location.hash === CONFIG.hashes.join) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sem history */ }
    }
  }

  /* ---------- submissão ---------- */
  function submitCreate(event) {
    event.preventDefault();
    if (state.busy) return;
    const name = cleanName(els.hostName.value);
    if (!name) { setError('create', 'Escreve o teu nome antes de criar a sessão.'); els.hostName.focus(); return; }
    setError('create', '');
    els.hostName.value = name;
    storage.set(CONFIG.nameKey, name);
    setBusy('create');
    emit('lobby:create', { name });
  }

  function submitJoin(event) {
    event.preventDefault();
    if (state.busy) return;
    const name = cleanName(els.viewerName.value);
    const code = cleanCode(els.code.value);
    els.code.value = code;
    if (!name) { setError('join', 'Escreve o teu nome antes de entrar na sessão.'); els.viewerName.setAttribute('aria-invalid', 'true'); els.viewerName.focus(); return; }
    els.viewerName.removeAttribute('aria-invalid');
    if (code.length < CONFIG.codeLength) { setError('join', `O código tem ${CONFIG.codeLength} letras ou números.`); els.code.setAttribute('aria-invalid', 'true'); els.code.focus(); return; }
    els.code.removeAttribute('aria-invalid');
    setError('join', '');
    els.viewerName.value = name;
    storage.set(CONFIG.nameKey, name);
    setBusy('join');
    emit('lobby:join', { name, code });
  }

  async function pasteCode() {
    try {
      const text = await navigator.clipboard.readText();
      els.code.value = cleanCode(text);
      setError('join', '');
      (els.viewerName.value ? els.join : els.viewerName).focus();
    } catch {
      setError('join', 'Não consegui aceder à área de transferência — cola manualmente.');
      els.code.focus();
    }
  }

  /* ---------- ligações ---------- */
  function bind() {
    // navegação entre vistas (delegação: um único listener)
    root.addEventListener('click', e => {
      const trigger = e.target.closest('[data-lobby-go]');
      if (!trigger || state.busy) return;
      if (trigger.dataset.lobbyGo === 'choose') return goBack();
      state.lastTrigger = trigger;
      show(trigger.dataset.lobbyGo);
    });

    views.create.addEventListener('submit', submitCreate);
    views.join.addEventListener('submit', submitJoin);
    els.paste.addEventListener('click', pasteCode);
    els.code.addEventListener('input', () => { els.code.value = cleanCode(els.code.value); });
    [els.hostName, els.viewerName, els.code].forEach(input => input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid'); setError(state.view, '');
    }));

    // Escape = voltar; botão "voltar" do Android/navegador = voltar
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && lobbyIsVisible() && state.view !== 'choose' && !state.busy) goBack();
    });
    window.addEventListener('popstate', e => {
      if (!lobbyIsVisible()) return;
      const view = (e.state && e.state.lobby) || (location.hash === CONFIG.hashes.create ? 'create' : location.hash === CONFIG.hashes.join ? 'join' : 'choose');
      show(view, { push: false });
    });

    // comunicação com o streaming.js
    document.addEventListener('lobby:error', e => fail((e.detail && e.detail.message) || 'Algo correu mal. Tenta outra vez.'));
    document.addEventListener('lobby:reset', () => {
      setBusy(null);
      show('choose', { focus: false, push: false });
      if (location.hash === CONFIG.hashes.create || location.hash === CONFIG.hashes.join) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sem history */ }
      }
    });
    document.addEventListener('lobby:show', e => {
      const { view, code } = e.detail || {};
      if (code) els.code.value = cleanCode(code);
      show(view, { push: false });
    });
  }

  function init() {
    const saved = cleanName(storage.get(CONFIG.nameKey));
    if (saved) { els.hostName.value = saved; els.viewerName.value = saved; }
    bind();
    const initial = location.hash === CONFIG.hashes.create ? 'create' : location.hash === CONFIG.hashes.join ? 'join' : 'choose';
    show(initial, { focus: false, push: false });
  }

  init();
})();
