// transacoes.js — renderiza a lista real de despesas do IndexedDB,
// agrupadas por dia, com busca e filtro por forma de pagamento.

let TODAS_DESPESAS = [];
let TODAS_RECEITAS = [];
let filtroAtivo = 'todas';
// Filtro de Período: representa a COMPETÊNCIA FINANCEIRA, não "quando a
// compra aconteceu". Os campos de data (formato 'YYYY-MM-DD') só definem o
// intervalo de MESES ('YYYY-MM') a considerar — despesa de cartão usa
// fatura.mesFatura, dinheiro/pix e receita usam o mês da própria data real.
// Nunca usa fechamento/vencimento. Funciona igual pra qualquer cartão/banco.
let periodoInicio = null;
let periodoFim = null;

function togglePeriodoInput() {
  const painel = document.getElementById('periodoInput');
  const visivel = painel.style.display !== 'none';
  painel.style.display = visivel ? 'none' : 'block';
}

function limparPeriodo() {
  periodoInicio = null;
  periodoFim = null;
  document.getElementById('periodoDataInicial').value = '';
  document.getElementById('periodoDataFinal').value = '';
  atualizarChipPeriodo();
  document.getElementById('periodoInput').style.display = 'none';
  renderLista();
}

function aplicarPeriodo() {
  const inicio = document.getElementById('periodoDataInicial').value; // 'YYYY-MM-DD' ou ''
  const fim = document.getElementById('periodoDataFinal').value;

  if (inicio && fim && inicio > fim) {
    alert('A data inicial não pode ser depois da data final.');
    return;
  }

  periodoInicio = inicio || null;
  periodoFim = fim || null;
  atualizarChipPeriodo();
  document.getElementById('periodoInput').style.display = 'none';
  renderLista();
}

function atualizarChipPeriodo() {
  const chip = document.getElementById('chipPeriodo');
  if (!periodoInicio && !periodoFim) {
    chip.textContent = 'Período ▾';
    chip.classList.remove('active');
    return;
  }
  const formatarCurto = (iso) => {
    const [ano, mes, dia] = iso.split('-');
    return `${dia}/${mes}`;
  };
  const texto = periodoInicio && periodoFim
    ? `${formatarCurto(periodoInicio)} – ${formatarCurto(periodoFim)}`
    : periodoInicio
      ? `A partir de ${formatarCurto(periodoInicio)}`
      : `Até ${formatarCurto(periodoFim)}`;
  chip.textContent = `${texto} ▾`;
  chip.classList.add('active');
}

function formatarMoeda(valor) { return UI.moeda(valor); }

function rotuloDia(valorData) {
  const dia = Datas.diaFinanceiro(valorData);
  const hoje = Datas.hojeISO();
  const diferenca = Datas.diferencaEmDias(dia, hoje);
  const curto = Datas.formatarDia(dia, { day: '2-digit', month: 'short' });
  if (diferenca === 0) return `Hoje · ${curto}`;
  if (diferenca === 1) return `Ontem · ${curto}`;
  return Datas.formatarDia(dia, { day: '2-digit', month: 'long', year: 'numeric' });
}

function rotuloFormaPagamento(d) {
  if (d.cartaoNome) return 'Cartão ' + d.cartaoNome;
  const rotulos = { debito_automatico: 'Débito Automático', dinheiro: 'Dinheiro', pix: 'Pix', boleto: 'Boleto' };
  return rotulos[d.formaPagamento] || 'Dinheiro / Pix'; // fallback pra despesas antigas sem o campo
}

// Regra 1 da revisão: dois lançamentos podem ter a MESMA data real mas
// pertencerem a competências financeiras diferentes (ex.: a 8/12 confirmada
// de agosto e a 9/12 prevista de setembro, ambas projetadas/registradas no
// dia 12) — a chave de agrupamento da visão "Todas" precisa incluir a
// competência, senão duas parcelas de meses diferentes viram um único grupo
// com um total de dia que mistura gasto de um mês com previsão de outro
// (ex.: um "12 de setembro — R$490,54" que na verdade é 245,27 de agosto +
// 245,27 de setembro). Isso não muda a data real armazenada — só separa a
// APRESENTAÇÃO em dois grupos quando a competência diverge.
function chaveDia(item) {
  return `${item.mesCompetencia || ''}|${Datas.diaFinanceiro(item.data)}`;
}

