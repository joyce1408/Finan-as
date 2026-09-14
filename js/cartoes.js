// cartoes.js — lista os cartões reais do IndexedDB com resumo de fatura e limite

const CORES_CARTAO_FIXAS = { 'Nubank': '#820AD1', 'Inter': '#FF7A00', 'Itaú': '#EC7000', 'Santander': '#EC0000', 'C6': '#242424', 'Bradesco': '#CC092F', 'Banco do Brasil': '#F8D117' };

function corParaCartao(nome) {
  if (CORES_CARTAO_FIXAS[nome]) return CORES_CARTAO_FIXAS[nome];
  // gera uma cor estável a partir do nome, para bancos não mapeados
  let hash = 0;
  for (let i = 0; i < nome.length; i++) hash = nome.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 40%)`;
}

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function renderCartoes() {
  const cartoes = await DB.cartoesComResumo();
  const lista = document.getElementById('listaCartoes');

  if (cartoes.length === 0) {
    lista.innerHTML = `<div class="empty-state" style="text-align:center;padding:50px 20px;color:var(--ink-soft);font-size:13.5px;line-height:1.5">Nenhum cartão cadastrado.<br>Toque no "+ Adicionar cartão" abaixo para adicionar seu primeiro cartão.</div>`;
    return;
  }

  lista.innerHTML = cartoes.map((c) => {
    const status = Motor.statusLimite(c.percentualUsado);
    const iniciais = c.nome.slice(0, 2).toUpperCase();
    const cor = corParaCartao(c.nome);
    const emAviso = c.percentualUsado >= 80;
    return `
      <div class="card-item ${emAviso ? 'estado-aviso' : ''}">
        <div class="card-item-top" onclick="location.href='cartao-detalhe.html?id=${c.id}'" style="cursor:pointer">
          <div class="card-avatar" style="background:${cor}">${iniciais}</div>
          <div>
            <div class="card-item-name">${c.nome}</div>
            <div class="card-item-sub">Vence dia ${c.diaVencimento}</div>
          </div>
          <div class="card-item-value">
            <div class="card-item-value-num">${formatarMoeda(c.valorFatura)}</div>
            <div class="card-item-value-label">fatura atual</div>
          </div>
        </div>
        <div class="card-limit-track"><div class="card-limit-fill ${status}" style="width:${Math.min(c.percentualUsado, 100).toFixed(0)}%; background:var(--${status === 'ok' ? 'green' : status === 'warn' ? 'amber' : 'red'})"></div></div>
        <div class="card-limit-note">${c.percentualUsado.toFixed(0)}% do limite de ${formatarMoeda(c.limite)} usado${emAviso ? ' — evite novas compras parceladas' : ''}</div>
        <div class="card-item-actions">
          <button class="card-action-btn" onclick="abrirModalCartao(${c.id})">✏️ Editar</button>
          <button class="card-action-btn danger" onclick="excluirCartaoDaLista(${c.id}, '${c.nome.replace(/'/g, "\\'")}')">🗑️ Excluir</button>
        </div>
      </div>
    `;
  }).join('');
}

let idCartaoEmEdicao = null;

function abrirModalCartao(id) {
  idCartaoEmEdicao = id || null;
  document.getElementById('sheetTitleCartao').textContent = id ? 'Editar cartão' : 'Novo cartão';
  aplicarMascaraMoeda(document.getElementById('inputLimiteCartao'));

  if (id) {
    DB.obterPorId('cartao', id).then((cartao) => {
      document.getElementById('inputNomeCartao').value = cartao.nome;
      definirValorMascarado(document.getElementById('inputLimiteCartao'), cartao.limite);
      document.getElementById('inputVencimentoCartao').value = cartao.diaVencimento;
    });
  } else {
    document.getElementById('inputNomeCartao').value = '';
    document.getElementById('inputLimiteCartao').value = '';
    document.getElementById('inputVencimentoCartao').value = '';
  }
  document.getElementById('sheetOverlay').classList.add('open');
}

function fecharModal() {
  document.getElementById('sheetOverlay').classList.remove('open');
}

function fecharModalSeClicarFora(event) {
  if (event.target.id === 'sheetOverlay') fecharModal();
}

async function salvarCartao() {
  const nome = document.getElementById('inputNomeCartao').value.trim();
  const limite = valorNumericoDoInput(document.getElementById('inputLimiteCartao'));
  const diaVencimento = parseInt(document.getElementById('inputVencimentoCartao').value, 10);

  if (!nome) { alert('Informe o nome do banco.'); return; }
  if (!limite || limite <= 0) { alert('Informe um limite válido.'); return; }
  if (!diaVencimento || diaVencimento < 1 || diaVencimento > 31) { alert('Informe um dia de vencimento válido (1 a 31).'); return; }

  const dados = { nome, limite, diaFechamento: Math.max(1, diaVencimento - 9), diaVencimento };

  if (idCartaoEmEdicao) {
    const cartaoAtual = await DB.obterPorId('cartao', idCartaoEmEdicao);
    await DB.atualizar('cartao', { ...cartaoAtual, ...dados });
  } else {
    await DB.adicionar('cartao', dados);
  }

  fecharModal();
  await renderCartoes();
}

async function excluirCartaoDaLista(id, nome) {
  const ok = confirm(`Tem certeza que deseja excluir o cartão ${nome}? As despesas já registradas continuam no seu histórico, mas passam a aparecer como "Dinheiro/Pix" em vez do nome do banco.`);
  if (!ok) return;

  const despesas = await DB.listarTodos('despesa');
  for (const d of despesas) {
    if (d.cartaoId === id) {
      await DB.atualizar('despesa', { ...d, cartaoId: null });
    }
  }

  await DB.remover('cartao', id);
  await renderCartoes();
}

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  await renderCartoes();
})();
