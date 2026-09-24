// relatorios.js — visão geral, evolução diária, categorias com drill-down
// e os insights do motor de regras, tudo calculado a partir do IndexedDB real.

const CORES_CATEGORIA = ['#1B2A4A', '#2F9E62', '#C7902E', '#8A5FD1', '#E0669B', '#2F5FE0', '#C7CCD6'];

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function statusParaCor(status) {
  return status === 'ok' ? 'var(--green)' : status === 'warn' ? 'var(--amber)' : 'var(--red)';
}

function statusParaSemaforo(status) {
  return status === 'ok' ? 'green' : status === 'warn' ? 'amber' : 'red';
}

// ---------- Período de referência dos Relatórios (diagnóstico de 23/09) ----------
// Antes, "Gastos por categoria" (e os outros gráficos que dependem de mês)
// calculavam sempre em cima de DB.mesAtualISO() — o mês corrente de verdade,
// travado em new Date() — sem nenhuma forma de olhar outro mês. Resultado:
// no dia 23/09, com o gasto real registrado em agosto/2026 (competência das
// faturas), a tela sempre mostrava setembro/2026 (quase vazio). Em vez de
// criar um seletor por gráfico, existe UMA referência de mês só
// (mesReferenciaISO), navegável pelos botões ‹ › no topo da tela, e
// compartilhada por todos os componentes que dependem de período: Visão
// geral, Evolução dos gastos, Gastos por categoria e os Insights (que usam
// os mesmos totais de categoria). O valor em si continua vindo sempre de
// competenciaDespesa()/DB.gastosPorCategoria() para o mês pedido — essa
// regra não é duplicada nem alterada aqui, só passa a receber um mês
// diferente do padrão quando a usuária navega. Histórico mensal (visão fixa
// dos últimos 6 meses reais), Comprometimento do cartão (parcelas do
// PRÓXIMO mês real) e Evolução da reserva (histórico de aportes desde
// sempre) não são "o mês que estou analisando" — continuam como estavam.
let mesReferenciaISO = DB.mesAtualISO();

function rotuloMesReferencia() {
  return rotuloMes(mesReferenciaISO);
}

function renderNavPeriodo() {
  const label = document.getElementById('periodoNavLabel');
  if (label) label.textContent = rotuloMesReferencia();
  const btnProximo = document.getElementById('periodoNavProximo');
  if (btnProximo) btnProximo.disabled = mesReferenciaISO >= DB.mesAtualISO();
}

async function renderComponentesDoPeriodo() {
  renderNavPeriodo();
  await Promise.all([renderVisaoGeral(), renderGrafico(), renderCategorias(), renderInsights()]);
}

async function mudarMesReferencia(delta) {
  const alvo = DB.somarMesISO(mesReferenciaISO, delta);
  if (alvo >= DB.mesAtualISO() && delta > 0) return; // não navega pra mês futuro sem dado real
  mesReferenciaISO = alvo;
  categoriaAbertaId = null; // fecha qualquer categoria expandida — ela pertencia ao mês anterior
  await renderComponentesDoPeriodo();
}

async function renderVisaoGeral() {
  const receitas = await DB.entradasTotaisDoMes(mesReferenciaISO);
  const despesas = await DB.totalGastoNoMes(mesReferenciaISO);
  const saldo = receitas - despesas;

  const mesAnteriorAoReferencia = DB.somarMesISO(mesReferenciaISO, -1);
  const despesasMesPassado = await DB.totalGastoNoMes(mesAnteriorAoReferencia);
  let deltaTexto = '—';
  let deltaClasse = '';
  if (despesasMesPassado > 0) {
    const variacao = ((despesas - despesasMesPassado) / despesasMesPassado) * 100;
    deltaClasse = variacao <= 0 ? 'down' : 'up';
    const seta = variacao <= 0 ? '↓' : '↑';
    // Ajuste da revisão final (item 5, mantido) + correção de período: o
    // cálculo continua o mesmo (despesas confirmadas do mês analisado vs. o
    // mês imediatamente anterior a ele, via DB.totalGastoNoMes) — o texto
    // cita o mês de comparação pelo nome. "confirmados até agora" só é
    // exibido quando o mês analisado É o mês corrente de verdade (que pode
    // ainda estar em andamento); ao navegar pra um mês passado já encerrado,
    // esse texto some, porque não faria sentido falar em "até agora" de um
    // mês que já terminou. Nada disso vira previsão nem inclui parcelas
    // futuras.
    const nomeMesPassado = new Date(`${mesAnteriorAoReferencia}-02`).toLocaleDateString('pt-BR', { month: 'long' });
    const ehMesCorrenteReal = mesReferenciaISO === DB.mesAtualISO();
    deltaTexto = `${seta} ${Math.abs(variacao).toFixed(0)}% vs. ${nomeMesPassado}${ehMesCorrenteReal ? ' · confirmados até agora' : ''}`;
  }

  document.getElementById('ovReceitas').textContent = formatarMoeda(receitas);
  document.getElementById('ovDespesas').textContent = formatarMoeda(despesas);
  document.getElementById('ovSaldo').textContent = formatarMoeda(saldo);
  document.getElementById('ovDelta').textContent = deltaTexto;
  document.getElementById('ovDelta').className = `overview-delta ${deltaClasse}`;
}

