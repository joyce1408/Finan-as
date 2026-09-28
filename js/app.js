// app.js — Home: conecta db.js + analises/motor.js à tela inicial.

const CORES_CATEGORIA = ['#1B2A4A', '#2F9E62', '#C7902E', '#8A5FD1', '#E0669B', '#2F5FE0', '#C7CCD6'];
const CORES_CARTAO = { 'Nubank': '#820AD1', 'Inter': '#FF7A00', 'Banco do Brasil': '#C9A800' };

let categoriaSelecionadaId = null; // escolhida pela pessoa (manual)
let categoriaSugeridaId = null;    // sugerida pela descrição (automática)
let cartaoSelecionadoId = null;
let formaPagamentoSelecionada = 'cartao';
let tipoLancamento = 'despesa';

let valoresAtuais = { saldo: 0, entradas: 0, saidas: 0, reserva: 0, reservaMetaTexto: 'Meta não definida' };

function formatarMoeda(valor) { return UI.moeda(valor); }

function valoresVisiveis() {
  return sessionStorage.getItem('ffjoyce2026_valores_visiveis') === '1';
}

function alternarVisibilidade() {
  sessionStorage.setItem('ffjoyce2026_valores_visiveis', valoresVisiveis() ? '0' : '1');
  aplicarVisibilidade();
}

function aplicarVisibilidade() {
  const visivel = valoresVisiveis();
  const oculto = 'R$ ••••';
  document.getElementById('saldoValor').textContent = visivel ? formatarMoeda(valoresAtuais.saldo) : oculto;
  document.getElementById('entradasValor').textContent = visivel ? formatarMoeda(valoresAtuais.entradas) : oculto;
  document.getElementById('saidasValor').textContent = visivel ? formatarMoeda(valoresAtuais.saidas) : oculto;
  document.getElementById('reservaValor').textContent = visivel ? formatarMoeda(valoresAtuais.reserva) : oculto;
  document.getElementById('reservaMeta').textContent = visivel ? valoresAtuais.reservaMetaTexto : 'Meta: R$ ••••';
  const icone = visivel ? '👁️' : '👁️‍🗨️';
  document.getElementById('btnOlhoSaldo').textContent = icone;
  document.getElementById('btnOlhoReserva').textContent = icone;
}

function alternarTipo(tipo) {
  tipoLancamento = tipo;
  document.querySelectorAll('.type-option').forEach((el) => el.classList.toggle('selected', el.dataset.tipo === tipo));
  document.getElementById('camposDespesa').style.display = tipo === 'despesa' ? 'block' : 'none';
  document.getElementById('camposReceita').style.display = tipo === 'receita' ? 'block' : 'none';
  document.getElementById('camposReserva').style.display = tipo === 'reserva' ? 'block' : 'none';
  document.getElementById('sheetTitle').textContent = tipo === 'despesa' ? 'Nova despesa' : tipo === 'receita' ? 'Nova receita' : 'Aporte na reserva';
}

function tagFaturaHome(f) {
  if (f.situacao === 'quitada') return { classe: 'tag-ok', texto: '✅ Paga' };
  if (f.situacao === 'vencida') return { classe: 'tag-urgent', texto: '🔴 Vencida' };
  if (f.diasRestantes !== null && f.diasRestantes <= 5) return { classe: 'tag-urgent', texto: 'Vence logo' };
  if (f.diasRestantes !== null && f.diasRestantes <= 12) return { classe: 'tag-soon', texto: 'Em breve' };
  return { classe: 'tag-urgent', texto: 'Não paga' };
}

