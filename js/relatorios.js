// relatorios.js — Relatórios por COMPETÊNCIA financeira: visão geral,
// evolução diária, histórico mensal, categorias (com drill-down), evolução
// por categoria, gastos sob controle, onde posso poupar, reserva e
// compromissos futuros. Tudo calculado a partir do IndexedDB local.

const CORES_CATEGORIA = ['#1B2A4A', '#2F9E62', '#C7902E', '#8A5FD1', '#E0669B', '#2F5FE0', '#C7CCD6'];
const MESES_EVOLUCAO = 6;

function formatarMoeda(valor) { return UI.moeda(valor); }
function rotuloMes(mesISO) { return Datas.rotuloMes(mesISO); }
function rotuloMesCurto(mesISO) {
  const [ano, mes] = mesISO.split('-');
  return `${Datas.NOMES_MES[Number(mes) - 1].slice(0, 3)}/${ano.slice(2)}`;
}

function statusParaCor(status) {
  return status === 'ok' ? 'var(--green)' : status === 'warn' ? 'var(--amber)' : 'var(--red)';
}

// Uma única referência de mês para tudo que depende de período.
let mesReferenciaISO = DB.mesAtualISO();
let categoriaAbertaId = null;

function renderNavPeriodo() {
  document.getElementById('periodoNavLabel').textContent = rotuloMes(mesReferenciaISO);
  document.getElementById('periodoNavProximo').disabled = mesReferenciaISO >= DB.mesAtualISO();
}

async function renderComponentesDoPeriodo() {
  renderNavPeriodo();
  await Promise.all([renderVisaoGeral(), renderGrafico(), renderHistoricoMensal(), renderCategorias(), renderEvolucaoCategoria(), renderSobControle()]);
}

async function mudarMesReferencia(delta) {
  const alvo = DB.somarMesISO(mesReferenciaISO, delta);
  if (delta > 0 && alvo > DB.mesAtualISO()) return; // não navega para mês futuro
  mesReferenciaISO = alvo;
  categoriaAbertaId = null;
  await renderComponentesDoPeriodo();
}

async function renderVisaoGeral() {
  const receitas = await DB.entradasTotaisDoMes(mesReferenciaISO);
  const despesas = await DB.totalGastoNoMes(mesReferenciaISO);
  const mesAnterior = DB.somarMesISO(mesReferenciaISO, -1);
  const historico = await DB.historicoGastosMensais(mesAnterior, mesAnterior);
  let deltaTexto = '—';
  let deltaClasse = '';
  if (historico[0].temDados && historico[0].total > 0) {
    const variacao = ((despesas - historico[0].total) / historico[0].total) * 100;
    deltaClasse = variacao <= 0 ? 'down' : 'up';
    const ehMesCorrente = mesReferenciaISO === DB.mesAtualISO();
    deltaTexto = `${variacao <= 0 ? '↓' : '↑'} ${Math.abs(variacao).toFixed(0)}% vs. ${Datas.NOMES_MES[Number(mesAnterior.slice(5)) - 1].toLowerCase()}${ehMesCorrente ? ' · confirmados até agora' : ''}`;
  } else if (!historico[0].temDados) {
    deltaTexto = `sem dados em ${rotuloMes(mesAnterior)}`;
  }
  document.getElementById('ovReceitas').textContent = formatarMoeda(receitas);
  document.getElementById('ovDespesas').textContent = formatarMoeda(despesas);
  document.getElementById('ovSaldo').textContent = formatarMoeda(receitas - despesas);
  document.getElementById('ovDelta').textContent = deltaTexto;
  document.getElementById('ovDelta').className = `overview-delta ${deltaClasse}`;
}

function buildPath(points, w, h, padTop) {
  const max = Math.max(...points, 1);
  const stepX = w / (points.length - 1 || 1);
  const coords = points.map((p, i) => [i * stepX, h - (p / max) * (h - padTop) - 4]);
  let line = `M ${coords[0][0]} ${coords[0][1]}`;
  for (let i = 1; i < coords.length; i++) line += ` L ${coords[i][0]} ${coords[i][1]}`;
  return { line, area: `${line} L ${coords[coords.length - 1][0]} ${h} L ${coords[0][0]} ${h} Z` };
}

