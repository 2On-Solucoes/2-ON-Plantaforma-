/**
 * 2-ON Plataforma — painel principal
 *
 * Estrutura:
 *   1. CONFIG ........ constantes ajustáveis
 *   2. Utilitários ... seletores, preferências do utilizador, throttle por frame
 *   3. Módulos ....... cada um tem { name, init() } e falha sem afetar os outros
 *        ServerStatus · Navigation · ScrollProgress · Reveal · PointerEffects
 *        · PageVisibility · SuggestionCta · AdminGesture
 *   4. Arranque ...... corre os módulos quando o DOM está pronto
 *
 * Princípios: sem variáveis globais; ganchos via atributos data-* (o CSS decide o visual);
 * listeners passivos; animações só com transform/opacity; respeita "movimento reduzido".
 */
(() => {
  'use strict';

  /* ===================== 1. CONFIG ===================== */
  const CONFIG = Object.freeze({
    status: { pollMs: 45000, timeoutMs: 6000, endpoint: '/api/status' },
    reveal: { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    spy:    { rootMargin: '-45% 0px -50% 0px' },
    admin:  { taps: 5, windowMs: 3000, href: 'admin.html', hitArea: 56 }
  });

  /* ===================== 2. UTILITÁRIOS ===================== */
  const $  = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const prefersReducedMotion = () => motion.matches;

  /** Executa `fn` no máximo uma vez por frame (usa o último argumento recebido). */
  function rafThrottle(fn) {
    let frame = 0, lastArgs;
    return (...args) => {
      lastArgs = args;
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; fn(...lastArgs); });
    };
  }

  /* ===================== 3. MÓDULOS ===================== */

  /** Estado do servidor: cabeçalho + secção de contacto. */
  const ServerStatus = {
    name: 'ServerStatus',
    init() {
      const root = $('#serverStatus');
      const label = $('#serverStatusText');
      if (!root || !label) return;
      const info = $('#infoStatus');
      const infoVersion = $('#infoVersion');

      const render = (online, version) => {
        const state = online ? 'online' : 'offline';
        root.dataset.state = state;
        label.textContent = online ? 'Servidor online' : 'Servidor indisponível';
        if (info) { info.dataset.state = state; info.textContent = online ? 'Online' : 'Indisponível'; }
        if (infoVersion) infoVersion.textContent = version ? `v${version}` : '—';
      };

      const check = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONFIG.status.timeoutMs);
        try {
          const response = await fetch(CONFIG.status.endpoint, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          render(true, data.version);
        } catch {
          render(false, null);
        } finally {
          clearTimeout(timer);
        }
      };

      check();
      setInterval(check, CONFIG.status.pollMs);
      window.addEventListener('online', check);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    }
  };

  /** Menu móvel (acessível), estado do cabeçalho e destaque da secção ativa (scrollspy). */
  const Navigation = {
    name: 'Navigation',
    init() {
      const header = $('[data-header]');
      const nav = $('[data-nav]');
      const toggle = $('[data-nav-toggle]');

      /* --- menu móvel --- */
      if (nav && toggle) {
        const setOpen = (open, { restoreFocus = false } = {}) => {
          nav.classList.toggle('is-open', open);
          toggle.setAttribute('aria-expanded', String(open));
          toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
          if (!open && restoreFocus) toggle.focus();
        };
        toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
        nav.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
        document.addEventListener('keydown', e => {
          if (e.key === 'Escape' && nav.classList.contains('is-open')) setOpen(false, { restoreFocus: true });
        });
        document.addEventListener('click', e => {
          if (nav.classList.contains('is-open') && !e.target.closest('.site-header__bar')) setOpen(false);
        });
        window.matchMedia('(min-width: 961px)').addEventListener('change', e => { if (e.matches) setOpen(false); });
      }

      /* --- cabeçalho com sombra após rolar --- */
      if (header) {
        const update = rafThrottle(() => header.classList.toggle('is-scrolled', window.scrollY > 8));
        update();
        window.addEventListener('scroll', update, { passive: true });
      }

      /* --- scrollspy: marca a ligação da secção que está a meio do ecrã --- */
      const links = $$('[data-spy]');
      if (links.length && 'IntersectionObserver' in window) {
        const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
        const sections = [...byId.keys()].map(id => document.getElementById(id)).filter(Boolean);
        const observer = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            links.forEach(a => { a.classList.remove('is-active'); a.removeAttribute('aria-current'); });
            const active = byId.get(entry.target.id);
            if (active) { active.classList.add('is-active'); active.setAttribute('aria-current', 'true'); }
          });
        }, { rootMargin: CONFIG.spy.rootMargin });
        sections.forEach(section => observer.observe(section));
      }
    }
  };

  /** Barra de progresso de leitura (transform: scaleX, atualizada por frame). */
  const ScrollProgress = {
    name: 'ScrollProgress',
    init() {
      const bar = $('[data-scroll-progress]');
      if (!bar || prefersReducedMotion()) return;
      const update = rafThrottle(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
      });
      update();
      window.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update, { passive: true });
    }
  };

  /** Revelar ao rolar, com atraso escalonado dentro de cada grupo. */
  const Reveal = {
    name: 'Reveal',
    init() {
      const items = $$('[data-reveal]');
      const groups = $$('[data-reveal-group]');
      const revealAll = () => { items.concat(groups).forEach(el => el.classList.add('is-revealed')); };

      if (!('IntersectionObserver' in window) || prefersReducedMotion()) return revealAll();

      groups.forEach(group => {                         // índice de escalonamento por grupo
        $$('[data-reveal]', group).forEach((el, i) => el.style.setProperty('--i', i));
      });

      const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-revealed');
          obs.unobserve(entry.target);
        });
      }, CONFIG.reveal);
      items.concat(groups).forEach(el => observer.observe(el));
    }
  };

  /** Holofotes que seguem o cursor (hero e cartões). Só em dispositivos com cursor. */
  const PointerEffects = {
    name: 'PointerEffects',
    init() {
      if (!finePointer.matches || prefersReducedMotion()) return;

      const hero = $('[data-hero]');
      if (hero) {
        const move = rafThrottle((x, y) => {
          const r = hero.getBoundingClientRect();
          hero.style.setProperty('--mx', `${x - r.left}px`);
          hero.style.setProperty('--my', `${y - r.top}px`);
        });
        hero.addEventListener('pointermove', e => { hero.classList.add('has-pointer'); move(e.clientX, e.clientY); });
        hero.addEventListener('pointerleave', () => hero.classList.remove('has-pointer'));
      }

      // Delegação de eventos: um único listener para todos os cartões [data-spotlight]
      const track = rafThrottle((card, x, y) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--sx', `${x - r.left}px`);
        card.style.setProperty('--sy', `${y - r.top}px`);
      });
      document.addEventListener('pointermove', e => {
        const card = e.target.closest && e.target.closest('[data-spotlight]');
        if (card) track(card, e.clientX, e.clientY);
      }, { passive: true });
    }
  };

  /** Pausa as animações infinitas quando o separador está em segundo plano. */
  const PageVisibility = {
    name: 'PageVisibility',
    init() {
      const apply = () => document.documentElement.classList.toggle('is-paused', document.hidden);
      document.addEventListener('visibilitychange', apply);
      apply();
    }
  };

  /** Botão "Enviar sugestão" → modal do app-core (com alternativas se ainda não carregou). */
  const SuggestionCta = {
    name: 'SuggestionCta',
    init() {
      const button = $('[data-suggest]');
      if (!button) return;
      button.addEventListener('click', () => {
        const core = window.ONCore;
        if (core && typeof core.openSuggestionModal === 'function') return core.openSuggestionModal();
        const fab = $('#on-suggest-fab');
        if (fab) return fab.click();
        if (core && core.toast) core.toast('Toca no botão 💡 para enviar a tua sugestão.');
      });
    }
  };

  /** Acesso discreto ao Admin: N toques seguidos no canto inferior esquerdo. */
  const AdminGesture = {
    name: 'AdminGesture',
    init() {
      const { taps, windowMs, href, hitArea } = CONFIG.admin;
      const target = document.createElement('button');
      target.type = 'button';
      target.tabIndex = -1;
      target.setAttribute('aria-hidden', 'true');
      target.style.cssText =
        `position:fixed;left:0;bottom:0;width:${hitArea}px;height:${hitArea}px;padding:0;margin:0;border:0;` +
        'background:transparent;opacity:0;z-index:50;cursor:default;-webkit-tap-highlight-color:transparent;';

      let times = [];
      target.addEventListener('click', () => {
        const now = Date.now();
        times = times.filter(t => now - t < windowMs);
        times.push(now);
        if (times.length < taps) return;
        times = [];
        try { navigator.vibrate && navigator.vibrate(40); } catch { /* sem vibração */ }
        const link = document.createElement('a');
        link.href = href;
        document.body.appendChild(link);
        link.click();
        link.remove();
      });
      document.body.appendChild(target);
    }
  };

  /* ===================== 4. ARRANQUE ===================== */
  const MODULES = [ServerStatus, Navigation, ScrollProgress, Reveal, PointerEffects, PageVisibility, SuggestionCta, AdminGesture];

  function boot() {
    MODULES.forEach(module => {
      try { module.init(); }
      catch (error) { console.error(`[2-ON] módulo "${module.name}" falhou:`, error); }   // isolado: os outros continuam
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