function renderBateria(bateria) {
  const nivel = document.getElementById('bateriaNivel');
  const pct = document.getElementById('bateriaPct');
  document.getElementById('bateriaTexto').textContent = bateria.texto;
  nivel.classList.remove('alta', 'media', 'baixa');
  if (bateria.percentual === null) {
    nivel.style.width = '0%';
    pct.textContent = bateria.estado === 'sem_dados' ? 'Sem dados' : '—';
    document.getElementById('bateriaIcone').setAttribute('aria-label', 'Bateria financeira sem dados');
    return;
  }
  nivel.classList.add(bateria.faixa);
  nivel.style.width = `${bateria.percentual}%`;
  pct.textContent = `${bateria.percentual.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;
  document.getElementById('bateriaIcone').setAttribute('aria-label', `Bateria financeira em ${pct.textContent}`);
}

async function renderHome() {
  const agora = Datas.agora();
  const nome = localStorage.getItem('ffjoyce2026_nome_usuaria') || '';
  document.getElementById('greeting').textContent = nome ? `${saudacao()}, ${nome}!` : `${saudacao()}!`;
  atualizarRelogio();
  carregarFotoPerfil();

  const mesAtual = DB.mesAtualISO();
  const { entradas, saidas, saldo } = await DB.saldoDisponivelDoMes(mesAtual);
  valoresAtuais.saldo = saldo;
  valoresAtuais.entradas = entradas;
  valoresAtuais.saidas = saidas;

  renderBateria(Analises.avaliarBateria({ entradas, saidasConfirmadas: saidas }));

  document.getElementById('totalGastoLabel').textContent = formatarMoeda(saidas);

  // Barras por categoria (só gastos confirmados da competência do mês)
  const categorias = await DB.gastosPorCategoria(mesAtual);
  const totalGeral = categorias.reduce((s, c) => s + c.total, 0);
  const barList = document.getElementById('barList');
  const comGasto = categorias.filter((c) => c.total > 0).slice(0, 5);
  barList.innerHTML = comGasto.length === 0
    ? '<div style="text-align:center;padding:12px 0;color:var(--ink-soft);font-size:13px">Sem gastos confirmados neste mês.</div>'
    : comGasto.map((c, i) => {
      const pct = totalGeral > 0 ? ((c.total / totalGeral) * 100).toFixed(0) : '0';
      const cor = CORES_CATEGORIA[i % CORES_CATEGORIA.length];
      return `
      <div class="bar-row">
        <div class="bar-row-top">
          <div class="bar-name"><span class="dot" style="background:${cor}"></span>${UI.escapar(c.nome)}</div>
          <div class="bar-right"><span class="bar-value">${formatarMoeda(c.total)}</span><span class="bar-pct">${pct}%</span></div>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${cor}"></div></div>
      </div>`;
    }).join('');

  // Próximos vencimentos: todas as faturas reais, pendentes primeiro
  const todasFaturas = (await DB.faturasClassificadas()).filter((f) => !f.cartaoArquivado || f.situacao !== 'quitada');
  const billsList = document.getElementById('billsList');
  const naoPagas = todasFaturas.filter((f) => f.situacao !== 'quitada');
  const pagas = todasFaturas.filter((f) => f.situacao === 'quitada').sort((a, b) => (b.vencimentoDia || '').localeCompare(a.vencimentoDia || ''));
  billsList.innerHTML = todasFaturas.length === 0
    ? '<div style="text-align:center;padding:20px 0;color:var(--ink-soft);font-size:13px">Nenhuma fatura importada ainda.</div>'
    : [...naoPagas, ...pagas].map((f) => {
      const tag = tagFaturaHome(f);
      const venc = Datas.formatarDia(f.vencimentoDia, { day: '2-digit', month: 'short' });
      let textoData;
      if (f.situacao === 'quitada') textoData = `Fatura de ${Datas.rotuloMes(f.mesFatura)} · paga`;
      else if (f.situacao === 'vencida') textoData = `Venceu há ${Math.abs(f.diasRestantes)} dia(s) · ${venc}`;
      else textoData = f.diasRestantes === null ? `Fatura de ${Datas.rotuloMes(f.mesFatura)}` : `Vence em ${f.diasRestantes} dia(s) · ${venc}`;
      if (f.origem !== 'importada') textoData += ' · estimada';
      const cor = CORES_CARTAO[f.cartaoNome] || '#3B3B3B';
      return `
      <div class="bill-card" onclick="location.href='cartao-detalhe.html?id=${Number(f.cartaoId)}'" style="cursor:pointer">
        <div class="bill-icon" style="background:${cor}">${UI.escapar(f.cartaoNome.slice(0, 2).toUpperCase())}</div>
        <div class="bill-info">
          <div class="bill-name">Cartão ${UI.escapar(f.cartaoNome)}</div>
          <div class="bill-date">${UI.escapar(textoData)}</div>
        </div>
        <div>
          <div class="bill-amount">${formatarMoeda(f.totalOficial)}</div>
          <span class="bill-tag ${tag.classe}">${tag.texto}</span>
        </div>
      </div>`;
    }).join('');

  // Gastos sob controle (indicador próprio: % das entradas do mês)
  const sobControle = Analises.avaliarGastosSobControle({ entradas, saidasConfirmadas: saidas });
  const alerta = sobControle.estado === 'atencao' || sobControle.estado === 'acima_da_renda';
  document.getElementById('insightBox').innerHTML = `
    <div class="insight-card ${alerta ? 'alert' : 'save'}">
      <div class="insight-icon">${alerta ? '⚠️' : sobControle.estado === 'sob_controle' ? '✅' : 'ℹ️'}</div>
      <div>
        <div class="insight-title">${UI.escapar(sobControle.titulo)}</div>
        <div class="insight-text">${UI.escapar(sobControle.texto)}</div>
      </div>
    </div>`;

  const avisos = await Avisos.gerarAvisos();
  document.getElementById('avisosBox').innerHTML = avisos.length === 0 ? '' : `
    <div class="section-title" style="margin-bottom:10px">Avisos</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${avisos.map((a) => `
        <div class="aviso-card aviso-${a.tipo}">
          <div class="aviso-icon">${a.icone}</div>
          <div class="aviso-text">${UI.escapar(a.texto)}</div>
        </div>`).join('')}
    </div>`;

  // Reserva (sem meta inventada: meta 0 = "meta não definida")
  const reserva = Analises.avaliarReserva(await DB.obterReserva());
  valoresAtuais.reserva = reserva.valorAtual;
  valoresAtuais.reservaMetaTexto = reserva.estado === 'meta_nao_definida'
    ? 'Meta não definida (defina em Mais)'
    : `Meta: ${formatarMoeda(reserva.meta)} · ${reserva.percentual.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;

  // Estados visuais do card de saldo
  const estadoCritico = entradas > 0 && saldo <= entradas * 0.15;
  const semFaturaProxima = !naoPagas.some((f) => f.diasRestantes !== null && f.diasRestantes <= 3);
  const reservaOk = reserva.estado === 'meta_nao_definida' || reserva.percentual >= 50;
  const estadoCalmo = !estadoCritico && semFaturaProxima && saldo > 0 && reservaOk;
  const balanceCard = document.getElementById('balanceCard');
  balanceCard.classList.toggle('estado-critico', estadoCritico);
  balanceCard.classList.toggle('estado-calmo', estadoCalmo);
  document.getElementById('calmBanner').innerHTML = estadoCalmo ? '<div class="calm-banner">Tudo sob controle por aqui! 🌟</div>' : '';

  aplicarVisibilidade();
}

async function editarRendaHome() {
  const mesAtual = DB.mesAtualISO();
  const atual = await DB.rendaAtual(mesAtual);
  const novaRenda = prompt('Qual é a sua renda mensal fixa? (R$) Vale a partir deste mês.', String(atual).replace('.', ','));
  if (novaRenda === null) return;
  const valor = parseFloat(novaRenda.replace(/\./g, '').replace(',', '.'));
  if (isNaN(valor) || valor < 0) { alert('Valor inválido.'); return; }
  await DB.definirRenda(valor, mesAtual);
  await renderHome();
}

function saudacao() {
  const h = Datas.agora().getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function capitalizar(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- Foto de perfil (100% local) ----------

function carregarFotoPerfil() {
  const salva = localStorage.getItem('ffjoyce2026_foto_perfil');
  const container = document.getElementById('profilePhoto');
  container.innerHTML = salva && /^data:image\//.test(salva) ? `<img src="${salva}" alt="Foto de perfil">` : '<span>👤</span>';
}

function processarNovaFotoPerfil(arquivo) {
  const leitor = new FileReader();
  leitor.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const tamanho = 200;
      const canvas = document.createElement('canvas');
      canvas.width = tamanho;
      canvas.height = tamanho;
      const ctx = canvas.getContext('2d');
      const escala = Math.max(tamanho / img.width, tamanho / img.height);
      const w = img.width * escala;
      const h = img.height * escala;
      ctx.drawImage(img, (tamanho - w) / 2, (tamanho - h) / 2, w, h);
      localStorage.setItem('ffjoyce2026_foto_perfil', canvas.toDataURL('image/jpeg', 0.85));
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

function atualizarRelogio() {
  const agora = Datas.agora();
  const dataCompleta = capitalizar(agora.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }));
  const horaAtual = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const label = document.getElementById('monthLabel');
  if (label) label.textContent = `${dataCompleta} · ${horaAtual}`;
}

setInterval(atualizarRelogio, 30000);

// ---------- Modal de cadastro ----------

async function abrirModal() {
  categoriaSelecionadaId = null;
  categoriaSugeridaId = null;
  cartaoSelecionadoId = null;
  formaPagamentoSelecionada = 'cartao';
  const hoje = Datas.hojeISO();
  document.getElementById('inputDataDespesa').value = hoje;
  document.getElementById('inputDataReceita').value = hoje;
  document.getElementById('inputValor').value = '';
  document.getElementById('inputDescricaoDespesa').value = '';
  document.getElementById('inputDescricaoReceita').value = '';
  document.getElementById('sugestaoCategoria').style.display = 'none';
  document.getElementById('alertaCartao').style.display = 'none';
  alternarTipo('despesa');
  aplicarMascaraMoeda(document.getElementById('inputValor'));

  document.querySelectorAll('#formaPagamentoChips .chip').forEach((c) => c.classList.toggle('selected', c.dataset.forma === 'cartao'));
  document.getElementById('blocoCartaoEscolha').style.display = 'block';

  const categorias = await DB.listarCategoriasAtivas();
  document.getElementById('categoriaChips').innerHTML = categorias.map((c) => `
    <div class="chip" data-id="${c.id}" onclick="selecionarCategoria(${c.id})">${UI.escapar(c.icone)} ${UI.escapar(c.nome)}</div>`).join('');

  const cartoes = await DB.listarCartoesAtivos();
  document.getElementById('cartaoChips').innerHTML = cartoes.length === 0
    ? '<div class="inline-note">Nenhum cartão cadastrado. Cadastre em Mais → Cartões.</div>'
    : cartoes.map((c) => `<div class="chip" data-id="${c.id}" onclick="selecionarCartao(${c.id})">💳 ${UI.escapar(c.nome)}</div>`).join('');

  document.getElementById('sheetOverlay').classList.add('open');
  setTimeout(() => document.getElementById('inputValor').focus(), 150);
}

function fecharModal() { document.getElementById('sheetOverlay').classList.remove('open'); }
function fecharModalSeClicarFora(event) { if (event.target.id === 'sheetOverlay') fecharModal(); }

function selecionarFormaPagamento(forma) {
  formaPagamentoSelecionada = forma;
  document.querySelectorAll('#formaPagamentoChips .chip').forEach((c) => c.classList.toggle('selected', c.dataset.forma === forma));
  const mostraCartao = forma === 'cartao';
  document.getElementById('blocoCartaoEscolha').style.display = mostraCartao ? 'block' : 'none';
  if (!mostraCartao) {
    cartaoSelecionadoId = null;
    document.querySelectorAll('#cartaoChips .chip').forEach((c) => c.classList.remove('selected'));
    document.getElementById('alertaCartao').style.display = 'none';
  }
}

function destacarCategoria() {
  const alvo = categoriaSelecionadaId || categoriaSugeridaId;
  document.querySelectorAll('#categoriaChips .chip').forEach((c) => c.classList.toggle('selected', Number(c.dataset.id) === alvo));
}

function selecionarCategoria(id) {
  categoriaSelecionadaId = id; // escolha manual: nunca é trocada pela sugestão
  destacarCategoria();
}

// Sugestão automática pela descrição (só enquanto a pessoa não escolheu)
async function atualizarSugestaoCategoria() {
  const descricao = document.getElementById('inputDescricaoDespesa').value;
  const nota = document.getElementById('sugestaoCategoria');
  if (!descricao.trim()) { categoriaSugeridaId = null; nota.style.display = 'none'; destacarCategoria(); return; }
  const s = await DB.sugerirCategoria(descricao);
  categoriaSugeridaId = s.nome === 'Outros' ? null : s.categoriaId;
  if (categoriaSugeridaId && !categoriaSelecionadaId) {
    nota.textContent = `Sugestão: ${s.nome}. Toque em outra categoria se preferir.`;
    nota.style.display = 'block';
  } else {
    nota.style.display = 'none';
  }
  destacarCategoria();
}

document.getElementById('inputDescricaoDespesa').addEventListener('input', atualizarSugestaoCategoria);

async function selecionarCartao(id) {
  cartaoSelecionadoId = cartaoSelecionadoId === id ? null : id;
  document.querySelectorAll('#cartaoChips .chip').forEach((c) => c.classList.toggle('selected', Number(c.dataset.id) === cartaoSelecionadoId));
  const alertaBox = document.getElementById('alertaCartao');
  if (!cartaoSelecionadoId) { alertaBox.style.display = 'none'; return; }
  // regra do projeto: parcelas do PRÓXIMO mês × renda do próximo mês (30%)
  const mesSeguinte = DB.somarMesISO(DB.mesAtualISO(), 1);
  const avaliacao = Analises.avaliarComprometimentoCartao(await DB.parcelasProximoMes(), await DB.rendaAtual(mesSeguinte));
  alertaBox.style.display = 'block';
  alertaBox.textContent = avaliacao.texto;
  alertaBox.style.color = avaliacao.bloquear ? 'var(--red)' : 'var(--ink-soft)';
}

async function salvarDespesa() {
  const valor = valorNumericoDoInput(document.getElementById('inputValor'));
  if (!valor || valor <= 0) { document.getElementById('inputValor').focus(); return; }

  try {
    if (tipoLancamento === 'receita') {
      await DB.adicionarReceita({
        valor,
        data: document.getElementById('inputDataReceita').value || Datas.hojeISO(),
        descricao: document.getElementById('inputDescricaoReceita').value
      });
    } else if (tipoLancamento === 'reserva') {
      await DB.adicionarAporte(valor);
    } else {
      if (formaPagamentoSelecionada === 'cartao' && !cartaoSelecionadoId) {
        alert('Escolha qual cartão foi usado (ou troque a forma de pagamento).');
        return;
      }
      const descricao = document.getElementById('inputDescricaoDespesa').value;
      if (!categoriaSelecionadaId && !categoriaSugeridaId && !descricao.trim()) {
        alert('Escolha uma categoria ou escreva uma descrição.');
        return;
      }
      await DB.adicionarDespesaManual({
        valor,
        // null = categorização automática pela descrição (não conta como manual)
        categoriaId: categoriaSelecionadaId || null,
        cartaoId: formaPagamentoSelecionada === 'cartao' ? cartaoSelecionadoId : null,
        formaPagamento: formaPagamentoSelecionada,
        data: document.getElementById('inputDataDespesa').value || Datas.hojeISO(),
        descricao
      });
    }
  } catch (erro) {
    alert(erro.message || 'Não foi possível salvar.');
    return;
  }
  fecharModal();
  await renderHome();
}

// ---------- Bootstrap ----------

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  await renderHome();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
})();