async function renderGrafico() {
  const gastosDiarios = await DB.gastosDiariosDoMes(mesReferenciaISO);
  const { line, area } = buildPath(gastosDiarios, 320, 80, 12);
  document.getElementById('linePath').setAttribute('d', line);
  document.getElementById('areaPath').setAttribute('d', area);
  document.getElementById('lblInicio').textContent = '1';
  document.getElementById('lblMeio').textContent = String(Math.round(gastosDiarios.length / 2));
  document.getElementById('lblFim').textContent = String(gastosDiarios.length);
}

// Histórico mensal: 6 meses até o mês selecionado; mês sem nenhum gasto
// confirmado aparece como "Sem dados" (não como R$0,00 de dado real).
async function renderHistoricoMensal() {
  const historico = await DB.historicoGastosMensais(DB.somarMesISO(mesReferenciaISO, -(MESES_EVOLUCAO - 1)), mesReferenciaISO);
  const maior = Math.max(...historico.map((h) => h.total), 1);
  document.getElementById('historicoMensalList').innerHTML = historico.map((h) => {
    const pct = h.temDados ? Math.max((h.total / maior) * 100, 3) : 0;
    const ehSelecionado = h.mesISO === mesReferenciaISO;
    return `
      <div class="bar-row">
        <div class="bar-row-top">
          <div class="bar-name">${rotuloMes(h.mesISO)}${ehSelecionado ? ' <span style="color:var(--ink-soft);font-weight:400">(selecionado)</span>' : ''}</div>
          <div class="bar-right">${h.temDados ? `<span class="bar-value">${formatarMoeda(h.total)}</span>` : '<span class="sem-dados">Sem dados</span>'}</div>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%; background:#2F5FE0"></div></div>
      </div>`;
  }).join('');
}

// ---------- Gastos por categoria (mês selecionado, por competência) ----------

async function renderCategorias() {
  const categorias = await DB.gastosPorCategoria(mesReferenciaISO);
  const detalhadas = await DB.despesasDetalhadas();
  window._categoriasDoMesRelatorio = categorias;
  window._totalConfirmadoDoMesRelatorio = categorias.reduce((soma, c) => soma + c.total, 0);
  window._mapaDetalheDespesaRelatorio = Object.fromEntries(detalhadas.map((d) => [d.id, d]));
  document.getElementById('categoriasPeriodoLabel').textContent = `· ${rotuloMes(mesReferenciaISO)}`;
  desenharListaCategorias();
}

function desenharListaCategorias() {
  const categorias = window._categoriasDoMesRelatorio || [];
  const total = window._totalConfirmadoDoMesRelatorio || 0;
  const comGasto = categorias.filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  const semGasto = categorias.filter((c) => c.total === 0);
  document.getElementById('barChartRow').innerHTML = comGasto.length === 0
    ? `<div style="text-align:center;padding:16px 0;color:var(--ink-soft);font-size:12.5px">Nenhum gasto confirmado em ${rotuloMes(mesReferenciaISO)}.</div>`
    : comGasto.map((c, i) => desenharLinhaCategoria(c, i, total)).join('');
  document.getElementById('categoriasSemGasto').innerHTML = semGasto.length === 0 ? '' : `
    <div class="cat-sem-gasto">
      <div class="cat-sem-gasto-titulo">Sem gasto em ${rotuloMes(mesReferenciaISO)}</div>
      <div class="cat-sem-gasto-chips">${semGasto.map((c) => `<span class="cat-sem-gasto-chip">${UI.escapar(c.icone || '💬')} ${UI.escapar(c.nome)}</span>`).join('')}</div>
    </div>`;
}

