/**
 * 2 ON Streaming — comportamento global da interface
 * Pausa as animações infinitas (luzes de fundo, pings) quando o separador está em segundo plano.
 */
(() => {
  'use strict';
  const apply = () => document.documentElement.classList.toggle('is-paused', document.hidden);
  document.addEventListener('visibilitychange', apply);
  apply();
})();
