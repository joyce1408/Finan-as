// moeda.js — máscara de moeda para campos de digitação (não só exibição).
// Uso: <input type="text" inputmode="numeric" id="meuCampo"> e depois, no JS,
// aplicarMascaraMoeda(document.getElementById('meuCampo')).
// Pra ler o valor de volta como número: valorNumericoDoInput(input).

function aplicarMascaraMoeda(input) {
  if (!input || input.dataset.mascaraAplicada) return;
  input.dataset.mascaraAplicada = '1';
  input.setAttribute('inputmode', 'numeric');

  input.addEventListener('input', () => {
    const digitos = input.value.replace(/\D/g, '');
    if (!digitos) { input.value = ''; return; }
    const numero = parseInt(digitos, 10) / 100;
    input.value = numero.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  });
}

function valorNumericoDoInput(input) {
  const digitos = (input.value || '').replace(/\D/g, '');
  if (!digitos) return NaN;
  return parseInt(digitos, 10) / 100;
}

// Preenche um input com máscara já aplicada a partir de um número (pra edição)
function definirValorMascarado(input, numero) {
  if (numero === null || numero === undefined || isNaN(numero)) { input.value = ''; return; }
  input.value = Number(numero).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

window.aplicarMascaraMoeda = aplicarMascaraMoeda;
window.valorNumericoDoInput = valorNumericoDoInput;
window.definirValorMascarado = definirValorMascarado;
