/**
 * 2 ON — Core features
 * - Verificação de atualizações
 * - Ecrã "Nova atualização disponível"
 * - Sistema de notificações in-app
 * - Botão e modal de Sugestões
 *
 * Funciona tanto no browser como dentro do Capacitor (Android).
 */

(function () {
  'use strict';

  // ========== CONFIGURAÇÃO ==========
  // Altera estes valores quando fizeres uma nova versão
  const APP_VERSION = '1.0.0';           // Versão atual da app (tem de bater com versionName no Android)
  const VERSION_CHECK_URL = '/api/version'; // Endpoint do teu backend (ou ficheiro version.json)
  // Exemplo de resposta esperada do /api/version:
  // {
  //   "version": "1.1.0",
  //   "versionCode": 2,
  //   "force": false,
  //   "title": "Nova versão disponível",
  //   "message": "Corrigimos bugs e melhorámos a performance.",
  //   "downloadUrl": "https://play.google.com/store/apps/details?id=com.twoon.platform",
  //   "changelog": ["Melhorias no Streaming", "Novo sistema de sugestões"]
  // }

  const SUGGESTION_URL = '/api/suggestions'; // POST { text, name?, contact? }
  const NOTIFICATIONS_URL = '/api/notifications'; // GET lista de notificações

  // ========== ESTADO ==========
  let updateInfo = null;
  let notifications = [];

  // ========== HELPERS ==========
  function $(sel, ctx = document) { return ctx.querySelector(sel); }
  function $all(sel, ctx = document) { return Array.from(ctx.querySelectorAll(sel)); }

  function toast(msg, duration = 3200) {
    let el = $('#on-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'on-toast';
      el.style.cssText = `
        position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(20px);
        background:#0f1c2a;color:#e8f1f8;padding:12px 20px;border-radius:12px;
        font-size:14px;font-weight:500;z-index:10000;opacity:0;transition:all .3s ease;
        box-shadow:0 8px 32px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);
        max-width:90vw;text-align:center;pointer-events:none;
      `;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(20px)';
    }, duration);
  }

  // ========== 1. VERIFICAÇÃO DE ATUALIZAÇÃO ==========
  async function checkForUpdate() {
    try {
      const res = await fetch(VERSION_CHECK_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.version) return null;

      // Comparação simples de versão (1.0.0 < 1.1.0)
      if (compareVersions(data.version, APP_VERSION) > 0) {
        updateInfo = data;
        showUpdateModal(data);
        return data;
      }
    } catch (e) {
      // Silencioso — não queremos incomodar se o servidor estiver offline
      console.log('[2ON] Version check failed (normal se backend offline)');
    }
    return null;
  }

  function compareVersions(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  // ========== 2. MODAL DE ATUALIZAÇÃO ==========
  function showUpdateModal(info) {
    // Evita duplicar
    if ($('#on-update-modal')) return;

    const force = !!info.force;
    const modal = document.createElement('div');
    modal.id = 'on-update-modal';
    modal.innerHTML = `
      <div class="on-modal-backdrop"></div>
      <div class="on-modal-card on-update-card">
        <div class="on-update-badge">NOVA VERSÃO</div>
        <h2>${escapeHtml(info.title || 'Nova atualização disponível')}</h2>
        <p class="on-update-version">v${escapeHtml(info.version)} ${force ? '· Obrigatória' : ''}</p>
        <p class="on-update-msg">${escapeHtml(info.message || 'Temos melhorias e correções para ti.')}</p>
        ${info.changelog && info.changelog.length ? `
          <ul class="on-changelog">
            ${info.changelog.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
          </ul>
        ` : ''}
        <div class="on-modal-actions">
          <button class="on-btn on-btn-primary" id="on-update-now">
            Atualizar agora
          </button>
          ${!force ? `<button class="on-btn on-btn-ghost" id="on-update-later">Mais tarde</button>` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Estilos inline para não depender de CSS externo
    injectUpdateStyles();

    $('#on-update-now', modal).onclick = () => {
      let url = String(info.downloadUrl || '').trim();
      // Só abre links http(s) — bloqueia javascript:, data: e afins
      if (!/^https?:\/\/[^\s<>"']+$/i.test(url)) url = 'https://play.google.com/store/apps/details?id=com.twoon.platform';
      // Se for Capacitor, tenta abrir nativamente
      if (window.Capacitor?.Plugins?.Browser) {
        window.Capacitor.Plugins.Browser.open({ url });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    };

    if (!force) {
      $('#on-update-later', modal).onclick = () => {
        modal.remove();
        // Lembra-se por 12h para não chatear
        try { localStorage.setItem('2on_update_dismissed', Date.now().toString()); } catch {}
      };
    }
  }

  function injectUpdateStyles() {
    if ($('#on-core-styles')) return;
    const style = document.createElement('style');
    style.id = 'on-core-styles';
    style.textContent = `
      .on-modal-backdrop {
        position: fixed; inset: 0; background: rgba(6,13,21,.82);
        backdrop-filter: blur(8px); z-index: 9990;
      }
      .on-modal-card {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
        width: min(400px, 92vw); background: #0f1c2a; border-radius: 20px;
        padding: 28px 24px; z-index: 9991; border: 1px solid rgba(255,255,255,.1);
        box-shadow: 0 24px 64px rgba(0,0,0,.55); color: #e8f1f8;
        font-family: Inter, system-ui, sans-serif;
      }
      .on-update-badge {
        display: inline-block; background: #2ee59d; color: #060d15;
        font-size: 11px; font-weight: 700; letter-spacing: .06em;
        padding: 4px 10px; border-radius: 20px; margin-bottom: 14px;
      }
      .on-modal-card h2 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
      .on-update-version { color: #8aa0b3; font-size: 13px; margin: 0 0 14px; }
      .on-update-msg { font-size: 15px; line-height: 1.5; margin: 0 0 16px; color: #c5d4e0; }
      .on-changelog { margin: 0 0 22px; padding-left: 18px; color: #8aa0b3; font-size: 13.5px; }
      .on-changelog li { margin-bottom: 4px; }
      .on-modal-actions { display: flex; gap: 10px; flex-direction: column; }
      .on-btn {
        border: none; border-radius: 12px; padding: 14px 18px; font-size: 15px;
        font-weight: 600; cursor: pointer; transition: transform .15s, opacity .15s;
      }
      .on-btn:active { transform: scale(.98); }
      .on-btn-primary { background: #2ee59d; color: #060d15; }
      .on-btn-ghost { background: transparent; color: #8aa0b3; border: 1px solid rgba(255,255,255,.12); }
      .on-btn-ghost:hover { color: #e8f1f8; }

      /* Sugestão modal */
      .on-suggest-card textarea {
        width: 100%; min-height: 110px; background: #162433; border: 1px solid rgba(255,255,255,.1);
        border-radius: 12px; color: #e8f1f8; padding: 12px 14px; font-size: 15px;
        font-family: inherit; resize: vertical; margin-bottom: 12px; box-sizing: border-box;
      }
      .on-suggest-card input {
        width: 100%; background: #162433; border: 1px solid rgba(255,255,255,.1);
        border-radius: 12px; color: #e8f1f8; padding: 12px 14px; font-size: 14px;
        font-family: inherit; margin-bottom: 10px; box-sizing: border-box;
      }
      .on-suggest-card label { display: block; font-size: 12px; color: #8aa0b3; margin-bottom: 4px; }

      /* Floating suggestion button */
      #on-suggest-fab {
        position: fixed; bottom: 24px; right: 20px; z-index: 900;
        width: 52px; height: 52px; border-radius: 16px; border: none;
        background: linear-gradient(135deg, #2ee59d, #1dbf7a); color: #060d15;
        font-size: 22px; cursor: pointer; box-shadow: 0 8px 24px rgba(46,229,157,.35);
        display: flex; align-items: center; justify-content: center;
        transition: transform .2s, box-shadow .2s;
      }
      #on-suggest-fab:hover { transform: scale(1.06); box-shadow: 0 12px 28px rgba(46,229,157,.45); }
      #on-suggest-fab:active { transform: scale(.96); }

      /* Notification badge (opcional) */
      #on-notif-badge {
        position: absolute; top: -4px; right: -4px; background: #ff4d6d;
        color: white; font-size: 10px; font-weight: 700; min-width: 16px; height: 16px;
        border-radius: 8px; display: flex; align-items: center; justify-content: center;
        padding: 0 4px;
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ========== 3. BOTÃO + MODAL DE SUGESTÕES ==========
  function createSuggestionButton() {
    if ($('#on-suggest-fab')) return;

    const btn = document.createElement('button');
    btn.id = 'on-suggest-fab';
    btn.title = 'Enviar sugestão';
    btn.setAttribute('aria-label', 'Enviar sugestão');
    btn.innerHTML = '💡';
    btn.onclick = openSuggestionModal;
    document.body.appendChild(btn);
    injectUpdateStyles();
  }

  function openSuggestionModal() {
    if ($('#on-suggest-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'on-suggest-modal';
    modal.innerHTML = `
      <div class="on-modal-backdrop" id="on-suggest-backdrop"></div>
      <div class="on-modal-card on-suggest-card">
        <h2 style="margin:0 0 6px;font-size:20px;">Enviar sugestão</h2>
        <p style="margin:0 0 16px;color:#8aa0b3;font-size:14px;">
          A tua ideia ajuda a melhorar a 2 ON. O criador lê todas as mensagens.
        </p>

        <p style="font-size:11px;opacity:.65;margin:0 0 10px;line-height:1.4">
          O nome e o contacto são opcionais e usados apenas para te responder.
          As sugestões são apagadas ao fim de 180 dias; podes pedir a eliminação antes.
        </p>
        <label>A tua sugestão *</label>
        <textarea id="on-suggest-text" placeholder="Ex: Gostava de ter mais jogos... ou uma melhoria no Streaming..." maxlength="1000"></textarea>

        <label>Nome (opcional)</label>
        <input id="on-suggest-name" type="text" placeholder="Como queres ser identificado" maxlength="60">

        <label>Contacto (opcional — email ou WhatsApp)</label>
        <input id="on-suggest-contact" type="text" placeholder="Para o criador te poder responder" maxlength="120">

        <div class="on-modal-actions" style="margin-top:8px;">
          <button class="on-btn on-btn-primary" id="on-suggest-send">Enviar sugestão</button>
          <button class="on-btn on-btn-ghost" id="on-suggest-cancel">Cancelar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    $('#on-suggest-cancel', modal).onclick = () => modal.remove();
    $('#on-suggest-backdrop', modal).onclick = () => modal.remove();

    $('#on-suggest-send', modal).onclick = async () => {
      const text = ($('#on-suggest-text', modal).value || '').trim();
      const name = ($('#on-suggest-name', modal).value || '').trim();
      const contact = ($('#on-suggest-contact', modal).value || '').trim();

      if (text.length < 5) {
        toast('Escreve pelo menos algumas palavras na sugestão.');
        return;
      }

      const btn = $('#on-suggest-send', modal);
      btn.disabled = true;
      btn.textContent = 'A enviar…';

      try {
        const res = await fetch(SUGGESTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, name: name || null, contact: contact || null, source: 'app' })
        });

        if (res.status === 400) {
          toast('A sugestão é demasiado curta ou inválida.');
          return;
        }
        if (res.status === 429) {
          toast('Demasiados envios seguidos. Tenta daqui a um minuto.');
          return;
        }
        if (!res.ok) throw new Error('fail');

        modal.remove();
        toast('✅ Sugestão enviada! Obrigado.');
      } catch (e) {
        // Fallback: se não houver backend, guarda localmente e avisa
        try {
          const pending = JSON.parse(localStorage.getItem('2on_pending_suggestions') || '[]');
          pending.push({ text, name, contact, at: new Date().toISOString() });
          localStorage.setItem('2on_pending_suggestions', JSON.stringify(pending));
        } catch {}
        modal.remove();
        toast('Sugestão guardada. Será enviada quando houver ligação.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar sugestão';
      }
    };
  }

  async function flushPendingSuggestions() {
    let pending = [];
    try { pending = JSON.parse(localStorage.getItem('2on_pending_suggestions') || '[]'); } catch { return; }
    if (!Array.isArray(pending) || !pending.length) return;
    const failed = [];
    for (const s of pending) {
      try {
        const res = await fetch(SUGGESTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: s.text, name: s.name || null, contact: s.contact || null, source: 'app-offline' })
        });
        // 4xx (exceto 429) = inválida: descarta; falhas de rede/5xx/429: mantém para tentar depois
        if (!res.ok && (res.status >= 500 || res.status === 429)) failed.push(s);
      } catch { failed.push(s); }
    }
    try { localStorage.setItem('2on_pending_suggestions', JSON.stringify(failed)); } catch {}
    if (failed.length < pending.length) toast('✅ Sugestões guardadas foram enviadas.');
  }

  // ========== ATALHO SECRETO PARA O ADMIN ==========
  // 10 toques seguidos na marca "2·ON" do Painel abrem o painel administrativo.
  // (a palavra-passe continua a ser pedida no ecrã de login do Admin)
  function makeTapCounter(target, gapMs, now = () => Date.now()) {
    let count = 0, last = 0;
    return function tap() {
      const t = now();
      count = (t - last > gapMs) ? 1 : count + 1;
      last = t;
      if (count >= target) { count = 0; return true; }
      return false;
    };
  }

  function setupAdminShortcut() {
    const brand = document.querySelector('.brand');          // só existe no Painel principal
    if (!brand) return;
    const tap = makeTapCounter(10, 2000);
    brand.addEventListener('click', (e) => {
      e.preventDefault();                                     // já estamos no Painel; evita recarregar
      if (!tap()) return;
      toast('🔐 A abrir o painel administrativo…', 1500);
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = 'admin.html';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, 350);
    });
  }

  // ========== 4. INICIALIZAÇÃO ==========
  function init() {
    // Só mostra o botão de sugestão em páginas principais (não em ecrãs de jogo intensos se quiseres)
    createSuggestionButton();
    setupAdminShortcut();

    // Reenvia sugestões guardadas offline
    setTimeout(flushPendingSuggestions, 2500);
    window.addEventListener('online', flushPendingSuggestions);

    // Verifica atualização (espera um pouco para não atrasar o load)
    let dismissed = 0;
    try { dismissed = parseInt(localStorage.getItem('2on_update_dismissed') || '0', 10) || 0; } catch {}
    const twelveHours = 12 * 60 * 60 * 1000;
    if (Date.now() - dismissed > twelveHours) {
      setTimeout(checkForUpdate, 1800);
    }

    // Expõe funções úteis globalmente (para o admin ou outros scripts)
    window.ONCore = {
      version: APP_VERSION,
      checkForUpdate,
      showUpdateModal,
      openSuggestionModal,
      toast
    };
  }

  // Arranque
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