function buildPath(points, w, h, padTop) {
  const max = Math.max(...points, 1);
  const stepX = w / (points.length - 1 || 1);
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = h - (p / max) * (h - padTop) - 4;
    return [x, y];
  });
  let line = `M ${coords[0][0]} ${coords[0][1]}`;
  for (let i = 1; i < coords.length; i++) line += ` L ${coords[i][0]} ${coords[i][1]}`;
  const area = line + ` L ${coords[coords.length - 1][0]} ${h} L ${coords[0][0]} ${h} Z`;
  return { line, area };
}

async function renderGrafico() {
  const gastosDiarios = await DB.gastosDiariosDoMes(mesReferenciaISO);
  const { line, area } = buildPath(gastosDiarios, 320, 80, 12);
  document.getElementById('linePath').setAttribute('d', line);
  document.getElementById('areaPath').setAttribute('d', area);

  const totalDias = gastosDiarios.length;
  document.getElementById('lblInicio').textContent = '1';
  document.getElementById('lblMeio').textContent = String(Math.round(totalDias / 2));
  document.getElementById('lblFim').textContent = String(totalDias);
}

// ---------- Histórico mensal (regra 5) — visão ADICIONAL, não substitui o
// gráfico diário do mês atual acima. Mostra o total gasto por COMPETÊNCIA
// financeira em cada um dos últimos meses (Julho/2026, Agosto/2026...),
// respeitando a mesma regra de sempre: despesa de cartão conta no mês da
// fatura dela, não em quando a fatura foi paga nem no mês da data real.
const NOMES_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function rotuloMes(mesISO) {
  const [ano, mes] = mesISO.split('-').map(Number);
  return `${NOMES_MES[mes - 1]}/${ano}`;
}

async function renderHistoricoMensal() {
  const mesFim = DB.mesAtualISO();
  const mesInicio = DB.somarMesISO(mesFim, -5); // últimos 6 meses, incluindo o atual
  const historico = await DB.historicoGastosMensais(mesInicio, mesFim);

  const lista = document.getElementById('historicoMensalList');
  const maior = Math.max(...historico.map((h) => h.total), 1);

  lista.innerHTML = historico.map((h) => {
    const pct = Math.max((h.total / maior) * 100, h.total > 0 ? 3 : 0);
    const ehMesAtual = h.mesISO === mesFim;
    return `
      <div class="bar-row">
        <div class="bar-row-top">
          <div class="bar-name">${rotuloMes(h.mesISO)}${ehMesAtual ? ' <span style="color:var(--ink-soft);font-weight:400">(atual)</span>' : ''}</div>
          <div class="bar-right"><span class="bar-value">${formatarMoeda(h.total)}</span></div>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%; background:#2F5FE0"></div></div>
      </div>
    `;
  }).join('');
}

// ---------- Gastos por categoria (correção de 24/09) ----------
// Antes, esta seção agrupava as despesas em 5 "grupos" fixos (Essenciais,
// Alimentação, Transporte, Lazer, Outros — sempre nessa ordem, sempre as 5
// colunas, mesmo zeradas) e o "percentual" mostrado era percentualDoLimite
// (gasto ÷ orçamento da categoria), não o percentual do total do mês. Isso
// não respondia "em quais categorias estou gastando mais" — não tinha
// ordenação por valor, dava o mesmo destaque a quem gastou R$0 e a quem
// concentrava o gasto todo, e o percentual não somava ~100%.
//
// Agora a lista usa diretamente o retorno de DB.gastosPorCategoria() (a
// mesma regra de sempre: só confirmado, competência via competenciaDespesa),
// ordenado por total decrescente. O percentual mostrado é
// categoria.total / totalConfirmadoDoMes * 100 — nunca percentualDoLimite,
// que não é mais usado aqui. Categorias com total 0 vão pra uma área
// secundária (chips), sem o mesmo destaque das que têm gasto. Nada disso
// redistribui despesa nenhuma: cada categoria mostra exatamente o que já
// está no IndexedDB (ver regra 7 do diagnóstico — as despesas do backup
// que vieram como "Outros" continuam em "Outros").
let categoriaAbertaId = null;