function desenharLinhaCategoria(categoria, indice, total) {
  const percentual = total > 0 ? (categoria.total / total) * 100 : 0;
  const cor = CORES_CATEGORIA[indice % CORES_CATEGORIA.length];
  const idLinha = categoria.id ?? 'orfa';
  const aberta = categoriaAbertaId !== null && String(categoriaAbertaId) === String(idLinha);
  return `
    <div class="cat-row ${aberta ? 'open' : ''}">
      <div class="cat-row-head" onclick="toggleDrillCategoria('${UI.escapar(idLinha)}')">
        <div class="cat-icon">${UI.escapar(categoria.icone || '💬')}</div>
        <div class="cat-info">
          <div class="cat-name">${UI.escapar(categoria.nome)}</div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${percentual.toFixed(0)}%; background:${cor}"></div></div>
        </div>
        <div class="cat-amount">
          <div class="cat-amount-value">${formatarMoeda(categoria.total)}</div>
          <div class="cat-amount-pct">${percentual.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</div>
        </div>
        <div class="chevron">▾</div>
      </div>
      <div class="drill"><div class="drill-inner">${montarDrillItensCategoria(categoria)}</div></div>
    </div>`;
}

function montarDrillItensCategoria(categoria) {
  const mapaDetalhe = window._mapaDetalheDespesaRelatorio || {};
  if (categoria.itens.length === 0) return '<div style="font-size:12px;color:var(--ink-soft)">Nenhuma despesa registrada aqui.</div>';
  return categoria.itens.slice()
    .sort((a, b) => (Datas.diaFinanceiro(b.data) || '').localeCompare(Datas.diaFinanceiro(a.data) || ''))
    .map((item) => {
      const detalhe = mapaDetalhe[item.id];
      const partes = [Datas.formatarDia(item.data)];
      if (item.parcelaTotal > 1) partes.push(`Parcela ${item.parcelaAtual}/${item.parcelaTotal}`);
      if (item.faturaId != null && detalhe) partes.push(`Competência ${rotuloMes(detalhe.mesCompetencia)} (fatura)`);
      return `
        <div class="drill-item">
          <div>
            <div class="drill-name">${UI.escapar(item.descricao || categoria.nome)}</div>
            <div class="drill-date">${UI.escapar(partes.join(' · '))}</div>
          </div>
          <div class="drill-value">${formatarMoeda(item.valorParcela)}</div>
        </div>`;
    }).join('');
}

function toggleDrillCategoria(idLinha) {
  categoriaAbertaId = (categoriaAbertaId !== null && String(categoriaAbertaId) === String(idLinha)) ? null : idLinha;
  desenharListaCategorias();
}

// ---------- Evolução por categoria + Onde posso poupar ----------

