// transacoes.js — renderiza a lista real de despesas do IndexedDB,
// agrupadas por dia, com busca e filtro por forma de pagamento.

let TODAS_DESPESAS = [];
let TODAS_RECEITAS = [];
let filtroAtivo = 'todas';
let periodoAtivo = null; // formato 'YYYY-MM', null = todos os períodos

function togglePeriodoInput() {
  const input = document.getElementById('periodoInput');
  const visivel = input.style.display !== 'none';
  input.style.display = visivel ? 'none' : 'block';
  if (!visivel) input.focus();
}

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function rotuloDia(dataISO) {
  const data = new Date(dataISO);
  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);

  const mesmoDia = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (mesmoDia(data, hoje)) return `Hoje · ${data.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`;
  if (mesmoDia(data, ontem)) return `Ontem · ${data.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`;
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
}

function rotuloFormaPagamento(d) {
  if (d.cartaoNome) return 'Cartão ' + d.cartaoNome;
  const rotulos = { debito_automatico: 'Débito Automático', dinheiro: 'Dinheiro', pix: 'Pix', boleto: 'Boleto' };
  return rotulos[d.formaPagamento] || 'Dinheiro / Pix'; // fallback pra despesas antigas sem o campo
}

function chaveDia(dataISO) {
  const d = new Date(dataISO);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
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
    descricao: r.descricao
  }));
  return [...despesas, ...receitas].sort((a, b) => new Date(b.data) - new Date(a.data));
}

function aplicarFiltros() {
  const termo = document.getElementById('buscaInput').value.trim().toLowerCase();

  return itensUnificados().filter((d) => {
    if (filtroAtivo === 'cartao' && (d.tipo !== 'despesa' || !d.cartaoId)) return false;
    if (filtroAtivo === 'dinheiro' && (d.tipo !== 'despesa' || d.cartaoId)) return false;
    if (filtroAtivo === 'receitas' && d.tipo !== 'receita') return false;
    if (periodoAtivo && d.data.slice(0, 7) !== periodoAtivo) return false;

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
    const chave = chaveDia(d.data);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(d);
  });

  let html = '';
  for (const [, itens] of grupos) {
    const totalDia = itens.reduce((s, d) => s + (d.tipo === 'receita' ? d.valorParcela : -d.valorParcela), 0);
    const sinalTotal = totalDia >= 0 ? '+ ' : '− ';
    html += `
      <div class="day-group">
        <div class="day-head">
          <span class="day-label">${rotuloDia(itens[0].data)}</span>
          <span class="day-total">${sinalTotal}${formatarMoeda(Math.abs(totalDia))}</span>
        </div>
        ${itens.map((d) => `
          <div class="txn-card" onclick="abrirDetalheTransacao(${d.id}, '${d.tipo}')" style="cursor:pointer">
            <div class="txn-icon">${d.categoriaIcone}</div>
            <div class="txn-info">
              <div class="txn-name">${d.descricao || d.categoriaNome}</div>
              <div class="txn-meta">${d.categoriaNome}${d.tipo === 'despesa' ? ' · ' + rotuloFormaPagamento(d) : ''}${d.parcelaTotal > 1 ? ` · parcela ${d.parcelaAtual}/${d.parcelaTotal}` : ''}</div>
            </div>
            <div class="txn-value ${d.tipo === 'receita' ? 'income' : ''}">${d.tipo === 'receita' ? '+ ' : '− '}${formatarMoeda(d.valorParcela)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  container.innerHTML = html;
}

document.getElementById('buscaInput').addEventListener('input', renderLista);

document.getElementById('periodoInput').addEventListener('change', (e) => {
  periodoAtivo = e.target.value || null;
  const chip = document.getElementById('chipPeriodo');
  if (periodoAtivo) {
    const [ano, mes] = periodoAtivo.split('-');
    const nomeMes = new Date(ano, mes - 1, 1).toLocaleDateString('pt-BR', { month: 'short' });
    chip.textContent = `${nomeMes}/${ano} ▾`;
    chip.classList.add('active');
  } else {
    chip.textContent = 'Período ▾';
    chip.classList.remove('active');
  }
  document.getElementById('periodoInput').style.display = 'none';
  renderLista();
});

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

    const categorias = await DB.listarTodos('categoria');
    document.getElementById('detalheCategoriaChips').innerHTML = categorias.map((c) => `
      <div class="chip ${c.id === registro.categoriaId ? 'selected' : ''}" data-id="${c.id}" onclick="selecionarCategoriaDetalhe(${c.id})">${c.icone} ${c.nome}</div>
    `).join('');
    document.getElementById('detalheCategoriaChips').dataset.selecionado = registro.categoriaId;

    const cartoes = await DB.listarTodos('cartao');
    document.getElementById('detalheCartaoChips').innerHTML = cartoes.map((c) => `
      <div class="chip ${c.id === registro.cartaoId ? 'selected' : ''}" data-id="${c.id}" onclick="selecionarCartaoDetalhe(${c.id})">💳 ${c.nome}</div>
    `).join('');
    document.getElementById('detalheCartaoChips').dataset.selecionado = registro.cartaoId || '';

    document.getElementById('blocoCategoriaDetalhe').style.display = 'block';
    document.getElementById('blocoCartaoDetalhe').style.display = 'block';
    document.getElementById('detalheData').value = registro.data.slice(0, 10);
  } else {
    const registro = await DB.obterPorId('receita', id);
    document.getElementById('detalheTitulo').textContent = 'Editar receita';
    aplicarMascaraMoeda(document.getElementById('detalheValor'));
    definirValorMascarado(document.getElementById('detalheValor'), registro.valor);
    document.getElementById('detalheDescricao').value = registro.descricao || '';
    document.getElementById('detalheDescricao').placeholder = 'Descrição';
    document.getElementById('blocoCategoriaDetalhe').style.display = 'none';
    document.getElementById('blocoCartaoDetalhe').style.display = 'none';
    document.getElementById('detalheData').value = registro.data.slice(0, 10);
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

  const dataEscolhida = document.getElementById('detalheData').value; // "AAAA-MM-DD"
  const [ano, mes, dia] = dataEscolhida.split('-').map(Number);
  const dataFinal = new Date(ano, mes - 1, dia).toISOString();

  if (transacaoEmEdicao.tipo === 'despesa') {
    const categoriaId = Number(document.getElementById('detalheCategoriaChips').dataset.selecionado);
    const cartaoTexto = document.getElementById('detalheCartaoChips').dataset.selecionado;
    const cartaoId = cartaoTexto ? Number(cartaoTexto) : null;

    if (!categoriaId) { alert('Escolha uma categoria.'); return; }

    const registro = await DB.obterPorId('despesa', transacaoEmEdicao.id);
    await DB.atualizar('despesa', { ...registro, valor, descricao, categoriaId, cartaoId, data: dataFinal });
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

  await DB.remover(transacaoEmEdicao.tipo, transacaoEmEdicao.id);
  fecharModalDetalhe();
  await recarregarListaTransacoes();
}
