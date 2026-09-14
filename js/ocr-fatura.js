// ocr-fatura.js — parser do texto bruto extraído por OCR (Tesseract.js) de
// uma FOTO de fatura. Diferente do CSV (colunas bem definidas), aqui cada
// linha reconhecida pode ter ruído — então procuramos um padrão de data e
// um padrão de valor em qualquer lugar da linha, e tratamos o resto como
// descrição. Linhas sem os dois padrões são ignoradas (aparecem como
// "não reconhecidas" na prévia, pra Joyce decidir se cadastra manualmente).

function extrairData(linha, anoReferencia, mesReferencia) {
  // formato completo: dd/mm/aaaa
  let m = linha.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let [, dia, mes, ano] = m;
    dia = parseInt(dia, 10);
    mes = parseInt(mes, 10);
    ano = parseInt(ano, 10);
    if (ano < 100) ano += 2000;
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    return { iso: new Date(ano, mes - 1, dia).toISOString(), textoEncontrado: m[0] };
  }

  // formato sem ano: dd/mm — é assim que a MAIORIA das faturas de cartão
  // mostra cada lançamento (o ano só aparece uma vez, no vencimento)
  m = linha.match(/\b(\d{1,2})[\/.\-](\d{1,2})\b/);
  if (m && anoReferencia) {
    let [, dia, mes] = m;
    dia = parseInt(dia, 10);
    mes = parseInt(mes, 10);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;

    // se o mês do lançamento for "depois" do mês de fechamento da fatura,
    // ele é do ano anterior (ex.: fatura fecha em janeiro, lançamento de
    // dezembro pertence ao ano passado)
    let ano = anoReferencia;
    if (mesReferencia && mes > mesReferencia) ano -= 1;

    return { iso: new Date(ano, mes - 1, dia).toISOString(), textoEncontrado: m[0] };
  }

  return null;
}

// Procura em qualquer lugar do texto uma data completa (dd/mm/aaaa) — faturas
// sempre têm pelo menos uma (o vencimento), que usamos como referência de ano
// para interpretar as datas sem ano de cada lançamento.
function detectarAnoDeReferencia(textoCompleto) {
  const m = textoCompleto.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!m) return { ano: new Date().getFullYear(), mes: null };

  let ano = parseInt(m[3], 10);
  if (ano < 100) ano += 2000;
  const mes = parseInt(m[2], 10);

  return { ano, mes };
}

function extrairValor(linha) {
  // prioridade 1: valor no formato brasileiro (vírgula decimal), de preferência
  // no fim da linha — é assim que extratos/faturas costumam exibir o valor
  let m = linha.match(/(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/);
  if (m) return { valor: parseFloat(m[1].replace(/\./g, '').replace(',', '.')), textoEncontrado: m[0] };

  // fallback: mesmo padrão em qualquer posição da linha, não só no fim
  m = linha.match(/(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (m) return { valor: parseFloat(m[1].replace(/\./g, '').replace(',', '.')), textoEncontrado: m[0] };

  // fallback final: decimal com ponto (formato não-BR, caso o OCR tenha lido assim)
  m = linha.match(/(-?\d+\.\d{2})\s*$/);
  if (m) return { valor: parseFloat(m[1]), textoEncontrado: m[0] };

  return null;
}

function limparDescricao(linha, data, valorInfo) {
  let limpo = linha;
  if (data) limpo = limpo.replace(data.textoEncontrado, '');
  if (valorInfo) limpo = limpo.replace(valorInfo.textoEncontrado, '');
  limpo = limpo.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—.:]+|[\s\-–—.:]+$/g, '').trim();
  return limpo || 'Compra';
}

/**
 * Recebe o texto bruto reconhecido pelo OCR e devolve:
 * { validos: [{data, descricao, valor}], ignoradas: [{linha, motivo}] }
 */
function parseTextoOCR(textoBruto) {
  const { ano: anoReferencia, mes: mesReferencia } = detectarAnoDeReferencia(textoBruto);

  const linhas = textoBruto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2);

  const validos = [];
  const ignoradas = [];

  for (const linha of linhas) {
    const data = extrairData(linha, anoReferencia, mesReferencia);
    const valorInfo = extrairValor(linha);

    if (!data) { ignoradas.push({ linha, motivo: 'Não encontrei uma data nessa linha' }); continue; }
    if (!valorInfo) { ignoradas.push({ linha, motivo: 'Não encontrei um valor nessa linha' }); continue; }
    if (valorInfo.valor <= 0) { ignoradas.push({ linha, motivo: 'Valor inválido' }); continue; }

    validos.push({
      data: data.iso,
      descricao: limparDescricao(linha, data, valorInfo),
      valor: valorInfo.valor
    });
  }

  return { validos, ignoradas };
}

if (typeof window !== 'undefined') {
  window.OcrFatura = { parseTextoOCR, extrairData, extrairValor, detectarAnoDeReferencia };
}
if (typeof module !== 'undefined') {
  module.exports = { parseTextoOCR, extrairData, extrairValor, detectarAnoDeReferencia };
}