async function renderEvolucaoCategoria() {
  const inicio = DB.somarMesISO(mesReferenciaISO, -(MESES_EVOLUCAO - 1));
  const evolucao = await DB.evolucaoPorCategoria(inicio, mesReferenciaISO);
  const meses = DB.mesesEntre(inicio, mesReferenciaISO);
  const comAlgumDado = evolucao.filter((c) => c.meses.some((m) => m.temDados));

  document.getElementById('evolucaoCategoriaBox').innerHTML = comAlgumDado.length === 0
    ? '<div style="text-align:center;padding:10px 0;color:var(--ink-soft);font-size:12.5px">Sem dados nos últimos 6 meses.</div>'
    : `<table class="evo-tabela">
        <thead><tr><th>Categoria</th>${meses.map((m) => `<th>${rotuloMesCurto(m)}</th>`).join('')}</tr></thead>
        <tbody>${comAlgumDado.map((c) => `
          <tr><td>${UI.escapar(c.icone || '')} ${UI.escapar(c.nome)}</td>${c.meses.map((m) => m.temDados
            ? `<td>${formatarMoeda(m.total)}</td>`
            : '<td class="sem-dados">Sem dados</td>').join('')}</tr>`).join('')}
        </tbody>
      </table>`;

  // Onde posso poupar: histórico calculado POR CATEGORIA
  const natureza = Object.fromEntries(evolucao.map((c) => [c.nome, c.natureza]));
  const analise = Analises.avaliarOndePoupar(evolucao, mesReferenciaISO, natureza);
  const oportunidades = analise.filter((a) => a.oportunidade);
  const comparacoesIniciais = analise.filter((a) => !a.oportunidade && a.confianca === 'baixa' && a.valorAtual !== null && a.variacao !== null && a.variacao > 0.15);
  const insuficientes = analise.filter((a) => a.valorAtual !== null && a.confianca === 'insuficiente');

  const blocos = [];
  if (oportunidades.length > 0) {
    blocos.push(...oportunidades.map((o) => `
      <div class="insight-card alert">
        <div class="insight-icon">✂️</div>
        <div>
          <div class="insight-title">${UI.escapar(o.nome)}: acima do seu padrão</div>
          <div class="insight-text">Em ${rotuloMes(mesReferenciaISO)} foram ${formatarMoeda(o.valorAtual)}, contra uma média de ${formatarMoeda(o.media)} nos ${o.mesesComDados - 1} meses anteriores com gasto nessa categoria. Voltar ao seu padrão libera cerca de ${formatarMoeda(o.economiaPotencial)}.${o.faixaCorte ? ` Um corte de 10% a 15% aqui representa ${formatarMoeda(o.faixaCorte.de)} a ${formatarMoeda(o.faixaCorte.ate)}.` : ''} Confiança: ${o.confianca === 'confiavel' ? 'boa' : 'primeira tendência'} (${o.mesesComDados} meses de dados).</div>
        </div>
      </div>`));
  } else {
    blocos.push(`
      <div class="insight-card save">
        <div class="insight-icon">✅</div>
        <div>
          <div class="insight-title">Nenhuma categoria claramente acima do padrão</div>
          <div class="insight-text">Só aponto oportunidade quando a categoria tem pelo menos 3 meses de dados e o mês ficou mais de 15% acima da sua média.</div>
        </div>
      </div>`);
  }
  if (comparacoesIniciais.length > 0) {
    blocos.push(`<div class="cat-hint" style="margin-top:10px">Comparação inicial (só 2 meses, baixa confiança): ${comparacoesIniciais.map((a) => `${UI.escapar(a.nome)} ${formatarMoeda(a.valorAtual)} vs. ${formatarMoeda(a.media)}`).join(' · ')}.</div>`);
  }
  if (insuficientes.length > 0) {
    blocos.push(`<div class="cat-hint">Histórico insuficiente (1 mês): ${insuficientes.map((a) => UI.escapar(a.nome)).join(', ')}.</div>`);
  }
  document.getElementById('ondePouparBox').innerHTML = blocos.join('');
}

async function renderSobControle() {
  const entradas = await DB.entradasTotaisDoMes(mesReferenciaISO);
  const saidas = await DB.totalGastoNoMes(mesReferenciaISO);
  const r = Analises.avaliarGastosSobControle({ entradas, saidasConfirmadas: saidas });
  const alerta = r.estado === 'atencao' || r.estado === 'acima_da_renda';
  document.getElementById('sobControleBox').innerHTML = `
    <div class="insight-card ${alerta ? 'alert' : 'save'}">
      <div class="insight-icon">${alerta ? '⚠️' : r.estado === 'sob_controle' ? '✅' : 'ℹ️'}</div>
      <div>
        <div class="insight-title">${UI.escapar(r.titulo)}</div>
        <div class="insight-text">${UI.escapar(r.texto)} <br><span style="font-size:11px">Critério: gastos confirmados do mês ÷ entradas do mês. Até 80% = sob controle.</span></div>
      </div>
    </div>`;
}

