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

async function renderVisaoGeral() {
  const receitas = await DB.entradasTotaisDoMes();
  const despesas = await DB.totalGastoNoMes();
  const saldo = receitas - despesas;

  const mesPassadoISO = DB.mesAnteriorISO();
  const despesasMesPassado = await DB.totalGastoNoMes(mesPassadoISO);
  let deltaTexto = '—';
  let deltaClasse = '';
  if (despesasMesPassado > 0) {
    const variacao = ((despesas - despesasMesPassado) / despesasMesPassado) * 100;
    deltaClasse = variacao <= 0 ? 'down' : 'up';
    const seta = variacao <= 0 ? '↓' : '↑';
    // Ajuste da revisão final (item 5): o cálculo continua exatamente o
    // mesmo (despesas confirmadas do mês atual vs. mês anterior, via
    // DB.totalGastoNoMes) — só o texto fica mais claro: cita o mês de
    // comparação pelo nome (em vez de "mês passado" genérico) e deixa
    // explícito que despesas é o total confirmado até agora, já que o mês
    // atual pode ainda estar em andamento. Nada disso vira previsão nem
    // inclui parcelas futuras.
    const nomeMesPassado = new Date(`${mesPassadoISO}-02`).toLocaleDateString('pt-BR', { month: 'long' });
    deltaTexto = `${seta} ${Math.abs(variacao).toFixed(0)}% vs. ${nomeMesPassado} · confirmados até agora`;
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
  const gastosDiarios = await DB.gastosDiariosDoMes();
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

// Ícones e cores por grupo do gráfico (5 colunas fixas). Categorias novas
// criadas em "Gerenciar Categorias" entram automaticamente na coluna que a
// usuária escolher — nada aqui precisa mudar quando ela cria uma categoria.
const INFO_GRUPO = {
  'Essenciais': { icone: '🏠', cor: '#2F5FE0' },
  'Alimentação': { icone: '🍴', cor: '#8A5FD1' },
  'Transporte': { icone: '🚗', cor: '#C7902E' },
  'Lazer': { icone: '🍿', cor: '#E0669B' },
  'Outros': { icone: '💬', cor: '#6B7280' }
};
const ORDEM_GRUPOS = ['Essenciais', 'Alimentação', 'Transporte', 'Lazer', 'Outros'];

// Fallback só para categorias antigas que ainda não têm o campo grupoGrafico
// salvo (bancos de dados criados antes desse recurso existir)
const FALLBACK_GRUPO_POR_NOME = { 'Essenciais': 'Essenciais', 'Alimentação': 'Alimentação', 'Transporte': 'Transporte', 'Delivery': 'Lazer', 'Assinaturas': 'Lazer', 'Lazer': 'Lazer', 'Outros': 'Outros' };
const LIMITES_PADRAO = { 'Essenciais': 1500, 'Alimentação': 500, 'Transporte': 400, 'Delivery': 200, 'Assinaturas': 150, 'Lazer': 150, 'Outros': 300 };

let grupoSelecionado = null;

async function renderCategorias() {
  const categorias = await DB.gastosPorCategoria();

  const grupos = ORDEM_GRUPOS.map((nomeGrupo) => {
    let total = 0;
    let limite = 0;
    let itens = [];

    categorias.forEach((c) => {
      const grupoDaCategoria = c.grupoGrafico || FALLBACK_GRUPO_POR_NOME[c.nome] || 'Outros';
      if (grupoDaCategoria === nomeGrupo) {
        total += c.total;
        limite += (c.limiteMensal || LIMITES_PADRAO[c.nome] || 300);
        itens = itens.concat(c.itens.map((i) => ({ ...i, subcategoria: c.nome })));
      }
    });

    const percentualDoLimite = limite > 0 ? (total / limite) * 100 : 0;
    return { nome: nomeGrupo, ...INFO_GRUPO[nomeGrupo], total, limite, percentualDoLimite, itens, emAlerta: percentualDoLimite >= 80 };
  });

  const maiorPercentual = Math.max(...grupos.map((g) => g.percentualDoLimite), 100);
  const row = document.getElementById('barChartRow');

  row.innerHTML = grupos.map((g, i) => {
    const alturaPct = Math.max((g.percentualDoLimite / maiorPercentual) * 100, g.total > 0 ? 6 : 2);
    return `
      <div class="bar-col" data-idx="${i}" onclick="toggleDrillGrupo(${i})">
        <div class="bar-col-value">${formatarMoeda(g.total)}</div>
        <div class="bar-col-track">
          <div class="bar-col-fill ${g.emAlerta ? 'alerta' : ''}" style="height:${alturaPct.toFixed(0)}%; background:${g.cor}"></div>
        </div>
        <div class="bar-col-icon">${g.icone}</div>
      </div>
    `;
  }).join('');

  window._gruposGrafico = grupos;
  if (grupoSelecionado !== null) renderDrillPanel(grupos[grupoSelecionado], grupoSelecionado);
}

function toggleDrillGrupo(idx) {
  const grupos = window._gruposGrafico;
  if (grupoSelecionado === idx) {
    grupoSelecionado = null;
    document.getElementById('drillPanel').innerHTML = '';
    document.querySelectorAll('.bar-col').forEach((el) => el.classList.remove('selecionada'));
    return;
  }
  grupoSelecionado = idx;
  document.querySelectorAll('.bar-col').forEach((el, i) => el.classList.toggle('selecionada', i === idx));
  renderDrillPanel(grupos[idx], idx);
}

function renderDrillPanel(grupo, idx) {
  const painel = document.getElementById('drillPanel');

  // Sub-totais por categoria real dentro do grupo (ex.: Lazer, Delivery, Assinaturas)
  const subtotais = {};
  grupo.itens.forEach((item) => {
    subtotais[item.subcategoria] = (subtotais[item.subcategoria] || 0) + item.valorParcela;
  });

  const linhasSubtotal = Object.entries(subtotais).length > 1
    ? Object.entries(subtotais).map(([nome, valor]) => `
        <div class="drill-panel-item">
          <div class="drill-panel-name">${nome}</div>
          <div class="drill-panel-value">${formatarMoeda(valor)}</div>
        </div>
      `).join('')
    : '';

  const linhasCompras = grupo.itens
    .sort((a, b) => new Date(b.data) - new Date(a.data))
    .map((item) => `
      <div class="drill-panel-item">
        <div>
          <div class="drill-panel-name">${item.descricao || item.subcategoria}</div>
          <div class="drill-panel-date">${item.subcategoria} · ${new Date(item.data).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</div>
        </div>
        <div class="drill-panel-value">${formatarMoeda(item.valorParcela)}</div>
      </div>
    `).join('');

  painel.innerHTML = `
    <div class="drill-panel-card open">
      <div class="drill-panel-inner">
        <div class="drill-panel-title">${grupo.icone} ${grupo.nome} — ${formatarMoeda(grupo.total)} de ${formatarMoeda(grupo.limite)} (${grupo.percentualDoLimite.toFixed(0)}%)</div>
        ${linhasSubtotal}
        ${grupo.itens.length === 0 ? '<div style="font-size:12px;color:var(--ink-soft)">Nenhum gasto registrado aqui este mês.</div>' : linhasCompras}
      </div>
    </div>
  `;
}

async function renderInsights() {
  const renda = await DB.entradasTotaisDoMes();
  const categorias = await DB.gastosPorCategoria();
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
