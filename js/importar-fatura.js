// importar-fatura.js — parser e fluxo de importação de fatura em CSV.
// Formato esperado (com ou sem cabeçalho): data,descricao,valor
// Datas aceitas: DD/MM/AAAA ou AAAA-MM-DD. Valor aceita vírgula ou ponto decimal.

function parseValorMonetario(texto) {
  if (typeof texto !== 'string') return NaN;
  let limpo = texto.trim().replace(/^R\$\s*/i, '');
  // Se tem vírgula e ponto, assume ponto como separador de milhar (padrão BR)
  if (limpo.includes(',') && limpo.includes('.')) {
    limpo = limpo.replace(/\./g, '').replace(',', '.');
  } else if (limpo.includes(',')) {
    limpo = limpo.replace(',', '.');
  }
  return parseFloat(limpo);
}

function parseDataFatura(texto) {
  const t = texto.trim();
  // DD/MM/AAAA
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, dia, mes, ano] = m;
    return new Date(Number(ano), Number(mes) - 1, Number(dia)).toISOString();
  }
  // AAAA-MM-DD
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, ano, mes, dia] = m;
    return new Date(Number(ano), Number(mes) - 1, Number(dia)).toISOString();
  }
  return null;
}

function pareceCabecalho(colunas) {
  const primeira = (colunas[0] || '').trim().toLowerCase();
  return ['data', 'date', 'dia'].includes(primeira);
}

// Faz o parse simples de uma linha CSV respeitando campos entre aspas.
// Usa APENAS o delimitador informado — evita confundir separador de campo
// com vírgula decimal quando o arquivo usa ';' como delimitador.
function parseLinhaCsv(linha, delimitador) {
  const campos = [];
  let atual = '';
  let dentroDeAspas = false;

  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      dentroDeAspas = !dentroDeAspas;
    } else if (c === delimitador && !dentroDeAspas) {
      campos.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

// Detecta o delimitador pela primeira linha não vazia: se houver ';' fora de
// aspas, o arquivo usa ';' (comum quando o decimal é vírgula); senão, ','.
function detectarDelimitador(primeiraLinha) {
  let dentroDeAspas = false;
  for (const c of primeiraLinha) {
    if (c === '"') dentroDeAspas = !dentroDeAspas;
    else if (c === ';' && !dentroDeAspas) return ';';
  }
  return ',';
}

/**
 * Recebe o texto bruto do CSV e devolve:
 * { validos: [{data, descricao, valor}], erros: [{linha, motivo}] }
 */
function parseFaturaCsv(textoCsv) {
  const linhas = textoCsv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (linhas.length === 0) return { validos: [], erros: [] };

  const delimitador = detectarDelimitador(linhas[0]);
  let inicio = 0;
  const primeirasColunas = parseLinhaCsv(linhas[0], delimitador);
  if (pareceCabecalho(primeirasColunas)) inicio = 1;

  const validos = [];
  const erros = [];

  for (let i = inicio; i < linhas.length; i++) {
    const colunas = parseLinhaCsv(linhas[i], delimitador);
    if (colunas.length < 3) {
      erros.push({ linha: i + 1, motivo: 'Colunas insuficientes (esperado: data, descrição, valor)' });
      continue;
    }

    const [dataTexto, descricaoTexto, valorTexto] = colunas;
    const dataISO = parseDataFatura(dataTexto);
    const valor = parseValorMonetario(valorTexto);

    if (!dataISO) {
      erros.push({ linha: i + 1, motivo: `Data inválida: "${dataTexto}"` });
      continue;
    }
    if (isNaN(valor) || valor <= 0) {
      erros.push({ linha: i + 1, motivo: `Valor inválido: "${valorTexto}"` });
      continue;
    }

    validos.push({
      data: dataISO,
      descricao: descricaoTexto.trim() || 'Compra importada',
      valor
    });
  }

  return { validos, erros };
}

// Procura "parcela 8/12" (ou "parc 8/12", "parc. 8/12") na descrição de um
// lançamento — sempre exige a palavra "parc(ela)" do lado, nunca um "N/M"
// solto, pra nunca confundir com uma data escrita como "12/09". Devolve
// {parcelaAtual, parcelaTotal} ou null quando a compra não é parcelada.
function extrairParcela(descricao) {
  if (!descricao) return null;
  const m = descricao.match(/parc(?:ela)?\.?\s*(\d{1,2})\s*\/\s*(\d{1,2})/i);
  if (!m) return null;
  const parcelaAtual = parseInt(m[1], 10);
  const parcelaTotal = parseInt(m[2], 10);
  if (!parcelaAtual || !parcelaTotal || parcelaAtual < 1 || parcelaTotal < 1 || parcelaAtual > parcelaTotal) return null;
  return { parcelaAtual, parcelaTotal };
}

if (typeof window !== 'undefined') {
  window.ImportarFatura = { parseFaturaCsv, parseValorMonetario, parseDataFatura, extrairParcela };
}
if (typeof module !== 'undefined') {
  module.exports = { parseFaturaCsv, parseValorMonetario, parseDataFatura, extrairParcela };
}