// Quando a competência financeira do item cai num mês diferente do mês da
// própria data real (ex.: compra em 12/09, mas competência agosto/2026 por
// causa do fechamento da fatura), mostra essa informação junto do rótulo do
// dia — preserva as duas informações (data real E competência) sem misturar
// uma com a outra (regra 1: "Competência: Agosto/2026 · Compra em: 12/09/2026").
function rotuloCompetenciaSeDiferente(item) {
  if (!item.mesCompetencia) return '';
  if (item.mesCompetencia === Datas.mesFinanceiro(item.data)) return '';
  return ` · competência: ${Datas.rotuloMes(item.mesCompetencia)}`;
}

// Ordena a lista unificada por data decrescente. Quando duas datas empatam
// (ex.: uma parcela confirmada e a prevista seguinte, ambas projetadas pro
// mesmo dia — 8/12 real em 12/09 e 9/12 prevista também caindo em 12/09),
// usa parcelaAtual como desempate, também decrescente — sem isso, a ordem
// de exibição da visão "Todas" ficava dependendo da ordem "por acaso" com
// que os registros foram lidos do IndexedDB (o sort é estável), o que podia
// colocar a parcela mais antiga (8/12) antes da mais nova (9/12). Regra
// GENÉRICA: nunca depende de qual loja/descrição é o parcelamento, só de
// data e parcelaAtual — itens sem parcelaAtual (receitas, despesas não
// parceladas) tratam o desempate como 0, sem efeito nenhum sobre eles.
function compararPorDataDesc(a, b) {
  const diff = (Datas.diaFinanceiro(b.data) || '').localeCompare(Datas.diaFinanceiro(a.data) || '');
  if (diff !== 0) return diff;
  if (a.mesCompetencia !== b.mesCompetencia) return (b.mesCompetencia || '').localeCompare(a.mesCompetencia || '');
  return (b.parcelaAtual || 0) - (a.parcelaAtual || 0);
}

function itensUnificados() {
  const despesas = TODAS_DESPESAS.map((d) => ({ ...d, tipo: 'despesa' }));
  const receitas = TODAS_RECEITAS.map((r) => ({
    ...r,
    tipo: 'receita',
    valorParcela: r.valor,
    categoriaNome: 'Receita',
    categoriaIcone: '💰',
    cartaoNome: null,
    descricao: r.descricao,
    // competência financeira de uma receita = mês da própria data (regra 1C)
    mesCompetencia: DB.competenciaReceita(r)
  }));
  return [...despesas, ...receitas].sort(compararPorDataDesc);
}

function aplicarFiltros() {
  const termo = document.getElementById('buscaInput').value.trim().toLowerCase();
  const mesInicio = periodoInicio ? periodoInicio.slice(0, 7) : null;
  const mesFim = periodoFim ? periodoFim.slice(0, 7) : null;

  return itensUnificados().filter((d) => {
    if (filtroAtivo === 'cartao' && (d.tipo !== 'despesa' || !d.cartaoId)) return false;
    if (filtroAtivo === 'dinheiro' && (d.tipo !== 'despesa' || d.cartaoId)) return false;
    if (filtroAtivo === 'receitas' && d.tipo !== 'receita') return false;

    // Período representa a COMPETÊNCIA FINANCEIRA, não a data em que a
    // compra aconteceu: despesa de cartão usa fatura.mesFatura (via
    // d.mesCompetencia, calculado em DB.despesasDetalhadas), dinheiro/pix e
    // receita usam o mês da própria data real. A data real exibida na tela
    // NUNCA muda — só a competência decide se o item entra no período
    // selecionado.
    if (mesInicio && d.mesCompetencia < mesInicio) return false;
    if (mesFim && d.mesCompetencia > mesFim) return false;

    if (!termo) return true;
    const nome = (d.descricao || d.categoriaNome).toLowerCase();
    const categoria = d.categoriaNome.toLowerCase();
    const valorTexto = d.valorParcela.toFixed(2).replace('.', ',');
    return nome.includes(termo) || categoria.includes(termo) || valorTexto.includes(termo);
  });
}

