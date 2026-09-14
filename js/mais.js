// mais.js — conecta a tela Mais aos dados reais e às ações de segurança

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function renderMais() {
  const nome = localStorage.getItem('ffjoyce2026_nome_usuaria');
  if (nome) document.getElementById('profileNome').textContent = nome;

  const cartoes = await DB.listarTodos('cartao');
  const categorias = await DB.listarTodos('categoria');
  const reservas = await DB.listarTodos('reserva');
  const renda = await DB.rendaAtual();

  document.getElementById('qtdCartoes').textContent = cartoes.length;
  document.getElementById('qtdCategorias').textContent = categorias.length;

  const reserva = reservas[0] || { valorAtual: 0, meta: 15000 };
  document.getElementById('metaReserva').textContent = `Meta: ${formatarMoeda(reserva.meta)}`;
  document.getElementById('rendaFixa').textContent = formatarMoeda(renda);

  atualizarToggleFaceId();
}

function atualizarToggleFaceId() {
  const ligado = window.Seguranca && Seguranca.faceIdConfigurado();
  document.getElementById('toggleFaceId').classList.toggle('on', !!ligado);
}

async function alternarFaceId() {
  if (!window.Seguranca) return;

  if (Seguranca.faceIdConfigurado()) {
    const ok = confirm('Desativar o desbloqueio por Face ID/Touch ID?');
    if (ok) {
      Seguranca.removerFaceId();
      atualizarToggleFaceId();
    }
    return;
  }

  if (!Seguranca.pinConfigurado()) {
    alert('Configure um PIN primeiro (feche e abra o app novamente para criar um).');
    return;
  }

  const sucesso = await Seguranca.registrarFaceId();
  if (sucesso) {
    alert('Face ID/Touch ID configurado! Da próxima vez que o app pedir o PIN, você poderá usar o atalho biométrico.');
  }
  atualizarToggleFaceId();
}

function removerFotoPerfil() {
  const tinhaFoto = !!localStorage.getItem('ffjoyce2026_foto_perfil');
  if (!tinhaFoto) {
    alert('Não há nenhuma foto de perfil salva no momento.');
    return;
  }
  const ok = confirm('Remover a foto de perfil da Home? Você pode escolher outra depois, tocando no círculo.');
  if (!ok) return;
  localStorage.removeItem('ffjoyce2026_foto_perfil');
  alert('Foto removida.');
}

async function limparDespesasExemplo() {
  const ok = confirm('Isso vai apagar TODAS as despesas cadastradas (inclusive as de exemplo que vieram com o app), pra você começar a lançar as suas de verdade. Seus cartões, categorias e renda continuam como estão. Deseja continuar?');
  if (!ok) return;

  await DB.limparStore('despesa');
  alert('Despesas removidas! O app está zerado, pronto pra você começar a cadastrar de verdade.');
  await renderMais();
}

let campoEmEdicaoValor = null; // 'renda' | 'reserva'

async function abrirModalValor(campo) {
  campoEmEdicaoValor = campo;
  aplicarMascaraMoeda(document.getElementById('inputModalValor'));

  if (campo === 'reserva') {
    const reservas = await DB.listarTodos('reserva');
    const reserva = reservas[0] || { valorAtual: 0, meta: 0 };
    document.getElementById('tituloModalValor').textContent = 'Meta da reserva de emergência';
    definirValorMascarado(document.getElementById('inputModalValor'), reserva.meta);
  } else {
    const mesAtual = DB.mesAtualISO();
    const rendas = await DB.listarTodos('renda');
    const atual = rendas.find((r) => r.mesReferencia === mesAtual);
    document.getElementById('tituloModalValor').textContent = 'Renda mensal fixa';
    definirValorMascarado(document.getElementById('inputModalValor'), atual ? atual.valorMensal : 0);
  }

  document.getElementById('sheetOverlayValor').classList.add('open');
  setTimeout(() => document.getElementById('inputModalValor').focus(), 150);
}

function fecharModalValor() {
  document.getElementById('sheetOverlayValor').classList.remove('open');
  campoEmEdicaoValor = null;
}

function fecharModalValorSeClicarFora(event) {
  if (event.target.id === 'sheetOverlayValor') fecharModalValor();
}

async function salvarModalValor() {
  const valor = valorNumericoDoInput(document.getElementById('inputModalValor'));
  if (isNaN(valor) || valor < 0) { alert('Valor inválido.'); return; }

  if (campoEmEdicaoValor === 'reserva') {
    const reservas = await DB.listarTodos('reserva');
    if (reservas[0]) {
      await DB.atualizar('reserva', { ...reservas[0], meta: valor });
    } else {
      await DB.adicionar('reserva', { valorAtual: 0, meta: valor });
    }
  } else {
    const mesAtual = DB.mesAtualISO();
    const rendas = await DB.listarTodos('renda');
    const atual = rendas.find((r) => r.mesReferencia === mesAtual);
    if (atual) {
      await DB.atualizar('renda', { ...atual, valorMensal: valor });
    } else {
      await DB.adicionar('renda', { valorMensal: valor, mesReferencia: mesAtual });
    }
  }

  fecharModalValor();
  await renderMais();
}

async function exportarDados() {
  const stores = ['categoria', 'cartao', 'despesa', 'renda', 'reserva', 'receita'];
  const dump = {};
  for (const s of stores) dump[s] = await DB.listarTodos(s);

  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `financas-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function apagarTudo() {
  const ok = confirm('Isso vai apagar PERMANENTEMENTE todos os seus dados financeiros deste iPhone. Essa ação não pode ser desfeita. Deseja continuar?');
  if (!ok) return;
  const okFinal = confirm('Tem certeza mesmo? Essa é sua última chance de cancelar.');
  if (!okFinal) return;

  await DB.apagarBancoCompleto();
  localStorage.removeItem('ffjoyce2026_pin_hash');
  localStorage.removeItem('ffjoyce2026_recovery_hash');
  localStorage.removeItem('ffjoyce2026_webauthn_id');
  sessionStorage.removeItem('ffjoyce2026_desbloqueado');
  location.href = 'index.html';
}

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  await renderMais();
})();
