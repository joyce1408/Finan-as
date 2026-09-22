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

async function removerDuplicatas() {
  const ok = confirm('Isso procura despesas idênticas (mesmo valor, data, descrição e cartão) e apaga as cópias repetidas, mantendo só uma de cada. Útil quando uma importação de fatura acaba rodando duas vezes. Continuar?');
  if (!ok) return;

  const quantidade = await DB.removerDespesasDuplicadas();
  if (quantidade === 0) {
    alert('Nenhuma duplicata encontrada — está tudo certo.');
  } else {
    alert(`${quantidade} despesa(s) duplicada(s) removida(s).`);
  }
  await renderMais();
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
  // 'fatura' faltava aqui desde a v5 do schema (Despesa → Fatura → Cartão) —
  // sem ela, o backup nunca incluía mesFatura/statusPagamento/origem, só as
  // despesas com o faturaId apontando pro nada depois de um restore.
  const stores = ['categoria', 'cartao', 'despesa', 'renda', 'reserva', 'receita', 'fatura'];
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

// ---------- Restaurar backup (recuperação de dados) ----------
// Guarda o JSON já lido/parseado enquanto a usuária decide (na tela de
// confirmação) se quer substituir os dados atuais — evita reabrir o
// seletor de arquivo de novo só pra confirmar.
let dadosBackupPendente = null;

function abrirModalRestauracao(titulo) {
  document.getElementById('tituloRestauracao').textContent = titulo;
  document.getElementById('sheetOverlayRestauracao').classList.add('open');
}

function fecharModalRestauracao() {
  document.getElementById('sheetOverlayRestauracao').classList.remove('open');
  document.getElementById('botaoConfirmarRestauracao').style.display = 'none';
}

async function arquivoBackupSelecionado(event) {
  const arquivo = event.target.files[0];
  event.target.value = ''; // permite selecionar o mesmo arquivo de novo depois, se precisar
  if (!arquivo) return;

  let dados;
  try {
    const texto = await arquivo.text();
    dados = JSON.parse(texto);
  } catch (e) {
    abrirModalRestauracao('Não deu pra ler o arquivo');
    document.getElementById('corpoRestauracao').textContent =
      `O arquivo selecionado não é um JSON válido.\n\nErro técnico: ${e.message}\n\nNenhum dado foi alterado no app — nada foi escrito no banco.`;
    return;
  }

  await processarRestauracao(dados, false);
}

async function processarRestauracao(dados, confirmarSubstituicao) {
  const resultado = await DB.restaurarBackup(dados, { confirmarSubstituicao });

  if (resultado.status === 'invalido') {
    dadosBackupPendente = null;
    abrirModalRestauracao('Backup inválido — nada foi alterado');
    document.getElementById('corpoRestauracao').textContent =
      'O arquivo não passou na validação e NADA foi escrito no banco:\n\n' +
      resultado.erros.map((e) => `• ${e}`).join('\n');
    return;
  }

  if (resultado.status === 'aguardando_confirmacao') {
    dadosBackupPendente = dados;
    abrirModalRestauracao('Já existem dados neste iPhone');
    const linhas = [
      'O banco atual deste iPhone já tem registros. Pra nunca sobrescrever nada sem confirmação, a restauração foi INTERROMPIDA — nada foi apagado ou alterado ainda.',
      '',
      'Dados ATUAIS neste iPhone:',
      ...Object.entries(resultado.contagemAtual).map(([s, n]) => `  ${s}: ${n}`),
      '',
      'Dados NO BACKUP selecionado:',
      ...Object.entries(resultado.contagemBackup).map(([s, n]) => `  ${s}: ${n}`),
      '',
      'Se continuar, TODOS os dados atuais acima serão substituídos pelos dados do backup (nunca mesclados). Só confirme se tiver certeza de que o backup é a versão que você quer manter.'
    ];
    document.getElementById('corpoRestauracao').textContent = linhas.join('\n');
    document.getElementById('botaoConfirmarRestauracao').style.display = 'block';
    return;
  }

  // status === 'restaurado'
  dadosBackupPendente = null;
  abrirModalRestauracao('Backup restaurado');
  document.getElementById('botaoConfirmarRestauracao').style.display = 'none';
  document.getElementById('corpoRestauracao').textContent = montarRelatorioFinal(resultado);
  await renderMais();
}

async function confirmarSubstituicaoBackup() {
  if (!dadosBackupPendente) return;
  await processarRestauracao(dadosBackupPendente, true);
}

function montarRelatorioFinal(r) {
  const linhas = [
    'Restauração concluída.',
    '',
    'Registros restaurados por store (preservando os IDs originais do backup):',
    ...Object.entries(r.contagemRestaurada).map(([s, n]) => `  ${s}: ${n}`),
    '',
    `Total de registros no banco depois da restauração:`,
    ...Object.entries(r.contagemDepois).map(([s, n]) => `  ${s}: ${n}`),
    '',
    `Parcelas futuras geradas pela migração (migrarParcelamentosExistentes): ${r.parcelasGeradasPelaMigracao}`,
    '',
    'Faturas restauradas (confira os valores/datas contra o backup — nada aqui foi inventado ou corrigido):'
  ];
  for (const f of r.faturas) {
    linhas.push(`  fatura id ${f.id} · cartaoId ${f.cartaoId} · mesFatura ${f.mesFatura} · total R$ ${Number(f.totalOficial).toFixed(2)} · ${f.statusPagamento} · origem ${f.origem}`);
    linhas.push(`    fechamento ${f.fechamento ? new Date(f.fechamento).toLocaleDateString('pt-BR') : '—'} · vencimento ${f.vencimento ? new Date(f.vencimento).toLocaleDateString('pt-BR') : '—'}`);
  }
  linhas.push('');
  linhas.push('Séries de parcelamento restauradas/migradas:');
  for (const serie of r.seriesDeParcelamento) {
    linhas.push(`  idParcelamento ${serie.idParcelamento}:`);
    for (const p of serie.parcelas) {
      linhas.push(`    ${p.parcelaAtual}/${p.parcelaTotal} · R$ ${Number(p.valor).toFixed(2)} · ${p.data.slice(0, 10)} · ${p.statusDespesa} · faturaId ${p.faturaId ?? '—'}`);
    }
  }
  linhas.push('');
  linhas.push('Confira: cada valor/data/status acima precisa bater exatamente com o que está no arquivo de backup. Nenhum valor ou data real foi recalculado nesta restauração.');
  return linhas.join('\n');
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