function renderLista() {
  const despesas = aplicarFiltros();
  const container = document.getElementById('listaTransacoes');

  if (despesas.length === 0) {
    container.innerHTML = `<div class="empty-state">Nenhuma transação encontrada.</div>`;
    return;
  }

  const grupos = new Map();
  despesas.forEach((d) => {
    const chave = chaveDia(d);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(d);
  });

  let html = '';
  for (const [, itens] of grupos) {
    // previstas não entram no total do dia (não são gasto realizado)
    const totalDia = itens.reduce((s, d) => d.statusDespesa === 'previsto' ? s : s + (d.tipo === 'receita' ? d.valorParcela : -d.valorParcela), 0);
    const soPrevistas = itens.every((d) => d.statusDespesa === 'previsto');
    const sinalTotal = totalDia >= 0 ? '+ ' : '− ';
    html += `
      <div class="day-group">
        <div class="day-head">
          <span class="day-label">${rotuloDia(itens[0].data)}${rotuloCompetenciaSeDiferente(itens[0])}</span>
          <span class="day-total">${soPrevistas ? 'previsto' : sinalTotal + formatarMoeda(Math.abs(totalDia))}</span>
        </div>
        ${itens.map((d) => `
          <div class="txn-card">
            <button type="button" class="txn-more" title="Ações" onclick="abrirDetalheTransacao(${d.id}, '${d.tipo}')">⋯</button>
            <div class="txn-icon">${UI.escapar(d.categoriaIcone)}</div>
            <div class="txn-info">
              <div class="txn-name">${UI.escapar(d.descricao || d.categoriaNome)}${d.statusDespesa === 'previsto' ? ' <span class=\'tag-previsto\'>Previsto</span>' : ''}${d.pendenteReconciliacao ? ' <span class=\'tag-revisao\'>Revisar</span>' : ''}</div>
              <div class="txn-meta">${UI.escapar(d.categoriaNome)}${d.tipo === 'despesa' ? ' · ' + UI.escapar(rotuloFormaPagamento(d)) : ''}${d.parcelaTotal > 1 ? ` · parcela ${d.parcelaAtual}/${d.parcelaTotal}` : ''}</div>
            </div>
            <div class="txn-value ${d.tipo === 'receita' ? 'income' : ''}"${d.statusDespesa === 'previsto' ? ' style="opacity:.6"' : ''}>${d.tipo === 'receita' ? '+ ' : '− '}${formatarMoeda(d.valorParcela)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  container.innerHTML = html;
}

document.getElementById('buscaInput').addEventListener('input', renderLista);

document.getElementById('filtros').addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip');
  if (!chip || chip.id === 'chipPeriodo') return;
  document.querySelectorAll('.filter-chip').forEach((c) => {
    if (c.id !== 'chipPeriodo') c.classList.remove('active');
  });
  chip.classList.add('active');
  filtroAtivo = chip.dataset.filtro;
  renderLista();
});

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  TODAS_DESPESAS = await DB.despesasDetalhadas();
  TODAS_RECEITAS = await DB.listarTodos('receita');
  renderLista();
})();

// ---------- Detalhe / edição / exclusão de transação ----------

let transacaoEmEdicao = null; // { id, tipo }

async function abrirDetalheTransacao(id, tipo) {
  transacaoEmEdicao = { id, tipo };

  if (tipo === 'despesa') {
    const registro = await DB.obterPorId('despesa', id);
    document.getElementById('detalheTitulo').textContent = 'Editar despesa';
    aplicarMascaraMoeda(document.getElementById('detalheValor'));
    definirValorMascarado(document.getElementById('detalheValor'), registro.valor);
    document.getElementById('detalheDescricao').value = registro.descricao || '';
    document.getElementById('detalheDescricao').placeholder = 'Descrição (opcional)';

    const categorias = await DB.listarCategoriasAtivas();
    document.getElementById('detalheCategoriaChips').innerHTML = categorias.map((c) => `
      <div class="chip ${c.id === registro.categoriaId ? 'selected' : ''}" data-id="${c.id}" onclick="selecionarCategoriaDetalhe(${c.id})">${UI.escapar(c.icone)} ${UI.escapar(c.nome)}</div>
    `).join('');
    document.getElementById('detalheCategoriaChips').dataset.selecionado = registro.categoriaId;

    const cartoes = (await DB.listarTodos('cartao')).filter((c) => !c.arquivado || c.id === registro.cartaoId);
    document.getElementById('detalheCartaoChips').innerHTML = cartoes.map((c) => `
      <div class="chip ${c.id === registro.cartaoId ? 'selected' : ''}" data-id="${c.id}" onclick="selecionarCartaoDetalhe(${c.id})">💳 ${UI.escapar(c.nome)}</div>
    `).join('');
    document.getElementById('detalheCartaoChips').dataset.selecionado = registro.cartaoId || '';

    document.getElementById('blocoCategoriaDetalhe').style.display = 'block';
    document.getElementById('blocoCartaoDetalhe').style.display = 'block';
    document.getElementById('detalheData').value = Datas.diaFinanceiro(registro.data) || '';
  } else {
    const registro = await DB.obterPorId('receita', id);
    document.getElementById('detalheTitulo').textContent = 'Editar receita';
    aplicarMascaraMoeda(document.getElementById('detalheValor'));
    definirValorMascarado(document.getElementById('detalheValor'), registro.valor);
    document.getElementById('detalheDescricao').value = registro.descricao || '';
    document.getElementById('detalheDescricao').placeholder = 'Descrição';
    document.getElementById('blocoCategoriaDetalhe').style.display = 'none';
    document.getElementById('blocoCartaoDetalhe').style.display = 'none';
    document.getElementById('detalheData').value = Datas.diaFinanceiro(registro.data) || '';
  }

  document.getElementById('sheetOverlayDetalhe').classList.add('open');
}