async function renderInvestimento() {
  const reserva = Analises.avaliarReserva(await DB.obterReserva());
  const rec = Analises.recomendarInvestimento(reserva);
  let situacao = '';
  if (reserva.estado === 'meta_nao_definida') situacao = 'Meta da reserva não definida.';
  else if (reserva.estado === 'em_formacao') {
    situacao = `Reserva: ${formatarMoeda(reserva.valorAtual)} de ${formatarMoeda(reserva.meta)} (${reserva.percentual.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%).`;
    if (reserva.aporteMensalNecessario !== null) situacao += ` Para chegar lá em ${reserva.prazoMeses} meses: ${formatarMoeda(reserva.aporteMensalNecessario)} por mês.`;
  } else situacao = `Reserva formada: ${formatarMoeda(reserva.valorAtual)}.`;
  document.getElementById('insightsBox').innerHTML = `
    <div class="insight-card invest">
      <div class="insight-icon">📈</div>
      <div>
        <div class="insight-title">Onde investir a sobra</div>
        <div class="insight-text">${UI.escapar(situacao)} ${UI.escapar(rec.texto)}<br><span style="font-size:11px">${UI.escapar(rec.aviso)}</span></div>
      </div>
    </div>`;
}

async function renderComprometimento() {
  const mesSeguinte = DB.somarMesISO(DB.mesAtualISO(), 1);
  const renda = await DB.rendaAtual(mesSeguinte);
  const parcelas = await DB.parcelasProximoMes();
  const avaliacao = Analises.avaliarComprometimentoCartao(parcelas, renda);
  const percentual = avaliacao.percentual === null ? 0 : avaliacao.percentual;
  const status = percentual > 30 ? 'danger' : percentual > 20 ? 'warn' : 'ok';
  document.getElementById('commitPct').textContent = avaliacao.percentual === null ? '—' : `${percentual.toFixed(0)}%`;
  document.getElementById('commitPct').style.color = statusParaCor(status);
  document.getElementById('commitFill').style.width = `${Math.min(percentual, 100).toFixed(0)}%`;
  document.getElementById('commitFill').style.background = statusParaCor(status);
  document.getElementById('commitNote').textContent = avaliacao.texto;
}

async function renderPrevistas() {
  const lista = await DB.previstasPorMes(DB.somarMesISO(DB.mesAtualISO(), 1), 6);
  const comValor = lista.filter((m) => m.quantidade > 0);
  document.getElementById('previstasBox').innerHTML = comValor.length === 0
    ? '<div style="text-align:center;padding:10px 0;color:var(--ink-soft);font-size:12.5px">Nenhuma parcela prevista.</div>'
    : comValor.map((m) => `
      <div class="bar-row"><div class="bar-row-top">
        <div class="bar-name">${rotuloMes(m.mesISO)} <span style="color:var(--ink-soft);font-weight:400">(${m.quantidade} parcela(s))</span></div>
        <div class="bar-right"><span class="bar-value">${formatarMoeda(m.total)}</span></div>
      </div></div>`).join('');
}

async function renderEvolucaoReserva() {
  const historico = await DB.historicoAportes();
  const card = document.getElementById('reservaChartCard');
  if (historico.length === 0) {
    card.innerHTML = '<div style="text-align:center;padding:10px 0;color:var(--ink-soft);font-size:12.5px">Nenhum aporte registrado ainda. Use o "+" e escolha "Reserva" para começar.</div>';
    return;
  }
  const { line, area } = buildPath(historico.map((h) => h.acumulado), 320, 80, 12);
  card.innerHTML = `
    <svg viewBox="0 0 320 80" preserveAspectRatio="none">
      <defs><linearGradient id="fillReserva" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2F9E62" stop-opacity="0.2"/><stop offset="100%" stop-color="#2F9E62" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#fillReserva)" stroke="none"></path>
      <path d="${line}" fill="none" stroke="#2F9E62" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
    <div class="chart-labels">
      <span>${Datas.formatarDia(historico[0].dia, { day: '2-digit', month: 'short' })}</span>
      <span>Total: ${formatarMoeda(historico[historico.length - 1].acumulado)}</span>
    </div>`;
}

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  renderNavPeriodo();
  await Promise.all([
    renderComponentesDoPeriodo(),
    renderInvestimento(),
    renderComprometimento(),
    renderPrevistas(),
    renderEvolucaoReserva()
  ]);
})();