async function renderCategorias() {
  const categorias = await DB.gastosPorCategoria(mesReferenciaISO);
  const totalConfirmadoDoMes = categorias.reduce((soma, c) => soma + c.total, 0);

  // despesasDetalhadas() já calcula mesCompetencia = competenciaDespesa(d,
  // mapaFatura) pra cada despesa (fatura.mesFatura quando há faturaId) — só
  // reaproveita aqui pro drill-down, não recalcula a regra de novo.
  const detalhadas = await DB.despesasDetalhadas();

  window._categoriasDoMesRelatorio = categorias;
  window._totalConfirmadoDoMesRelatorio = totalConfirmadoDoMes;
  window._mapaDetalheDespesaRelatorio = Object.fromEntries(detalhadas.map((d) => [d.id, d]));

  const labelPeriodo = document.getElementById('categoriasPeriodoLabel');
  if (labelPeriodo) labelPeriodo.textContent = `— ${rotuloMes(mesReferenciaISO)}`;

  desenharListaCategorias();
}

// Redesenha a lista a partir do que já foi buscado em renderCategorias()
// (window._categoriasDoMesRelatorio) — chamada tanto pelo render inicial
// quanto por toggleDrillCategoria(), sem precisar buscar no banco de novo
// só pra abrir/fechar um item.
function desenharListaCategorias() {
  const categorias = window._categoriasDoMesRelatorio || [];
  const totalConfirmadoDoMes = window._totalConfirmadoDoMesRelatorio || 0;

  const comGasto = categorias.filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  const semGasto = categorias.filter((c) => c.total === 0);

  const lista = document.getElementById('barChartRow');
  lista.innerHTML = comGasto.length === 0
    ? `<div style="text-align:center;padding:16px 0;color:var(--ink-soft);font-size:12.5px">Nenhum gasto confirmado em ${rotuloMes(mesReferenciaISO)}.</div>`
    : comGasto.map((c, i) => desenharLinhaCategoria(c, i, totalConfirmadoDoMes)).join('');

  const areaSemGasto = document.getElementById('categoriasSemGasto');
  areaSemGasto.innerHTML = semGasto.length === 0 ? '' : `
    <div class="cat-sem-gasto">
      <div class="cat-sem-gasto-titulo">Sem gasto em ${rotuloMes(mesReferenciaISO)}</div>
      <div class="cat-sem-gasto-chips">
        ${semGasto.map((c) => `<span class="cat-sem-gasto-chip">${c.icone || '💬'} ${c.nome}</span>`).join('')}
      </div>
    </div>
  `;
}

function desenharLinhaCategoria(categoria, indice, totalConfirmadoDoMes) {
  // percentual = valor da categoria ÷ total de gastos confirmados do
  // período × 100 (nunca percentualDoLimite)
  const percentual = totalConfirmadoDoMes > 0 ? (categoria.total / totalConfirmadoDoMes) * 100 : 0;
  const cor = CORES_CATEGORIA[indice % CORES_CATEGORIA.length];
  const idLinha = categoria.id ?? 'orfa';
  const aberta = categoriaAbertaId !== null && String(categoriaAbertaId) === String(idLinha);

  return `
    <div class="cat-row ${aberta ? 'open' : ''}">
      <div class="cat-row-head" onclick="toggleDrillCategoria('${idLinha}')">
        <div class="cat-icon">${categoria.icone || '💬'}</div>
        <div class="cat-info">
          <div class="cat-name">${categoria.nome}</div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${percentual.toFixed(0)}%; background:${cor}"></div></div>
        </div>
        <div class="cat-amount">
          <div class="cat-amount-value">${formatarMoeda(categoria.total)}</div>
          <div class="cat-amount-pct">${percentual.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</div>
        </div>
        <div class="chevron">▾</div>
      </div>
      <div class="drill"><div class="drill-inner">${montarDrillItensCategoria(categoria)}</div></div>
    </div>
  `;
}

