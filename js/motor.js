// motor.js — fachada das regras de análise usadas pelas telas. As definições
// matemáticas de cada indicador ficam em js/analises.js (uma por indicador,
// sem reaproveitar percentuais entre eles). Aqui só ficam utilidades visuais.

(function (raiz) {
  const A = (typeof module !== 'undefined' && typeof require === 'function') ? require('./analises.js') : raiz.Analises;

  // Cor da barra de LIMITE DO CARTÃO (fatura ÷ limite do cartão).
  // ≥ 85% perigo, ≥ 70% atenção. Indicador visual próprio do limite.
  function statusLimite(percentual) {
    if (percentual >= 85) return 'danger';
    if (percentual >= 70) return 'warn';
    return 'ok';
  }

  const Motor = {
    statusLimite,
    avaliarComprometimentoCartao: A.avaliarComprometimentoCartao,
    avaliarGastosSobControle: A.avaliarGastosSobControle,
    avaliarBateria: A.avaliarBateria,
    avaliarOndePoupar: A.avaliarOndePoupar,
    avaliarReserva: A.avaliarReserva,
    recomendarInvestimento: A.recomendarInvestimento
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Motor;
  if (raiz) raiz.Motor = Motor;
})(typeof window !== 'undefined' ? window : null);
