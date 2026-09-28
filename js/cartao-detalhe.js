// cartao-detalhe.js — Cartões → cartão → Faturas: fatura em destaque,
// limite, lista de faturas (com os lançamentos de cada uma, pela
// competência) e o fluxo de importação (CSV, PDF, OCR) com prévia completa
// antes de gravar.

const CORES_CARTAO_FIXAS = { 'Nubank': '#820AD1', 'Inter': '#FF7A00', 'Itaú': '#EC7000', 'Santander': '#EC0000', 'C6': '#242424', 'Bradesco': '#CC092F', 'Banco do Brasil': '#C9A800' };

function corParaCartao(nome) {
  if (CORES_CARTAO_FIXAS[nome]) return CORES_CARTAO_FIXAS[nome];
  let hash = 0;
  for (let i = 0; i < nome.length; i++) hash = nome.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 40%)`;
}

function formatarMoeda(valor) { return UI.moeda(valor); }
const esc = (t) => UI.escapar(t);

function getIdDaUrl() {
  return parseInt(new URLSearchParams(window.location.search).get('id'), 10);
}

let limiteCartaoAtual = 0;
let faturaDestaqueAtualId = null;
let faturasAbertas = new Set(); // faturas expandidas na lista

function rotuloOrigem(f) {
  if (f.origem === 'importada') return 'importada';
  if (f.origem === 'aberta') return 'em aberto (lançamentos manuais)';
  return f.datasConfirmadas ? 'reconstruída · datas confirmadas' : 'reconstruída · dados estimados, confira';
}

async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();

  const id = getIdDaUrl();
  const cartao = id ? await DB.obterPorId('cartao', id) : null;
  if (!cartao) { document.getElementById('bankName').textContent = 'Cartão não encontrado'; return; }

  document.getElementById('bankLogo').style.background = corParaCartao(cartao.nome);
  document.getElementById('bankLogo').textContent = cartao.nome.slice(0, 2).toUpperCase();
  document.getElementById('bankName').textContent = cartao.nome + (cartao.arquivado ? ' (arquivado)' : '');

  const fatura = await DB.faturaEmDestaquePorCartao(id);
  faturaDestaqueAtualId = fatura ? fatura.id : null;
  const acaoFaturaPaga = document.getElementById('acaoFaturaPaga');

  if (fatura && fatura.fechamentoDia) {
    document.getElementById('bankSub').textContent = `Fatura ${Datas.rotuloMes(fatura.mesFatura)} · fecha ${Datas.formatarDia(fatura.fechamentoDia, { day: '2-digit', month: '2-digit' })} · vence ${Datas.formatarDia(fatura.vencimentoDia, { day: '2-digit', month: '2-digit' })}`;
  } else {
    document.getElementById('bankSub').textContent = cartao.diaFechamento
      ? `Fecha dia ${cartao.diaFechamento} · vence dia ${cartao.diaVencimento}`
      : `Vence dia ${cartao.diaVencimento} · cadastre o dia de fechamento (✏️)`;
  }

  limiteCartaoAtual = cartao.limite;
  if (!fatura) {
    document.getElementById('dueChip').textContent = '📅 Nenhuma fatura ainda';
    document.getElementById('valorFatura').textContent = formatarMoeda(0);
    acaoFaturaPaga.innerHTML = '';
  } else {
    const situacaoTexto = fatura.situacao === 'quitada' ? 'Paga' : fatura.situacao === 'vencida' ? 'Vencida, não paga' : 'Não paga';
    document.getElementById('dueChip').textContent = `📅 Vence em ${Datas.formatarDia(fatura.vencimentoDia, { day: '2-digit', month: 'long' })} · ${situacaoTexto}${fatura.origem === 'importada' ? '' : ' · ' + rotuloOrigem(fatura)}`;
    document.getElementById('valorFatura').textContent = formatarMoeda(fatura.totalOficial);
    const botaoPagamento = fatura.statusPagamento === 'paga'
      ? `<button type="button" class="acao-fatura-paga-btn desmarcar" onclick="alternarFaturaPaga(${fatura.id})">↩️ Desmarcar como paga</button>`
      : `<button type="button" class="acao-fatura-paga-btn" onclick="alternarFaturaPaga(${fatura.id})">✅ Marcar como paga</button>`;
    acaoFaturaPaga.innerHTML = botaoPagamento + `<button type="button" class="acao-fatura-paga-btn corrigir" onclick="corrigirDatasFatura(${fatura.id})">✏️ Corrigir fechamento/vencimento</button>`;
    faturasAbertas.add(fatura.id);
  }

  const valorFatura = fatura ? fatura.totalOficial : 0;
  const percentual = cartao.limite > 0 ? (valorFatura / cartao.limite) * 100 : 0;
  const status = Motor.statusLimite(percentual);
  const corBarra = status === 'ok' ? 'var(--green)' : status === 'warn' ? 'var(--amber)' : 'var(--red)';
  const emAviso = percentual >= 80;
  document.getElementById('bankLogo').classList.toggle('estado-aviso', emAviso);
  document.getElementById('valorFatura').classList.toggle('estado-aviso', emAviso);
  document.getElementById('limitPct').textContent = `${percentual.toFixed(0)}%`;
  document.getElementById('limitPct').className = `limit-pct ${status}`;
  document.getElementById('limitFill').style.width = `${Math.min(percentual, 100).toFixed(0)}%`;
  document.getElementById('limitFill').style.background = corBarra;
  const faixa = status === 'danger' ? 'alerta, você passou do limite seguro' : status === 'warn' ? 'atenção, você está perto do limite seguro' : 'dentro do limite seguro';
  document.getElementById('limitNote').textContent = `${formatarMoeda(valorFatura)} usados de ${formatarMoeda(cartao.limite)} · ${faixa}.`;

  await renderFaturasELancamentos(id);
}

// Lista de faturas do cartão (mais recente primeiro) com os lançamentos de
// cada uma; previstas (sem fatura ainda) num grupo próprio.
async function renderFaturasELancamentos(cartaoId) {
  const [faturas, detalhadas] = await Promise.all([DB.faturasClassificadas(), DB.despesasDetalhadas()]);
  const doCartao = faturas.filter((f) => f.cartaoId === cartaoId).sort((a, b) => b.mesFatura.localeCompare(a.mesFatura));
  const despesasDoCartao = detalhadas.filter((d) => d.cartaoId === cartaoId || doCartao.some((f) => f.id === d.faturaId));
  const porFatura = new Map(doCartao.map((f) => [f.id, []]));
  const previstas = [];
  const semFatura = [];
  for (const d of despesasDoCartao) {
    if (d.faturaId != null && porFatura.has(d.faturaId)) porFatura.get(d.faturaId).push(d);
    else if (d.statusDespesa === 'previsto') previstas.push(d);
    else semFatura.push(d);
  }

  const ordenar = (lista) => lista.sort((a, b) => (b.dia || '').localeCompare(a.dia || '') || (b.parcelaAtual || 0) - (a.parcelaAtual || 0));
  const linha = (c) => `
    <div class="purchase-card">
      <button type="button" class="txn-more" title="Ações" onclick="abrirAcoesCompra(${c.id})">⋯</button>
      <div class="p-icon">${esc(c.categoriaIcone)}</div>
      <div class="p-info">
        <div class="p-name">${esc(c.descricao || c.categoriaNome)}${c.statusDespesa === 'previsto' ? ' <span class="tag-previsto">Previsto</span>' : ''}${c.pendenteReconciliacao ? ' <span class="tag-revisao">Revisar parcela</span>' : ''}</div>
        <div class="p-date">${Datas.formatarDia(c.dia)} · ${esc(c.categoriaNome)}${c.parcelaTotal > 1 ? ` · parcela ${c.parcelaAtual}/${c.parcelaTotal}` : ''}${c.statusDespesa === 'previsto' ? ` · prevista para ${Datas.rotuloMes(c.mesCompetencia)}` : ''}</div>
      </div>
      <div class="p-value"${c.statusDespesa === 'previsto' ? ' style="opacity:.6"' : ''}>${formatarMoeda(c.valorParcela)}</div>
    </div>`;

  const blocos = [];
  for (const f of doCartao) {
    const itens = ordenar(porFatura.get(f.id));
    const aberta = faturasAbertas.has(f.id);
    const status = f.situacao === 'quitada' ? '✅ Paga' : f.situacao === 'vencida' ? '🔴 Vencida' : 'Não paga';
    blocos.push(`
      <div class="fatura-bloco" style="margin-bottom:12px">
        <div class="purchase-card" style="cursor:pointer;background:var(--card)" onclick="alternarFatura(${f.id})">
          <div class="p-icon">${aberta ? '▾' : '▸'}</div>
          <div class="p-info">
            <div class="p-name">Fatura ${Datas.rotuloMes(f.mesFatura)}</div>
            <div class="p-date">${status} · vence ${Datas.formatarDia(f.vencimentoDia)} · ${itens.length} lançamento(s) · ${esc(rotuloOrigem(f))}</div>
          </div>
          <div class="p-value">${formatarMoeda(f.totalOficial)}</div>
        </div>
        ${f.divergencia ? `<div class="aviso-divergencia">⚠️ Os lançamentos somam ${formatarMoeda(f.divergencia.somaItens)}, acima do total oficial de ${formatarMoeda(f.divergencia.totalOficial)} (${formatarMoeda(f.divergencia.excesso)} a mais). Nenhum ajuste negativo foi criado: revise os itens.</div>` : ''}
        ${aberta ? (itens.length === 0 ? '<div style="font-size:12px;color:var(--ink-soft);padding:6px 4px">Sem lançamentos.</div>' : itens.map(linha).join('')) : ''}
      </div>`);
  }
  if (previstas.length > 0) {
    blocos.push(`<div class="section-head-title" style="font-size:13px;font-weight:700;margin:16px 0 8px">Parcelas previstas (ainda sem fatura)</div>${ordenar(previstas).reverse().map(linha).join('')}`);
  }
  if (semFatura.length > 0) {
    blocos.push(`<div class="section-head-title" style="font-size:13px;font-weight:700;margin:16px 0 8px">Sem fatura vinculada</div>${ordenar(semFatura).map(linha).join('')}`);
  }
  document.getElementById('listaCompras').innerHTML = blocos.length === 0
    ? '<div style="text-align:center;padding:30px 0;color:var(--ink-soft);font-size:13px">Nenhuma fatura ou compra neste cartão ainda.</div>'
    : blocos.join('');
}

function alternarFatura(id) {
  if (faturasAbertas.has(id)) faturasAbertas.delete(id); else faturasAbertas.add(id);
  renderFaturasELancamentos(getIdDaUrl());
}

iniciar();

async function alternarFaturaPaga(faturaId) {
  const fatura = await DB.obterPorId('fatura', faturaId);
  if (!fatura) return;
  if (fatura.statusPagamento === 'paga') await DB.desmarcarFaturaComoPaga(faturaId);
  else await DB.marcarFaturaComoPaga(faturaId);
  await iniciar();
}

async function corrigirDatasFatura(faturaId) {
  const fatura = await DB.obterPorId('fatura', faturaId);
  if (!fatura) return;
  const fechAtual = Datas.formatarDia(fatura.fechamento);
  const vencAtual = Datas.formatarDia(fatura.vencimento);
  const f = prompt('Data REAL de fechamento desta fatura (confira na fatura do banco), DD/MM/AAAA:', fechAtual === '—' ? '' : fechAtual);
  if (f === null) return;
  const fechamento = Datas.interpretarDiaDigitado(f);
  if (!fechamento) { alert('Data de fechamento inválida. Use DD/MM/AAAA.'); return; }
  const v = prompt('Data REAL de vencimento desta fatura, DD/MM/AAAA:', vencAtual === '—' ? '' : vencAtual);
  if (v === null) return;
  const vencimento = Datas.interpretarDiaDigitado(v);
  if (!vencimento) { alert('Data de vencimento inválida. Use DD/MM/AAAA.'); return; }
  await DB.corrigirDatasFatura(faturaId, { fechamento, vencimento });
  await iniciar();
}

// ---------- Importação de fatura (CSV, PDF, foto) com prévia ----------

let importacao = null; // { itens, totalDetectado, origemArquivo, mesFatura, fechamento, vencimento, editouDatas }

document.getElementById('inputFatura').addEventListener('change', async (e) => {
  const arquivo = e.target.files[0];
  e.target.value = '';
  if (!arquivo) return;
  const cartao = await DB.obterPorId('cartao', getIdDaUrl());
  if (!cartao) return;
  if (!cartao.diaFechamento) {
    alert('Antes de importar, edite o cartão (✏️) e informe o dia de fechamento real da fatura.');
    return;
  }
  const tipo = LerDocumento.detectarTipoArquivo(arquivo);
  if (tipo === 'csv') {
    const resultado = ImportarFatura.parseFaturaCsv(await arquivo.text());
    await iniciarPrevia(resultado.validos, null, 'CSV', resultado.erros.length);
  } else if (tipo === 'pdf' || tipo === 'imagem') {
    await processarComOcr(arquivo, tipo);
  } else {
    alert('Não reconheci esse tipo de arquivo. Envie um CSV, um PDF ou uma foto.');
  }
});

async function processarComOcr(arquivo, tipo) {
  const progresso = document.getElementById('progressoOcr');
  progresso.style.display = 'block';
  progresso.innerHTML = `
    <div class="ocr-progresso">
      <div class="ocr-progresso-texto" id="ocrTexto">${tipo === 'pdf' ? 'Abrindo o PDF...' : 'Lendo a imagem...'}</div>
      <div class="ocr-progresso-track"><div class="ocr-progresso-fill" id="ocrBarra" style="width:0%"></div></div>
    </div>`;
  try {
    const texto = await LerDocumento.extrairTextoDoDocumento(arquivo, (mensagem, pct) => {
      const barra = document.getElementById('ocrBarra');
      const label = document.getElementById('ocrTexto');
      if (barra) barra.style.width = Math.round(pct) + '%';
      if (label) label.textContent = mensagem;
    });
    const parse = OcrFatura.parseTextoOCR(texto);
    progresso.style.display = 'none';
    progresso.innerHTML = '';
    await iniciarPrevia(parse.validos, OcrFatura.extrairValorTotal(texto), tipo === 'pdf' ? 'PDF' : 'foto (OCR)', parse.ignoradas.length);
  } catch (err) {
    const padrao = tipo === 'pdf' ? 'Não consegui ler esse PDF.' : 'Não consegui ler essa imagem. Tente uma foto mais nítida, com boa luz.';
    progresso.innerHTML = `<div style="text-align:center;padding:14px;color:var(--red);font-size:12.5px">${esc((err && err.message) || padrao)}</div>`;
  }
}

// Mês sugerido: o mês de fatura mais frequente entre os itens, calculado pelo
// dia de fechamento do cartão (compra até o fechamento → fatura do mês
// anterior ao fechamento). É só a sugestão inicial; a pessoa confirma.
function sugerirMesFatura(itens, cartao) {
  if (itens.length === 0) return DB.mesAnteriorISO();
  const contagem = new Map();
  for (const item of itens) {
    const mes = DB.mesFaturaParaCompra(cartao, item.data) || Datas.mesFinanceiro(item.data);
    contagem.set(mes, (contagem.get(mes) || 0) + 1);
  }
  return [...contagem.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

async function iniciarPrevia(itensLidos, totalDetectado, origemArquivo, linhasIgnoradas) {
  const cartao = await DB.obterPorId('cartao', getIdDaUrl());
  const idsPorNome = {};
  for (const c of await DB.listarCategoriasAtivas()) idsPorNome[c.nome] = c.id;
  const itens = [];
  for (const item of itensLidos) {
    const sugestao = await DB.sugerirCategoria(item.descricao);
    const parcela = ImportarFatura.extrairParcela(item.descricao);
    itens.push({ ...item, data: Datas.diaFinanceiro(item.data), categoriaId: sugestao.categoriaId, categoriaManual: false, parcela });
  }
  const mesFatura = sugerirMesFatura(itens, cartao);
  const datas = DB.datasEstimadasDaFatura(cartao, mesFatura);
  const soma = itens.reduce((s, i) => s + Math.round(i.valor * 100), 0) / 100;
  importacao = {
    itens, origemArquivo, linhasIgnoradas, cartao, mesFatura,
    fechamento: datas.fechamento, vencimento: datas.vencimento, editouDatas: false,
    totalOficial: totalDetectado !== null && totalDetectado !== undefined ? totalDetectado : soma,
    totalDetectado
  };
  await renderPrevia();
}

async function renderPrevia() {
  const box = document.getElementById('previewImportacao');
  if (!importacao) { box.innerHTML = ''; return; }
  const { itens, cartao } = importacao;
  const categorias = await DB.listarCategoriasAtivas();
  const previa = await DB.previaImportacaoFatura(
    { cartaoId: cartao.id, mesFatura: importacao.mesFatura, totalOficial: importacao.totalOficial },
    itens
  );

  const avisos = [];
  if (importacao.linhasIgnoradas > 0) avisos.push(`<div class="import-preview-sub erro">${importacao.linhasIgnoradas} linha(s) do arquivo não foram reconhecidas. Confira se não falta nada.</div>`);
  if (previa.reimportacao) avisos.push(`<div class="import-preview-sub" style="color:var(--blue);font-weight:600">Já existe fatura deste cartão em ${Datas.rotuloMes(importacao.mesFatura)}: é uma REIMPORTAÇÃO. ${previa.jaExistentes} item(ns) já gravado(s) serão ignorados; o status de pagamento não muda.</div>`);
  if (previa.ajusteOcr > 0) avisos.push(`<div class="import-preview-sub" style="color:var(--blue);font-weight:600">Diferença de ${formatarMoeda(previa.ajusteOcr)} entre o total oficial e os itens: vira um único lançamento "Outros Gastos da Fatura (Ajuste OCR)".</div>`);
  if (previa.somaAcimaDoTotal > 0) avisos.push(`<div class="aviso-divergencia">⚠️ A soma dos itens passa o total oficial em ${formatarMoeda(previa.somaAcimaDoTotal)}. Nenhum ajuste negativo será criado. Revise os itens ou o total antes de confirmar.</div>`);

  box.innerHTML = `
    <div class="import-preview">
      <div class="import-preview-title">Prévia da importação (${esc(importacao.origemArquivo)}) · nada foi gravado ainda</div>
      <div class="field-label">Cartão</div>
      <div class="text-input" style="background:#fff">${esc(cartao.nome)}</div>
      <div class="field-label">Mês da fatura (competência)</div>
      <input type="month" class="text-input" id="impMes" value="${importacao.mesFatura}" onchange="alterarCampoPrevia('mes', this.value)">
      <div class="field-label">Fechamento</div>
      <input type="date" class="text-input" id="impFechamento" value="${importacao.fechamento}" onchange="alterarCampoPrevia('fechamento', this.value)">
      <div class="field-label">Vencimento</div>
      <input type="date" class="text-input" id="impVencimento" value="${importacao.vencimento}" onchange="alterarCampoPrevia('vencimento', this.value)">
      <div class="field-label">Total oficial da fatura${importacao.totalDetectado !== null && importacao.totalDetectado !== undefined ? ' (lido do arquivo, confira)' : ' (confira no boleto/fatura)'}</div>
      <input type="text" inputmode="numeric" class="text-input" id="impTotal" onchange="alterarCampoPrevia('total', this.value)">
      <div class="import-preview-sub" style="margin-top:10px">
        <strong>${previa.quantidadeItens}</strong> item(ns) · soma ${formatarMoeda(previa.somaItens)} · total oficial ${formatarMoeda(previa.totalOficial)}
      </div>
      ${avisos.join('')}
      <div class="import-item-list">
        ${itens.map((item, i) => `
          <div class="import-item" style="flex-direction:column;gap:6px">
            <div style="display:flex;justify-content:space-between;gap:8px">
              <div>
                <div class="import-item-desc">${esc(item.descricao)}</div>
                <div class="import-item-date">${Datas.formatarDia(item.data)}${item.parcela ? ` · parcela ${item.parcela.parcelaAtual}/${item.parcela.parcelaTotal}` : ''}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <div class="import-item-value">${formatarMoeda(item.valor)}</div>
                <button onclick="removerItemPrevia(${i})" aria-label="Remover item" style="background:none;border:none;color:var(--red);font-size:14px">✕</button>
              </div>
            </div>
            <select class="text-input" style="padding:6px 8px;font-size:12px" onchange="alterarCategoriaItem(${i}, this.value)">
              ${categorias.map((c) => `<option value="${c.id}" ${c.id === item.categoriaId ? 'selected' : ''}>${esc(c.icone)} ${esc(c.nome)}</option>`).join('')}
            </select>
          </div>`).join('')}
      </div>
      <div class="import-actions">
        <button class="import-cancel" onclick="cancelarImportacao()">Cancelar</button>
        <button class="import-confirm" onclick="confirmarImportacao()">Confirmar e gravar</button>
      </div>
    </div>`;
  const campoTotal = document.getElementById('impTotal');
  aplicarMascaraMoeda(campoTotal);
  definirValorMascarado(campoTotal, importacao.totalOficial);
}

async function alterarCampoPrevia(campo, valor) {
  if (!importacao) return;
  if (campo === 'mes' && Datas.ehMesISO(valor)) {
    importacao.mesFatura = valor;
    if (!importacao.editouDatas) {
      const d = DB.datasEstimadasDaFatura(importacao.cartao, valor);
      importacao.fechamento = d.fechamento;
      importacao.vencimento = d.vencimento;
    }
  } else if (campo === 'fechamento' && Datas.ehDiaISO(valor)) {
    importacao.fechamento = valor; importacao.editouDatas = true;
  } else if (campo === 'vencimento' && Datas.ehDiaISO(valor)) {
    importacao.vencimento = valor; importacao.editouDatas = true;
  } else if (campo === 'total') {
    const v = valorNumericoDoInput(document.getElementById('impTotal'));
    if (!isNaN(v)) importacao.totalOficial = v;
  }
  await renderPrevia();
}

function alterarCategoriaItem(indice, valor) {
  importacao.itens[indice].categoriaId = Number(valor);
  importacao.itens[indice].categoriaManual = true; // escolha da pessoa vence a automática
}

async function removerItemPrevia(indice) {
  importacao.itens.splice(indice, 1);
  await renderPrevia();
}

function cancelarImportacao() {
  importacao = null;
  document.getElementById('previewImportacao').innerHTML = '';
}

async function confirmarImportacao() {
  if (!importacao) return;
  const v = valorNumericoDoInput(document.getElementById('impTotal'));
  if (!isNaN(v)) importacao.totalOficial = v;
  const { cartao, mesFatura, fechamento, vencimento, totalOficial, itens } = importacao;
  if (!Datas.ehMesISO(mesFatura)) { alert('Informe o mês da fatura.'); return; }
  if (!Datas.ehDiaISO(fechamento) || !Datas.ehDiaISO(vencimento)) { alert('Informe fechamento e vencimento.'); return; }
  if (!(totalOficial >= 0)) { alert('Informe o total oficial da fatura.'); return; }
  if (itens.length === 0 && totalOficial === 0) { alert('Nada para importar.'); return; }

  let r;
  try {
    r = await DB.importarFatura(
      { cartaoId: cartao.id, mesFatura, fechamento, vencimento, totalOficial },
      itens.map((i) => ({
        data: i.data, descricao: i.descricao, valor: i.valor,
        categoriaId: i.categoriaManual ? i.categoriaId : null, categoriaManual: i.categoriaManual,
        parcelaAtual: i.parcela ? i.parcela.parcelaAtual : undefined, parcelaTotal: i.parcela ? i.parcela.parcelaTotal : undefined
      }))
    );
  } catch (erro) {
    alert(`Nada foi gravado: ${erro.message}`);
    return;
  }

  const linhas = [`Fatura ${Datas.rotuloMes(mesFatura)} ${r.criada ? 'criada' : 'atualizada (reimportação)'}.`];
  if (r.inseridos.length) linhas.push(`${r.inseridos.length} lançamento(s) novo(s).`);
  if (r.reconciliados.length) linhas.push(`${r.reconciliados.length} lançamento(s) ligado(s) a previsões ou lançamentos manuais (sem duplicar).`);
  if (r.ignoradosJaExistentes) linhas.push(`${r.ignoradosJaExistentes} já existiam e foram ignorados.`);
  if (r.ajuste.acao === 'criado' || r.ajuste.acao === 'atualizado') linhas.push(`Ajuste OCR: ${formatarMoeda(r.ajuste.valor)}.`);
  if (r.ajuste.acao === 'removido') linhas.push('Ajuste OCR não é mais necessário e foi retirado.');
  if (r.divergencia) linhas.push(`Atenção: itens somam ${formatarMoeda(r.divergencia.somaItens)}, acima do total oficial. Revise.`);
  if (r.revisaoNecessaria.length) linhas.push(`${r.revisaoNecessaria.length} parcela(s) não puderam ser ligadas com segurança a um parcelamento: marcadas para revisão.`);
  alert(linhas.join('\n'));

  importacao = null;
  document.getElementById('previewImportacao').innerHTML = '';
  faturasAbertas.add(r.faturaId);
  await iniciar();
}

// ---------- Edição e exclusão do cartão ----------

async function abrirModalEdicao() {
  const cartao = await DB.obterPorId('cartao', getIdDaUrl());
  if (!cartao) return;
  document.getElementById('inputNomeCartao').value = cartao.nome;
  aplicarMascaraMoeda(document.getElementById('inputLimiteCartao'));
  definirValorMascarado(document.getElementById('inputLimiteCartao'), cartao.limite);
  document.getElementById('inputVencimentoCartao').value = cartao.diaVencimento;
  document.getElementById('inputFechamentoCartao').value = cartao.diaFechamento || '';
  document.getElementById('sheetOverlay').classList.add('open');
}

function fecharModal() { document.getElementById('sheetOverlay').classList.remove('open'); }
function fecharModalSeClicarFora(event) { if (event.target.id === 'sheetOverlay') fecharModal(); }

async function salvarEdicaoCartao() {
  const cartao = await DB.obterPorId('cartao', getIdDaUrl());
  if (!cartao) return;
  const nome = document.getElementById('inputNomeCartao').value.trim();
  const limite = valorNumericoDoInput(document.getElementById('inputLimiteCartao'));
  const diaVencimento = parseInt(document.getElementById('inputVencimentoCartao').value, 10);
  const diaFechamento = parseInt(document.getElementById('inputFechamentoCartao').value, 10);
  if (!nome) { alert('Informe o nome do banco.'); return; }
  if (!limite || limite <= 0) { alert('Informe um limite válido.'); return; }
  if (!diaVencimento || diaVencimento < 1 || diaVencimento > 31) { alert('Informe um dia de vencimento válido (1 a 31).'); return; }
  if (!diaFechamento || diaFechamento < 1 || diaFechamento > 31) { alert('Informe o dia de fechamento real da fatura (1 a 31).'); return; }
  // muda só a regra para lançamentos FUTUROS; faturas já existentes guardam
  // o próprio fechamento/vencimento e não são alteradas
  await DB.atualizar('cartao', { ...cartao, nome, limite, diaFechamento, diaVencimento });
  fecharModal();
  await iniciar();
}

// ---------- Editar / excluir um lançamento ----------

let compraEmEdicaoId = null;

async function abrirAcoesCompra(id) {
  compraEmEdicaoId = id;
  const registro = await DB.obterPorId('despesa', id);
  if (!registro) return;
  aplicarMascaraMoeda(document.getElementById('compraValor'));
  definirValorMascarado(document.getElementById('compraValor'), registro.valor);
  document.getElementById('compraDescricao').value = registro.descricao || '';
  document.getElementById('compraData').value = Datas.diaFinanceiro(registro.data) || '';
  const categorias = await DB.listarCategoriasAtivas();
  const chips = document.getElementById('compraCategoriaChips');
  chips.innerHTML = categorias.map((c) => `
    <div class="chip ${c.id === registro.categoriaId ? 'selected' : ''}" data-id="${c.id}" onclick="selecionarCategoriaCompra(${c.id})">${esc(c.icone)} ${esc(c.nome)}</div>`).join('');
  chips.dataset.selecionado = registro.categoriaId;
  document.getElementById('sheetOverlayCompra').classList.add('open');
}

function selecionarCategoriaCompra(id) {
  const container = document.getElementById('compraCategoriaChips');
  container.dataset.selecionado = id;
  container.querySelectorAll('.chip').forEach((c) => c.classList.toggle('selected', Number(c.dataset.id) === id));
}

function fecharModalCompra() {
  document.getElementById('sheetOverlayCompra').classList.remove('open');
  compraEmEdicaoId = null;
}
function fecharModalCompraSeClicarFora(event) { if (event.target.id === 'sheetOverlayCompra') fecharModalCompra(); }

async function salvarEdicaoCompra() {
  if (!compraEmEdicaoId) return;
  const valor = valorNumericoDoInput(document.getElementById('compraValor'));
  if (!valor || valor <= 0) { alert('Valor inválido.'); return; }
  const categoriaId = Number(document.getElementById('compraCategoriaChips').dataset.selecionado);
  if (!categoriaId) { alert('Escolha uma categoria.'); return; }
  const data = Datas.interpretarDiaDigitado(document.getElementById('compraData').value);
  if (!data) { alert('Data inválida.'); return; }
  try {
    await DB.atualizarDespesaManual(compraEmEdicaoId, { valor, categoriaId, descricao: document.getElementById('compraDescricao').value.trim(), data });
  } catch (erro) { alert(erro.message); return; }
  fecharModalCompra();
  await iniciar();
}

async function excluirCompra() {
  if (!compraEmEdicaoId) return;
  if (!confirm('Excluir este lançamento? Essa ação não pode ser desfeita.')) return;
  await DB.excluirDespesa(compraEmEdicaoId);
  fecharModalCompra();
  await iniciar();
}

async function excluirCartao() {
  const id = getIdDaUrl();
  if (!confirm('Excluir este cartão? Ele sai das listas, mas faturas e compras já registradas continuam no histórico, nos meses corretos.')) return;
  await DB.arquivarCartao(id);
  location.href = 'cartoes.html';
}
