// datas.js — datas FINANCEIRAS do app, independentes de fuso horário.
//
// Regra: toda data financeira (compra, receita, aporte, fechamento,
// vencimento) é um DIA de calendário "AAAA-MM-DD", nunca um instante no
// tempo. Um dia de calendário não muda conforme o fuso do aparelho
// (São Paulo, UTC, Tokyo...). Por isso:
//   • gravações novas guardam só "AAAA-MM-DD";
//   • registros antigos, que foram gravados como instante UTC
//     (ex.: "2026-09-12T03:00:00.000Z", resultado de toISOString() num
//     aparelho em São Paulo), são LIDOS convertendo o instante para o
//     fuso de origem em que foram criados — America/Sao_Paulo, que não
//     tem horário de verão desde 2019, ou seja, UTC−3 fixo. Nada é
//     regravado: a conversão acontece só na leitura, o dado guardado
//     continua exatamente como está.
//   • "hoje" é sempre o dia do calendário local do aparelho (é o dia que a
//     pessoa está vivendo quando lança um gasto).

(function (raiz) {
  // Fuso em que os registros antigos (com horário) foram criados.
  const OFFSET_ORIGEM_LEGADO_MIN = -180; // America/Sao_Paulo = UTC−03:00

  let relogio = () => new Date();

  function pad2(n) { return String(n).padStart(2, '0'); }

  function ehDiaISO(valor) {
    return typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor);
  }

  function ehMesISO(valor) {
    return typeof valor === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(valor);
  }

  function diaValido(ano, mes, dia) {
    if (!(mes >= 1 && mes <= 12) || !(dia >= 1)) return false;
    return dia <= new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  }

  function montarDiaISO(ano, mes, dia) {
    return `${String(ano).padStart(4, '0')}-${pad2(mes)}-${pad2(dia)}`;
  }

  // Dia do calendário LOCAL do aparelho para um objeto Date.
  function diaLocalDe(data) {
    return montarDiaISO(data.getFullYear(), data.getMonth() + 1, data.getDate());
  }

  // Converte qualquer representação de data financeira para "AAAA-MM-DD".
  // Devolve null quando não dá para interpretar.
  function diaFinanceiro(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    if (valor instanceof Date) return isNaN(valor) ? null : diaLocalDe(valor);
    if (typeof valor !== 'string') return null;
    if (ehDiaISO(valor)) return valor;

    const m = valor.match(/^(\d{4})-(\d{2})-(\d{2})T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/);
    if (!m) return null;
    if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`; // sem fuso: vale o dia escrito

    const instante = Date.parse(valor);
    if (isNaN(instante)) return null;
    const noFusoDeOrigem = new Date(instante + OFFSET_ORIGEM_LEGADO_MIN * 60000);
    return montarDiaISO(noFusoDeOrigem.getUTCFullYear(), noFusoDeOrigem.getUTCMonth() + 1, noFusoDeOrigem.getUTCDate());
  }

  function mesFinanceiro(valor) {
    const dia = diaFinanceiro(valor);
    return dia ? dia.slice(0, 7) : null;
  }

  function partesDoDia(valor) {
    const dia = diaFinanceiro(valor);
    if (!dia) return null;
    const [ano, mes, d] = dia.split('-').map(Number);
    return { ano, mes, dia: d };
  }

  function diaDoMes(valor) {
    const p = partesDoDia(valor);
    return p ? p.dia : null;
  }

  function agora() { return relogio(); }
  function hojeISO() { return diaLocalDe(relogio()); }
  function mesAtualISO() { return hojeISO().slice(0, 7); }

  function somarMesISO(mesISO, delta) {
    const [ano, mes] = mesISO.split('-').map(Number);
    const total = ano * 12 + (mes - 1) + delta;
    return `${String(Math.floor(total / 12)).padStart(4, '0')}-${pad2((total % 12 + 12) % 12 + 1)}`;
  }

  function diasNoMes(mesISO) {
    const [ano, mes] = mesISO.split('-').map(Number);
    return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  }

  // Mesmo dia do mês, projetado para outro mês (limitado ao último dia).
  function diaNoMes(mesISO, dia) {
    const [ano, mes] = mesISO.split('-').map(Number);
    return montarDiaISO(ano, mes, Math.min(dia, diasNoMes(mesISO)));
  }

  function mesesEntre(mesInicioISO, mesFimISO) {
    const meses = [];
    let atual = mesInicioISO;
    let guarda = 0;
    while (atual <= mesFimISO && guarda < 1200) {
      meses.push(atual);
      atual = somarMesISO(atual, 1);
      guarda++;
    }
    return meses;
  }

  // Diferença em dias de calendário (b − a), sem depender de fuso.
  function diferencaEmDias(diaA, diaB) {
    const a = partesDoDia(diaA);
    const b = partesDoDia(diaB);
    if (!a || !b) return null;
    return Math.round((Date.UTC(b.ano, b.mes - 1, b.dia) - Date.UTC(a.ano, a.mes - 1, a.dia)) / 86400000);
  }

  // Aceita "AAAA-MM-DD" ou "DD/MM/AAAA" digitado; devolve "AAAA-MM-DD" ou null.
  function interpretarDiaDigitado(texto) {
    if (typeof texto !== 'string') return null;
    const t = texto.trim();
    let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const [dia, mes, ano] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return diaValido(ano, mes, dia) ? montarDiaISO(ano, mes, dia) : null;
    }
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return diaValido(ano, mes, dia) ? montarDiaISO(ano, mes, dia) : null;
    }
    return null;
  }

  // Formata um dia financeiro para exibição em pt-BR sem nunca deslocar o
  // dia (a formatação é feita em UTC sobre o próprio dia de calendário).
  function formatarDia(valor, opcoes = { day: '2-digit', month: '2-digit', year: 'numeric' }) {
    const p = partesDoDia(valor);
    if (!p) return '—';
    return new Date(Date.UTC(p.ano, p.mes - 1, p.dia, 12)).toLocaleDateString('pt-BR', { ...opcoes, timeZone: 'UTC' });
  }

  const NOMES_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  function rotuloMes(mesISO) {
    if (!ehMesISO(mesISO)) return '—';
    const [ano, mes] = mesISO.split('-').map(Number);
    return `${NOMES_MES[mes - 1]}/${ano}`;
  }

  // Só para testes: fixa o "agora" do app.
  function definirRelogio(fn) { relogio = fn || (() => new Date()); }

  const Datas = {
    OFFSET_ORIGEM_LEGADO_MIN, ehDiaISO, ehMesISO, diaValido, montarDiaISO, diaLocalDe,
    diaFinanceiro, mesFinanceiro, partesDoDia, diaDoMes, agora, hojeISO, mesAtualISO,
    somarMesISO, diasNoMes, diaNoMes, mesesEntre, diferencaEmDias, interpretarDiaDigitado,
    formatarDia, rotuloMes, NOMES_MES, definirRelogio
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Datas;
  if (raiz) raiz.Datas = Datas;
})(typeof window !== 'undefined' ? window : null);