// Detalhamento (regra 6): descrição, valor e data já vinham do drill-down
// anterior — acrescenta parcela (só quando parcelaTotal > 1) e competência
// da fatura (só quando faturaId existir, usando mesCompetencia já calculado
// por competenciaDespesa/despesasDetalhadas — nunca a data real da compra).
function montarDrillItensCategoria(categoria) {
  const mapaDetalhe = window._mapaDetalheDespesaRelatorio || {};
  if (categoria.itens.length === 0) {
    return '<div style="font-size:12px;color:var(--ink-soft)">Nenhuma despesa registrada aqui.</div>';
  }
  return categoria.itens
    .slice()
    .sort((a, b) => new Date(b.data) - new Date(a.data))
    .map((item) => {
      const detalhe = mapaDetalhe[item.id];
      const partes = [new Date(item.data).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })];
      if (item.parcelaTotal > 1) partes.push(`Parcela ${item.parcelaAtual}/${item.parcelaTotal}`);
      if (item.faturaId != null && detalhe) partes.push(`Competência ${rotuloMes(detalhe.mesCompetencia)} (fatura)`);
      return `
        <div class="drill-item">
          <div>
            <div class="drill-name">${item.descricao || categoria.nome}</div>
            <div class="drill-date">${partes.join(' · ')}</div>
          </div>
          <div class="drill-value">${formatarMoeda(item.valorParcela)}</div>
        </div>
      `;
    }).join('');
}

function toggleDrillCategoria(idLinha) {
  categoriaAbertaId = (categoriaAbertaId !== null && String(categoriaAbertaId) === String(idLinha)) ? null : idLinha;
  desenharListaCategorias();
}

async function renderInsights() {
  const renda = await DB.entradasTotaisDoMes(mesReferenciaISO);
  const categorias = await DB.gastosPorCategoria(mesReferenciaISO);
  const gastoEstiloVida = categorias.filter((c) => c.tipo === 'estilo_de_vida').reduce((s, c) => s + c.total, 0);

  const poupanca = Motor.avaliarPoupanca(renda, gastoEstiloVida);

  const reservas = await DB.listarTodos('reserva');
  const reserva = reservas[0] || { valorAtual: 0, meta: 15000 };
  const textoInvestimento = Motor.recomendarInvestimento(reserva.valorAtual, reserva.meta, 12);

  document.getElementById('insightsBox').innerHTML = `
    <div class="insight-card ${poupanca.alerta ? 'alert' : 'save'}">
      <div class="insight-icon">${poupanca.alerta ? '✂️' : '✅'}</div>
      <div>
        <div class="insight-title">${poupanca.alerta ? 'Corte sugerido' : 'Gastos sob controle'}</div>
        <div class="insight-text">${poupanca.texto}</div>
      </div>
    </div>
    <div class="insight-card invest">
      <div class="insight-icon">📈</div>
      <div>
        <div class="insight-title">Onde investir a sobra</div>
        <div class="insight-text">${textoInvestimento}</div>
      </div>
    </div>
  `;
}

async function renderComprometimento() {
  const renda = await DB.entradasTotaisDoMes();
  const parcelas = await DB.parcelasProximoMes();
  const avaliacao = Motor.avaliarComprometimentoCartao(parcelas, renda);
  const percentual = renda > 0 ? (parcelas / renda) * 100 : 0;
  const status = Motor.statusLimite(percentual);

  document.getElementById('commitPct').textContent = `${percentual.toFixed(0)}%`;
  document.getElementById('commitPct').style.color = statusParaCor(status);
  document.getElementById('commitFill').style.width = `${Math.min(percentual, 100).toFixed(0)}%`;
  document.getElementById('commitFill').style.background = statusParaCor(status);
  document.getElementById('commitNote').textContent = avaliacao.texto;
}

async function renderEvolucaoReserva() {
  const historico = await DB.historicoAportes();
  const card = document.getElementById('reservaChartCard');

  if (historico.length === 0) {
    card.innerHTML = `<div style="text-align:center;padding:10px 0;color:var(--ink-soft);font-size:12.5px">Nenhum aporte registrado ainda. Use o "+" e escolha "Reserva" para começar.</div>`;
    return;
  }

  const pontos = historico.map((h) => h.acumulado);
  const { line, area } = buildPath(pontos, 320, 80, 12);

  card.innerHTML = `
    <svg viewBox="0 0 320 80" preserveAspectRatio="none">
      <defs>
        <linearGradient id="fillReserva" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2F9E62" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="#2F9E62" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#fillReserva)" stroke="none"></path>
      <path d="${line}" fill="none" stroke="#2F9E62" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
    <div class="chart-labels">
      <span>${new Date(historico[0].data).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</span>
      <span>Total: ${formatarMoeda(historico[historico.length - 1].acumulado)}</span>
    </div>
  `;
}

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  renderNavPeriodo();
  await Promise.all([
    renderVisaoGeral(),
    renderGrafico(),
    renderHistoricoMensal(),
    renderCategorias(),
    renderInsights(),
    renderComprometimento(),
    renderEvolucaoReserva()
  ]);
})();
