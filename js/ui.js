// ui.js — utilidades de tela compartilhadas.
(function (raiz) {
  // Escapa texto antes de inserir via innerHTML (descrições vindas de CSV,
  // PDF ou OCR nunca podem virar HTML/script na tela).
  function escapar(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function moeda(valor) {
    return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  const UI = { escapar, moeda };
  if (typeof module !== 'undefined' && module.exports) module.exports = UI;
  if (raiz) raiz.UI = UI;
})(typeof window !== 'undefined' ? window : null);
