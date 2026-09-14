// categorias.js — CRUD de categorias, incluindo o campo grupoGrafico que
// alimenta o gráfico de colunas em Relatórios.

const ICONES_DISPONIVEIS = ['🏷️', '🐾', '🏋️', '📚', '☕', '🎓', '💊', '⚡', '🎬', '📦', '⛽', '🎮', '🏥', '👶', '✈️', '🎁', '🧴', '🐶', '🌱', '🎨'];
const GRUPOS_DISPONIVEIS = ['Essenciais', 'Alimentação', 'Transporte', 'Lazer', 'Outros'];

let iconeSelecionado = null;
let grupoSelecionadoModal = null;

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function renderCategoriasLista() {
  const categorias = await DB.listarTodos('categoria');
  const lista = document.getElementById('listaCategorias');

  lista.innerHTML = categorias.map((c) => {
    const ehOutros = c.nome === 'Outros';
    return `
      <div class="cat-manage-row">
        <div class="cat-manage-icon">${c.icone}</div>
        <div class="cat-manage-info">
          <div class="cat-manage-nome">${c.nome}</div>
          <div class="cat-manage-meta">${c.grupoGrafico || 'Outros'}${c.limiteMensal ? ` · limite ${formatarMoeda(c.limiteMensal)}` : ''}</div>
        </div>
        <button class="cat-manage-delete" ${ehOutros ? 'disabled title="\'Outros\' não pode ser excluída — é o destino padrão de despesas sem categoria"' : ''} onclick="${ehOutros ? '' : `excluirCategoria(${c.id}, '${c.nome.replace(/'/g, "\\'")}')`}">🗑️</button>
      </div>
    `;
  }).join('');
}

function abrirModalCategoria() {
  document.getElementById('inputNomeCategoria').value = '';
  document.getElementById('inputLimiteCategoria').value = '';
  aplicarMascaraMoeda(document.getElementById('inputLimiteCategoria'));
  iconeSelecionado = ICONES_DISPONIVEIS[0];
  grupoSelecionadoModal = 'Outros';

  document.getElementById('iconPickerGrid').innerHTML = ICONES_DISPONIVEIS.map((icone) => `
    <button class="icon-picker-btn ${icone === iconeSelecionado ? 'selected' : ''}" data-icone="${icone}" onclick="selecionarIcone('${icone}')">${icone}</button>
  `).join('');

  document.getElementById('grupoPicker').innerHTML = GRUPOS_DISPONIVEIS.map((g) => `
    <div class="grupo-chip ${g === grupoSelecionadoModal ? 'selected' : ''}" data-grupo="${g}" onclick="selecionarGrupo('${g}')">${g}</div>
  `).join('');

  document.getElementById('sheetOverlay').classList.add('open');
}

function selecionarIcone(icone) {
  iconeSelecionado = icone;
  document.querySelectorAll('.icon-picker-btn').forEach((b) => b.classList.toggle('selected', b.dataset.icone === icone));
}

function selecionarGrupo(grupo) {
  grupoSelecionadoModal = grupo;
  document.querySelectorAll('.grupo-chip').forEach((b) => b.classList.toggle('selected', b.dataset.grupo === grupo));
}

function fecharModal() {
  document.getElementById('sheetOverlay').classList.remove('open');
}

function fecharModalSeClicarFora(event) {
  if (event.target.id === 'sheetOverlay') fecharModal();
}

async function salvarCategoria() {
  const nome = document.getElementById('inputNomeCategoria').value.trim();
  const limiteTexto = document.getElementById('inputLimiteCategoria').value;
  const limiteMensal = limiteTexto ? parseFloat(limiteTexto) : 200;

  if (!nome) { alert('Digite um nome para a categoria.'); return; }

  // Essenciais/Alimentação/Transporte contam como gasto essencial pro motor
  // de regras; Lazer/Outros contam como estilo de vida
  const tipo = ['Essenciais', 'Alimentação', 'Transporte'].includes(grupoSelecionadoModal) ? 'essencial' : 'estilo_de_vida';

  await DB.adicionar('categoria', {
    nome,
    icone: iconeSelecionado,
    grupoGrafico: grupoSelecionadoModal,
    tipo,
    limiteMensal: isNaN(limiteMensal) ? 200 : limiteMensal
  });

  fecharModal();
  await renderCategoriasLista();
}

async function excluirCategoria(id, nome) {
  const ok = confirm(`Excluir a categoria "${nome}"? As despesas já registradas nela passam a ser contadas em "Outros".`);
  if (!ok) return;

  const categorias = await DB.listarTodos('categoria');
  const outros = categorias.find((c) => c.nome === 'Outros');

  const despesas = await DB.listarTodos('despesa');
  for (const d of despesas) {
    if (d.categoriaId === id) {
      await DB.atualizar('despesa', { ...d, categoriaId: outros.id });
    }
  }

  await DB.remover('categoria', id);
  await renderCategoriasLista();
}

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  await renderCategoriasLista();
})();
