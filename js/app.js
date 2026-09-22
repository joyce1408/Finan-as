// app.js — bootstrap do app, conecta db.js + motor.js às telas

const CORES_CATEGORIA = ['#1B2A4A', '#2F9E62', '#C7902E', '#8A5FD1', '#E0669B', '#2F5FE0', '#C7CCD6'];
const CORES_CARTAO = { 'Nubank': '#820AD1', 'Inter': '#FF7A00' };

let categoriaSelecionadaId = null;
let cartaoSelecionadoId = null;
let formaPagamentoSelecionada = 'cartao';
let tipoLancamento = 'despesa';

// Valores reais guardados em memória para poder ocultar/exibir sem recalcular
let valoresAtuais = { saldo: 0, entradas: 0, saidas: 0, reserva: 0, reservaMeta: 0 };

function valoresVisiveis() {
  return sessionStorage.getItem('ffjoyce2026_valores_visiveis') === '1';
}

function alternarVisibilidade() {
  const novoEstado = !valoresVisiveis();
  sessionStorage.setItem('ffjoyce2026_valores_visiveis', novoEstado ? '1' : '0');
  aplicarVisibilidade();
}

function aplicarVisibilidade() {
  const visivel = valoresVisiveis();
  const oculto = 'R$ ••••';

  document.getElementById('saldoValor').textContent = visivel ? formatarMoeda(valoresAtuais.saldo) : oculto;
  document.getElementById('entradasValor').textContent = visivel ? formatarMoeda(valoresAtuais.entradas) : oculto;
  document.getElementById('saidasValor').textContent = visivel ? formatarMoeda(valoresAtuais.saidas) : oculto;
  document.getElementById('reservaValor').textContent = visivel ? formatarMoeda(valoresAtuais.reserva) : oculto;
  document.getElementById('reservaMeta').textContent = visivel ? `Meta: ${formatarMoeda(valoresAtuais.reservaMeta)}` : 'Meta: R$ ••••';

  const icone = visivel ? '👁️' : '👁️‍🗨️';
  document.getElementById('btnOlhoSaldo').textContent = icone;
  document.getElementById('btnOlhoReserva').textContent = icone;
}