function selecionarCategoriaDetalhe(id) {
  const container = document.getElementById('detalheCategoriaChips');
  container.dataset.selecionado = id;
  container.querySelectorAll('.chip').forEach((c) => c.classList.toggle('selected', Number(c.dataset.id) === id));
}

function selecionarCartaoDetalhe(id) {
  const container = document.getElementById('detalheCartaoChips');
  const atual = Number(container.dataset.selecionado);
  const novo = atual === id ? '' : id;
  container.dataset.selecionado = novo;
  container.querySelectorAll('.chip').forEach((c) => c.classList.toggle('selected', Number(c.dataset.id) === novo));
}

function fecharModalDetalhe() {
  document.getElementById('sheetOverlayDetalhe').classList.remove('open');
  transacaoEmEdicao = null;
}

function fecharModalDetalheSeClicarFora(event) {
  if (event.target.id === 'sheetOverlayDetalhe') fecharModalDetalhe();
}

async function recarregarListaTransacoes() {
  TODAS_DESPESAS = await DB.despesasDetalhadas();
  TODAS_RECEITAS = await DB.listarTodos('receita');
  renderLista();
}

async function salvarEdicaoTransacao() {
  if (!transacaoEmEdicao) return;
  const valor = valorNumericoDoInput(document.getElementById('detalheValor'));
  if (!valor || valor <= 0) { alert('Valor inválido.'); return; }

  const descricao = document.getElementById('detalheDescricao').value.trim();

  const dataFinal = Datas.interpretarDiaDigitado(document.getElementById('detalheData').value);
  if (!dataFinal) { alert('Data inválida.'); return; }

  if (transacaoEmEdicao.tipo === 'despesa') {
    const categoriaId = Number(document.getElementById('detalheCategoriaChips').dataset.selecionado);
    const cartaoTexto = document.getElementById('detalheCartaoChips').dataset.selecionado;
    const cartaoId = cartaoTexto ? Number(cartaoTexto) : null;

    if (!categoriaId) { alert('Escolha uma categoria.'); return; }

    const registro = await DB.obterPorId('despesa', transacaoEmEdicao.id);
    if (registro.faturaId != null && (registro.cartaoId || null) !== cartaoId) {
      const ok = confirm(cartaoId
        ? 'Mover este lançamento para outro cartão? Ele sai da fatura atual e entra na fatura do novo cartão (pelo dia de fechamento).'
        : 'Tirar este lançamento do cartão? Ele sai da fatura e passa a contar pelo mês da data da compra.');
      if (!ok) return;
    }
    // atualizarDespesaManual marca editadoManualmente (a reconciliação não
    // sobrescreve), ajusta a fatura se o cartão mudar e recalcula totais
    try {
      await DB.atualizarDespesaManual(registro.id, { valor, descricao, categoriaId, cartaoId, data: dataFinal });
    } catch (erro) { alert(erro.message); return; }
  } else {
    const registro = await DB.obterPorId('receita', transacaoEmEdicao.id);
    await DB.atualizar('receita', { ...registro, valor, descricao: descricao || 'Receita avulsa', data: dataFinal });
  }

  fecharModalDetalhe();
  await recarregarListaTransacoes();
}

async function excluirTransacao() {
  if (!transacaoEmEdicao) return;
  const ok = confirm('Excluir esta transação? Essa ação não pode ser desfeita.');
  if (!ok) return;

  if (transacaoEmEdicao.tipo === 'despesa') await DB.excluirDespesa(transacaoEmEdicao.id);
  else await DB.remover('receita', transacaoEmEdicao.id);
  fecharModalDetalhe();
  await recarregarListaTransacoes();
}