function alternarTipo(tipo) {
  tipoLancamento = tipo;
  document.querySelectorAll('.type-option').forEach((el) => {
    el.classList.toggle('selected', el.dataset.tipo === tipo);
  });
  document.getElementById('camposDespesa').style.display = tipo === 'despesa' ? 'block' : 'none';
  document.getElementById('camposReceita').style.display = tipo === 'receita' ? 'block' : 'none';
  document.getElementById('camposReserva').style.display = tipo === 'reserva' ? 'block' : 'none';
  document.getElementById('sheetTitle').textContent = tipo === 'despesa' ? 'Nova despesa' : tipo === 'receita' ? 'Nova receita' : 'Aporte na reserva';
}

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function renderHome() {
  const agora = new Date();
  const nome = localStorage.getItem('ffjoyce2026_nome_usuaria') || 'Joyce Pinheiro';
  document.getElementById('greeting').textContent = `${saudacao()}, ${nome}!`;

  const dataCompleta = capitalizar(
    agora.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
  );
  const horaAtual = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('monthLabel').textContent = `${dataCompleta} · ${horaAtual}`;

  carregarFotoPerfil();

  const { entradas: renda, saidas: totalGasto, saldo } = await DB.saldoDisponivelDoMes();

  valoresAtuais.saldo = saldo;
  valoresAtuais.entradas = renda;
  valoresAtuais.saidas = totalGasto;

  document.getElementById('totalGastoLabel').textContent = formatarMoeda(await DB.totalGastoNoMes());

  // Barras por categoria
  const categorias = await DB.gastosPorCategoria();
  const totalGeral = categorias.reduce((s, c) => s + c.total, 0) || 1;
  const barList = document.getElementById('barList');
  barList.innerHTML = '';

  categorias.filter(c => c.total > 0).slice(0, 5).forEach((c, i) => {
    const pct = ((c.total / totalGeral) * 100).toFixed(0);
    const cor = CORES_CATEGORIA[i % CORES_CATEGORIA.length];
    barList.insertAdjacentHTML('beforeend', `
      <div class="bar-row">
        <div class="bar-row-top">
          <div class="bar-name"><span class="dot" style="background:${cor}"></span>${c.nome}</div>
          <div class="bar-right"><span class="bar-value">${formatarMoeda(c.total)}</span><span class="bar-pct">${pct}%</span></div>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${cor}"></div></div>
      </div>
    `);
  });

  // Próximas faturas — sempre a partir das faturas REAIS (importadas ou
  // reconstruídas pela migração), nunca mais recalculado por data. Regra
  // 11/13/19 da revisão: o status de pagamento é uma propriedade da fatura,
  // NUNCA um critério pra tirá-la da tela — uma fatura paga continua
  // existindo e continua aparecendo aqui, só marcada como "✅ Paga". A
  // mensagem "Nenhuma fatura importada ainda" só pode aparecer quando não
  // existe NENHUMA fatura cadastrada (nunca quando existem, mas todas já
  // foram pagas).
  const todasFaturas = await DB.faturasClassificadas();
  const billsList = document.getElementById('billsList');
  billsList.innerHTML = '';

  if (todasFaturas.length === 0) {
    billsList.innerHTML = `<div style="text-align:center;padding:20px 0;color:var(--ink-soft);font-size:13px">Nenhuma fatura importada ainda.</div>`;
  }

  // Mostra até 3 faturas: prioriza as pendentes de pagamento (mais urgente
  // primeiro); se não houver pendências suficientes pra preencher a lista,
  // completa com as pagas mais recentes — uma fatura paga nunca desaparece,
  // só perde prioridade de destaque pra quem ainda precisa ser paga.
  const naoPagas = todasFaturas.filter((f) => f.situacao !== 'quitada');
  const pagas = todasFaturas.filter((f) => f.situacao === 'quitada').sort((a, b) => b.vencimento - a.vencimento);
  const faturasParaMostrar = [...naoPagas, ...pagas].slice(0, 3);

  for (const f of faturasParaMostrar) {
    let tag, textoData;
    if (f.situacao === 'quitada') {
      tag = { classe: 'tag-ok', texto: '✅ Paga' };
      textoData = `Fatura de ${f.mesFatura} · paga`;
    } else if (f.situacao === 'vencida') {
      tag = { classe: 'tag-urgent', texto: '🔴 Vencida' };
      textoData = `Venceu há ${Math.abs(f.diasRestantes)} dias · ${f.vencimento.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`;
    } else {
      tag = f.diasRestantes <= 5
        ? { classe: 'tag-urgent', texto: 'Vence logo' }
        : f.diasRestantes <= 12
          ? { classe: 'tag-soon', texto: 'Em breve' }
          : { classe: 'tag-ok', texto: 'Não paga' };
      textoData = `Vence em ${f.diasRestantes} dias · ${f.vencimento.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`;
    }
    const iniciais = f.cartaoNome.slice(0, 2).toUpperCase();
    const cor = CORES_CARTAO[f.cartaoNome] || '#3B3B3B';

    billsList.insertAdjacentHTML('beforeend', `
      <div class="bill-card" onclick="location.href='cartao-detalhe.html?id=${f.cartaoId}'" style="cursor:pointer">
        <div class="bill-icon" style="background:${cor}">${iniciais}</div>
        <div class="bill-info">
          <div class="bill-name">Cartão ${f.cartaoNome}</div>
          <div class="bill-date">${textoData}</div>
        </div>
        <div>
          <div class="bill-amount">${formatarMoeda(f.totalOficial)}</div>
          <span class="bill-tag ${tag.classe}">${tag.texto}</span>
        </div>
      </div>
    `);
  }

  // Insight de poupança (motor de regras)
  const gastoEstiloVida = categorias
    .filter(c => c.tipo === 'estilo_de_vida')
    .reduce((s, c) => s + c.total, 0);
  const insight = Motor.avaliarPoupanca(renda, gastoEstiloVida);

  // Ajuste da revisão final (item 4): quando ainda não existe NENHUMA
  // despesa confirmada no mês (totalGasto vem de saidasConfirmadasDoMes,
  // já calculado acima em DB.saldoDisponivelDoMes — regra 4/14), dizer que
  // os gastos estão "sob controle" é uma conclusão precipitada: não há
  // gasto nenhum ainda pra avaliar. Isso troca só o TEXTO exibido aqui —
  // o cálculo do Motor (avaliarPoupanca, percentual, alerta) continua
  // exatamente o mesmo e intocado, e só entra em jogo quando não há alerta.
  const semGastoConfirmadoAinda = totalGasto === 0 && !insight.alerta;
  const insightTitulo = semGastoConfirmadoAinda
    ? 'Tudo certo por enquanto'
    : (insight.alerta ? 'Oportunidade de economia' : 'Tudo em ordem');
  const insightTexto = semGastoConfirmadoAinda
    ? 'Ainda não há gastos confirmados registrados neste mês.'
    : insight.texto;

  document.getElementById('insightBox').innerHTML = `
    <div class="insight-card ${insight.alerta ? 'alert' : 'save'}">
      <div class="insight-icon">${insight.alerta ? '⚠️' : '✅'}</div>
      <div>
        <div class="insight-title">${insightTitulo}</div>
        <div class="insight-text">${insightTexto}</div>
      </div>
    </div>
  `;

  // Central de Avisos (substitui notificações push, roda 100% local)
  const avisos = await Avisos.gerarAvisos();
  const avisosBox = document.getElementById('avisosBox');
  if (avisos.length === 0) {
    avisosBox.innerHTML = '';
  } else {
    avisosBox.innerHTML = `
      <div class="section-title" style="margin-bottom:10px">Avisos</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${avisos.map((a) => `
          <div class="aviso-card aviso-${a.tipo}">
            <div class="aviso-icon">${a.icone}</div>
            <div class="aviso-text">${a.texto}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // Reserva de emergência (card com toggle de visibilidade)
  const reservas = await DB.listarTodos('reserva');
  const reserva = reservas[0] || { valorAtual: 0, meta: 15000 };
  valoresAtuais.reserva = reserva.valorAtual;
  valoresAtuais.reservaMeta = reserva.meta;

  // ---------- Sistema de alertas visuais dinâmicos ----------
  // Cenário 1: crítico — saldo <= 15% da renda (aproximação de "quase sem dinheiro
  // para as contas fixas restantes", já que o app não rastreia quais contas já
  // foram pagas dentro do mês)
  const limiteCritico = renda * 0.15;
  const estadoCritico = renda > 0 && saldo <= limiteCritico;

  // Cenário 3: calmo — nenhuma fatura NÃO PAGA vencendo nos próximos 3 dias
  // (uma fatura já paga não conta pra esse alerta) e saldo acima da meta de
  // poupança que a categoria "Essenciais" consome no mês
  const semFaturaProxima = !naoPagas.some((f) => f.diasRestantes <= 3);
  const estadoCalmo = !estadoCritico && semFaturaProxima && saldo > 0 && reserva.valorAtual >= reserva.meta * 0.5;

  const balanceCard = document.getElementById('balanceCard');
  balanceCard.classList.toggle('estado-critico', estadoCritico);
  balanceCard.classList.toggle('estado-calmo', estadoCalmo);

  const calmBanner = document.getElementById('calmBanner');
  calmBanner.innerHTML = estadoCalmo ? `<div class="calm-banner">Tudo sob controle por aqui! 🌟</div>` : '';

  aplicarVisibilidade();
}

async function editarRendaHome() {
  const mesAtual = DB.mesAtualISO();
  const rendas = await DB.listarTodos('renda');
  const atual = rendas.find((r) => r.mesReferencia === mesAtual);

  const novaRenda = prompt('Qual é a sua renda mensal? (R$)', atual ? atual.valorMensal : 0);
  if (novaRenda === null) return;
  const valor = parseFloat(novaRenda);
  if (isNaN(valor) || valor < 0) { alert('Valor inválido.'); return; }

  if (atual) {
    await DB.atualizar('renda', { ...atual, valorMensal: valor });
  } else {
    await DB.adicionar('renda', { valorMensal: valor, mesReferencia: mesAtual });
  }

  await renderHome();
}

function saudacao() {
  const h = new Date().getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function capitalizar(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Foto de perfil (100% local, salva como imagem reduzida em base64) ----------

function carregarFotoPerfil() {
  const salva = localStorage.getItem('ffjoyce2026_foto_perfil');
  const container = document.getElementById('profilePhoto');
  if (salva) {
    container.innerHTML = `<img src="${salva}" alt="Foto de perfil">`;
  } else {
    container.innerHTML = `<span>👤</span>`;
  }
}

function processarNovaFotoPerfil(arquivo) {
  const leitor = new FileReader();
  leitor.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Reduz a imagem antes de salvar, pra não pesar no localStorage
      const tamanho = 200;
      const canvas = document.createElement('canvas');
      canvas.width = tamanho;
      canvas.height = tamanho;
      const ctx = canvas.getContext('2d');

      const escala = Math.max(tamanho / img.width, tamanho / img.height);
      const w = img.width * escala;
      const h = img.height * escala;
      ctx.drawImage(img, (tamanho - w) / 2, (tamanho - h) / 2, w, h);

      const base64 = canvas.toDataURL('image/jpeg', 0.85);
      localStorage.setItem('ffjoyce2026_foto_perfil', base64);
      carregarFotoPerfil();
    };
    img.src = e.target.result;
  };
  leitor.readAsDataURL(arquivo);
}

document.getElementById('inputFotoPerfil').addEventListener('change', (e) => {
  const arquivo = e.target.files[0];
  if (arquivo) processarNovaFotoPerfil(arquivo);
  e.target.value = '';
});

// ---------- Relógio em tempo real (atualiza só a linha de data/hora, sem recarregar tudo) ----------

function atualizarRelogio() {
  const agora = new Date();
  const dataCompleta = capitalizar(
    agora.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
  );
  const horaAtual = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const label = document.getElementById('monthLabel');
  if (label) label.textContent = `${dataCompleta} · ${horaAtual}`;
}

setInterval(atualizarRelogio, 30000);

// ---------- Modal de cadastro ----------

async function abrirModal() {
  categoriaSelecionadaId = null;
  cartaoSelecionadoId = null;
  formaPagamentoSelecionada = 'cartao';
  document.getElementById('inputDataDespesa').value = new Date().toISOString().slice(0, 10);
  document.getElementById('inputValor').value = '';
  document.getElementById('inputDescricaoReceita').value = '';
  document.getElementById('alertaCartao').style.display = 'none';
  alternarTipo('despesa');
  aplicarMascaraMoeda(document.getElementById('inputValor'));

  document.querySelectorAll('#formaPagamentoChips .chip').forEach((c) => {
    c.classList.toggle('selected', c.dataset.forma === 'cartao');
  });
  document.getElementById('blocoCartaoEscolha').style.display = 'block';

  const categorias = await DB.listarTodos('categoria');
  const chipsCat = document.getElementById('categoriaChips');
  chipsCat.innerHTML = categorias.map(c => `
    <div class="chip" data-id="${c.id}" onclick="selecionarCategoria(${c.id})">${c.icone} ${c.nome}</div>
  `).join('');

  const cartoes = await DB.listarTodos('cartao');
  const chipsCartao = document.getElementById('cartaoChips');
  chipsCartao.innerHTML = cartoes.map(c => `
    <div class="chip" data-id="${c.id}" onclick="selecionarCartao(${c.id})">💳 ${c.nome}</div>
  `).join('');

  document.getElementById('sheetOverlay').classList.add('open');
  setTimeout(() => document.getElementById('inputValor').focus(), 150);
}

function fecharModal() {
  document.getElementById('sheetOverlay').classList.remove('open');
}

function fecharModalSeClicarFora(event) {
  if (event.target.id === 'sheetOverlay') fecharModal();
}

function selecionarFormaPagamento(forma) {
  formaPagamentoSelecionada = forma;
  document.querySelectorAll('#formaPagamentoChips .chip').forEach((c) => {
    c.classList.toggle('selected', c.dataset.forma === forma);
  });

  const mostraCartao = forma === 'cartao';
  document.getElementById('blocoCartaoEscolha').style.display = mostraCartao ? 'block' : 'none';

  if (!mostraCartao) {
    cartaoSelecionadoId = null;
    document.querySelectorAll('#cartaoChips .chip').forEach((c) => c.classList.remove('selected'));
    document.getElementById('alertaCartao').style.display = 'none';
  }
}

function selecionarCategoria(id) {
  categoriaSelecionadaId = id;
  document.querySelectorAll('#categoriaChips .chip').forEach(c => {
    c.classList.toggle('selected', Number(c.dataset.id) === id);
  });
}

async function selecionarCartao(id) {
  cartaoSelecionadoId = cartaoSelecionadoId === id ? null : id;
  document.querySelectorAll('#cartaoChips .chip').forEach(c => {
    c.classList.toggle('selected', Number(c.dataset.id) === cartaoSelecionadoId);
  });

  const alertaBox = document.getElementById('alertaCartao');
  if (cartaoSelecionadoId) {
    // comprometimento = valor oficial da fatura em destaque desse cartão
    // (a mais recente não paga, ou a última paga se não houver nenhuma em
    // aberto); nunca mais recalculado por ciclo de data
    const faturaDestaque = await DB.faturaEmDestaquePorCartao(cartaoSelecionadoId);
    const valorAtual = faturaDestaque ? faturaDestaque.totalOficial : 0;
    const renda = await DB.rendaAtual();
    const avaliacao = Motor.avaliarComprometimentoCartao(valorAtual, renda);
    alertaBox.style.display = 'block';
    alertaBox.textContent = avaliacao.texto;
    alertaBox.style.color = avaliacao.bloquear ? 'var(--red)' : 'var(--ink-soft)';
  } else {
    alertaBox.style.display = 'none';
  }
}

async function salvarDespesa() {
  const valor = valorNumericoDoInput(document.getElementById('inputValor'));
  if (!valor || valor <= 0) {
    document.getElementById('inputValor').focus();
    return;
  }

  if (tipoLancamento === 'receita') {
    await DB.adicionar('receita', {
      valor,
      data: new Date().toISOString(),
      descricao: document.getElementById('inputDescricaoReceita').value.trim() || 'Receita avulsa'
    });
    fecharModal();
    await renderHome();
    return;
  }

  if (tipoLancamento === 'reserva') {
    await DB.adicionarAporte(valor);
    fecharModal();
    await renderHome();
    return;
  }

  if (!categoriaSelecionadaId) {
    alert('Escolha uma categoria.');
    return;
  }

  if (formaPagamentoSelecionada === 'cartao' && !cartaoSelecionadoId) {
    alert('Escolha qual cartão foi usado (ou troque a forma de pagamento).');
    return;
  }

  const dataEscolhida = document.getElementById('inputDataDespesa').value; // formato "AAAA-MM-DD"
  const [ano, mes, dia] = dataEscolhida.split('-').map(Number);
  const dataFinal = dataEscolhida ? new Date(ano, mes - 1, dia).toISOString() : new Date().toISOString();

  // Regra 4 do diagnóstico: uma despesa cadastrada aqui já aconteceu de
  // verdade (não é previsão), então statusDespesa já entra como 'confirmado'
  // na hora — sem isso, ela ficava invisível em Home/Relatórios/Categorias
  // até o app inteiro ser recarregado (só aí a migração preenchia o campo).
  // faturaId fica null: essa despesa ainda não está vinculada a nenhuma
  // fatura real (isso só acontece via importação, DB.importarFatura); até lá
  // a competência dela é a própria data real (ver competenciaDespesa em db.js).
  await DB.adicionar('despesa', {
    valor,
    categoriaId: categoriaSelecionadaId,
    cartaoId: formaPagamentoSelecionada === 'cartao' ? cartaoSelecionadoId : null,
    faturaId: null,
    formaPagamento: formaPagamentoSelecionada,
    data: dataFinal,
    parcelaAtual: 1,
    parcelaTotal: 1,
    idParcelamento: null,
    statusDespesa: 'confirmado',
    editadoManualmente: false,
    descricao: ''
  });

  fecharModal();
  await renderHome();
}

// ---------- Bootstrap ----------

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  await renderHome();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
