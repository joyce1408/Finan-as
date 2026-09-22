// cartao-detalhe.js — carrega o cartão pelo ?id= da URL e mostra fatura,
// limite e compras reais daquele cartão no mês atual.

const CORES_CARTAO_FIXAS = { 'Nubank': '#820AD1', 'Inter': '#FF7A00', 'Itaú': '#EC7000', 'Santander': '#EC0000', 'C6': '#242424', 'Bradesco': '#CC092F', 'Banco do Brasil': '#F8D117' };

function corParaCartao(nome) {
  if (CORES_CARTAO_FIXAS[nome]) return CORES_CARTAO_FIXAS[nome];
  let hash = 0;
  for (let i = 0; i < nome.length; i++) hash = nome.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 40%)`;
}

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function getIdDaUrl() {
  const params = new URLSearchParams(window.location.search);
  return parseInt(params.get('id'), 10);
}

let limiteCartaoAtual = 0; // cache pra calcular a prévia sem salvar nada ainda
let faturaDestaqueAtualId = null; // pra "Marcar como paga" saber qual fatura mexer

async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();

  const id = getIdDaUrl();
  if (!id) {
    document.getElementById('bankName').textContent = 'Cartão não encontrado';
    return;
  }

  const cartao = await DB.obterPorId('cartao', id);
  if (!cartao) {
    document.getElementById('bankName').textContent = 'Cartão não encontrado';
    return;
  }

  const cor = corParaCartao(cartao.nome);
  document.getElementById('bankLogo').style.background = cor;
  document.getElementById('bankLogo').textContent = cartao.nome.slice(0, 2).toUpperCase();
  document.getElementById('bankName').textContent = cartao.nome;

  // A fatura em destaque vem sempre do registro real (importado ou
  // reconstruído pela migração), nunca mais recalculada por data + dia de
  // fechamento estimado do cartão (regra 19). Fatura não paga nunca some
  // como R$0,00 (regra 11): se não existe nenhuma fatura ainda, a tela
  // avisa isso explicitamente, em vez de mostrar um valor inventado.
  const fatura = await DB.faturaEmDestaquePorCartao(id);
  faturaDestaqueAtualId = fatura ? fatura.id : null;
  const acaoFaturaPaga = document.getElementById('acaoFaturaPaga');

  // Correção 1 da homologação: "Fecha dia X · vence dia Y" precisa vir do
  // fechamento/vencimento REAIS já persistidos NESTA fatura específica —
  // nunca do dia de fechamento/vencimento genérico do CARTÃO
  // (cartao.diaFechamento/diaVencimento), que é só a sugestão usada em
  // NOVAS importações e pode ter sido corrigida depois que esta fatura já
  // existia, ficando dessincronizada do dado real dela. Só cai no dia do
  // cartão quando ainda não existe nenhuma fatura pra mostrar.
  if (fatura && fatura.fechamento) {
    const fech = new Date(fatura.fechamento);
    const venc = new Date(fatura.vencimento);
    document.getElementById('bankSub').textContent = `Fecha dia ${fech.getDate()} · vence dia ${venc.getDate()}`;
  } else {
    document.getElementById('bankSub').textContent = `Fecha dia ${cartao.diaFechamento} · vence dia ${cartao.diaVencimento}`;
  }

  if (!fatura) {
    document.getElementById('dueChip').textContent = '📅 Nenhuma fatura importada ainda';
    document.getElementById('valorFatura').textContent = formatarMoeda(0);
    limiteCartaoAtual = cartao.limite;
    acaoFaturaPaga.innerHTML = '';
  } else {
    const vencimento = new Date(fatura.vencimento);
    const situacaoTexto = fatura.statusPagamento === 'paga'
      ? 'Paga'
      : (vencimento < new Date() ? 'Vencida — não paga' : 'Não paga');
    const origemNota = fatura.origem === 'migrada' ? ' · dados estimados, confira' : '';
    document.getElementById('dueChip').textContent =
      `📅 Vence em ${vencimento.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })} · ${situacaoTexto}${origemNota}`;
    document.getElementById('valorFatura').textContent = formatarMoeda(fatura.totalOficial);
    limiteCartaoAtual = cartao.limite;

    // "Marcar como paga" / "Desmarcar como paga": altera SOMENTE o status
    // de pagamento da fatura (regra 14) — nunca despesas, valores, datas,
    // mesFatura ou faturaId. Funciona igual pra qualquer cartão/banco.
    const botaoPagamento = fatura.statusPagamento === 'paga'
      ? `<button type="button" class="acao-fatura-paga-btn desmarcar" onclick="alternarFaturaPaga()">↩️ Desmarcar como paga</button>`
      : `<button type="button" class="acao-fatura-paga-btn" onclick="alternarFaturaPaga()">✅ Marcar como paga</button>`;

    // Correção 1/4 da homologação: dá pra confirmar o fechamento/vencimento
    // REAIS desta fatura (mesmo já paga) sem inventar nada — é a usuária
    // quem informa o dado real, nunca uma inferência automática. Isso é o
    // que faz "dados estimados, confira" (logo abaixo) parar de aparecer:
    // esse aviso só depende de fatura.origem, e confirmar aqui promove a
    // fatura pra origem 'importada' (mesma regra já usada quando uma
    // importação real chega — regra 16).
    const botaoCorrigirDatas = `<button type="button" class="acao-fatura-paga-btn corrigir" onclick="corrigirDatasFaturaAtual()">✏️ Corrigir fechamento/vencimento</button>`;

    acaoFaturaPaga.innerHTML = botaoPagamento + botaoCorrigirDatas;
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

  const nota = status === 'danger'
    ? `${formatarMoeda(valorFatura)} usados de ${formatarMoeda(cartao.limite)} · alerta, você passou do limite seguro.`
    : status === 'warn'
      ? `${formatarMoeda(valorFatura)} usados de ${formatarMoeda(cartao.limite)} · atenção, você está perto do limite seguro.`
      : `${formatarMoeda(valorFatura)} usados de ${formatarMoeda(cartao.limite)} · dentro do limite seguro.`;
  document.getElementById('limitNote').textContent = nota;

  const categorias = await DB.listarTodos('categoria');
  const mapaCategoria = Object.fromEntries(categorias.map((c) => [c.id, c]));
  const todasFaturasDoCartao = await DB.faturasPorCartao(id);
  const mapaFatura = Object.fromEntries(todasFaturasDoCartao.map((f) => [f.id, f]));

  const todasDespesas = await DB.listarTodos('despesa');
  const compras = todasDespesas
    .filter((d) => d.cartaoId === id)
    .map((d) => {
      const faturaDaDespesa = d.faturaId != null ? mapaFatura[d.faturaId] : null;
      // a etiqueta agora só descreve o que já se sabe pelo faturaId real —
      // nunca mais um "entra na próxima fatura" adivinhado por data (regra 3/19)
      let etiquetaFatura = '';
      if (faturaDaDespesa && fatura && faturaDaDespesa.id !== fatura.id) {
        etiquetaFatura = ` · fatura ${faturaDaDespesa.mesFatura}`;
      } else if (!faturaDaDespesa) {
        etiquetaFatura = ' · ainda sem fatura vinculada';
      }
      return {
        ...d,
        categoriaIcone: mapaCategoria[d.categoriaId]?.icone || '💰',
        categoriaNome: mapaCategoria[d.categoriaId]?.nome || 'Outros',
        // regra 4: d.valor já é o valor da parcela, nunca dividir de novo
        valorParcela: d.valor,
        etiquetaFatura,
        // Correção 2 da homologação: usada só pra ordenar (ver sort abaixo) —
        // mesma função de competência de sempre, nunca uma lógica nova
        mesCompetencia: DB.competenciaDespesa(d, mapaFatura)
      };
    })
    // Correção 2: ordena por COMPETÊNCIA (não pela data real), com
    // parcelaAtual como critério de desempate. Antes, ordenar só por
    // "data" fazia uma parcela confirmada e a prevista seguinte, quando
    // projetadas/registradas no mesmo dia (ex.: 8/12 real em 12/09 e 9/12
    // prevista também projetada pro dia 12/09), ficarem "empatadas" e
    // saírem fora de ordem cronológica de competência (ex.: 12,11,10,8,9
    // em vez de 12,11,10,9,8). Nada disso muda parcelaAtual, parcelaTotal,
    // valor, faturaId ou status — só a ordem de exibição.
    .sort((a, b) => {
      if (a.mesCompetencia !== b.mesCompetencia) return b.mesCompetencia > a.mesCompetencia ? 1 : -1;
      if (a.parcelaAtual !== b.parcelaAtual) return (b.parcelaAtual || 0) - (a.parcelaAtual || 0);
      return new Date(b.data) - new Date(a.data);
    });
  const listaCompras = document.getElementById('listaCompras');

  if (compras.length === 0) {
    listaCompras.innerHTML = `<div style="text-align:center;padding:30px 0;color:var(--ink-soft);font-size:13px">Nenhuma compra registrada neste cartão ainda.</div>`;
  } else {
    listaCompras.innerHTML = compras.map((c) => `
      <div class="purchase-card">
        <button type="button" class="txn-more" title="Ações" onclick="abrirAcoesCompra(${c.id})">⋯</button>
        <div class="p-icon">${c.categoriaIcone}</div>
        <div class="p-info">
          <div class="p-name">${c.descricao || c.categoriaNome}${c.statusDespesa === 'previsto' ? ' <span class=\'tag-previsto\'>Previsto</span>' : ''}</div>
          <div class="p-date">${new Date(c.data).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}${c.parcelaTotal > 1 ? ` · parcela ${c.parcelaAtual}/${c.parcelaTotal}` : ''}${c.etiquetaFatura}</div>
        </div>
        <div class="p-value">${formatarMoeda(c.valorParcela)}</div>
      </div>
    `).join('');
  }
}

iniciar();

// ---------- Marcar/desmarcar fatura como paga (regra 14) ----------
async function alternarFaturaPaga() {
  if (!faturaDestaqueAtualId) return;
  const fatura = await DB.obterPorId('fatura', faturaDestaqueAtualId);
  if (!fatura) return;

  if (fatura.statusPagamento === 'paga') {
    await DB.desmarcarFaturaComoPaga(faturaDestaqueAtualId);
  } else {
    await DB.marcarFaturaComoPaga(faturaDestaqueAtualId);
  }

  await iniciar();
}

// Correção 1/4 da homologação: confirma o fechamento/vencimento REAIS da
// fatura em destaque — a usuária digita, nada é inferido/estimado aqui.
// Não toca em totalOficial, statusPagamento, despesas vinculadas, mesFatura
// nem cartaoId; só fechamento, vencimento, e a promoção de origem pra
// 'importada' (dado real confirmado sempre prevalece — regra 16).
async function corrigirDatasFaturaAtual() {
  if (!faturaDestaqueAtualId) return;
  const fatura = await DB.obterPorId('fatura', faturaDestaqueAtualId);
  if (!fatura) return;

  const fechAtual = fatura.fechamento ? new Date(fatura.fechamento).toISOString().slice(0, 10) : '';
  const vencAtual = fatura.vencimento ? new Date(fatura.vencimento).toISOString().slice(0, 10) : '';

  const fechamentoTexto = prompt('Data REAL de fechamento desta fatura (confira na fatura do banco) — AAAA-MM-DD ou DD/MM/AAAA:', fechAtual);
  if (fechamentoTexto === null) return; // cancelou, nada foi gravado
  const fechamentoISO = ImportarFatura.parseDataFatura(fechamentoTexto.trim());
  if (!fechamentoISO) { alert('Data de fechamento inválida. Use AAAA-MM-DD ou DD/MM/AAAA.'); return; }

  const vencimentoTexto = prompt('Data REAL de vencimento desta fatura — AAAA-MM-DD ou DD/MM/AAAA:', vencAtual);
  if (vencimentoTexto === null) return;
  const vencimentoISO = ImportarFatura.parseDataFatura(vencimentoTexto.trim());
  if (!vencimentoISO) { alert('Data de vencimento inválida. Use AAAA-MM-DD ou DD/MM/AAAA.'); return; }

  await DB.corrigirDatasFatura(faturaDestaqueAtualId, { fechamento: fechamentoISO, vencimento: vencimentoISO });
  await iniciar();
}

// ---------- Importação unificada de fatura (foto, PDF ou CSV) ----------

let itensParaImportar = [];
let valorTotalFaturaDetectado = null;
let idCartaoAtual = null;
let idCategoriaOutros = null;

document.getElementById('inputFatura').addEventListener('change', async (e) => {
  const arquivo = e.target.files[0];
  if (!arquivo) return;

  idCartaoAtual = getIdDaUrl();
  const tipo = LerDocumento.detectarTipoArquivo(arquivo);

  const categorias = await DB.listarTodos('categoria');
  const outros = categorias.find((c) => c.nome === 'Outros');
  idCategoriaOutros = outros ? outros.id : (categorias[0] ? categorias[0].id : null);

  if (tipo === 'csv') {
    valorTotalFaturaDetectado = null;
    const texto = await arquivo.text();
    const resultado = ImportarFatura.parseFaturaCsv(texto);
    itensParaImportar = resultado.validos;
    renderPreviewImportacao(resultado);
  } else if (tipo === 'pdf' || tipo === 'imagem') {
    await processarComOcr(arquivo, tipo);
  } else {
    alert('Não reconheci esse tipo de arquivo. Envie uma foto, um PDF ou um CSV.');
  }

  e.target.value = ''; // permite selecionar o mesmo arquivo de novo depois
});

async function processarComOcr(arquivo, tipo) {
  const progresso = document.getElementById('progressoOcr');
  progresso.style.display = 'block';
  progresso.innerHTML = `
    <div class="ocr-progresso">
      <div class="ocr-progresso-texto" id="ocrTexto">${tipo === 'pdf' ? 'Abrindo o PDF...' : 'Lendo a imagem...'}</div>
      <div class="ocr-progresso-track"><div class="ocr-progresso-fill" id="ocrBarra" style="width:0%"></div></div>
    </div>
  `;

  try {
    const texto = await LerDocumento.extrairTextoDoDocumento(arquivo, (mensagem, pct) => {
      const barra = document.getElementById('ocrBarra');
      const label = document.getElementById('ocrTexto');
      if (barra) barra.style.width = Math.round(pct) + '%';
      if (label) label.textContent = mensagem;
    });

    const parse = OcrFatura.parseTextoOCR(texto);
    valorTotalFaturaDetectado = OcrFatura.extrairValorTotal(texto);
    progresso.style.display = 'none';
    progresso.innerHTML = '';
    renderPreviewOcr(parse);
  } catch (err) {
    const mensagemEspecifica = err && err.message ? err.message : null;
    const mensagemPadrao = tipo === 'pdf' ? 'Não consegui ler esse PDF.' : 'Não consegui ler essa imagem. Tente uma foto mais nítida, com boa luz.';
    progresso.innerHTML = `<div style="text-align:center;padding:14px;color:var(--red);font-size:12.5px">${mensagemEspecifica || mensagemPadrao}</div>`;
  }
}

function renderPreviewImportacao(resultado) {
  const box = document.getElementById('previewImportacao');

  if (resultado.validos.length === 0 && resultado.erros.length === 0) {
    box.innerHTML = '';
    return;
  }

  const totalImportar = resultado.validos.reduce((s, i) => s + i.valor, 0);

  box.innerHTML = `
    <div class="import-preview">
      <div class="import-preview-title">${resultado.validos.length} compras encontradas — ${formatarMoeda(totalImportar)}</div>
      ${resultado.erros.length > 0 ? `<div class="import-preview-sub erro">${resultado.erros.length} linha(s) ignorada(s) por erro de formato</div>` : `<div class="import-preview-sub">Confira antes de confirmar a importação</div>`}
      <div class="import-item-list">
        ${resultado.validos.map((item) => `
          <div class="import-item">
            <div>
              <div class="import-item-desc">${item.descricao}</div>
              <div class="import-item-date">${new Date(item.data).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</div>
            </div>
            <div class="import-item-value">${formatarMoeda(item.valor)}</div>
          </div>
        `).join('')}
      </div>
      <div class="import-actions">
        <button class="import-cancel" onclick="cancelarImportacao()">Cancelar</button>
        <button class="import-confirm" onclick="confirmarImportacao()" ${resultado.validos.length === 0 ? 'disabled' : ''}>Importar ${resultado.validos.length} compras</button>
      </div>
    </div>
  `;
}

function cancelarImportacao() {
  itensParaImportar = [];
  valorTotalFaturaDetectado = null;
  document.getElementById('previewImportacao').innerHTML = '';
  document.getElementById('valorFatura').style.opacity = '1';
  document.getElementById('limitFill').style.opacity = '1';
  iniciar(); // restaura os valores reais no card e na barra (a prévia não foi salva)
}

// ---------- Sugestões para a importação (regra 1) ----------
// Tudo aqui é só uma SUGESTÃO pré-preenchida nos prompts — quem decide e
// confirma o mês da fatura, o vencimento e o total oficial é sempre a
// usuária. Nada disso é gravado sem confirmação.

// Sugere o mês da fatura como o mês mais frequente entre os itens
// reconhecidos (empate resolvido pelo mês mais antigo). Isso é só o ponto de
// partida do prompt — nunca o valor final gravado.
function sugerirMesFatura(itens) {
  if (itens.length === 0) return DB.mesAnteriorISO();
  const contagem = new Map();
  for (const item of itens) {
    const mes = item.data.slice(0, 7);
    contagem.set(mes, (contagem.get(mes) || 0) + 1);
  }
  let melhorMes = null;
  let melhorContagem = -1;
  for (const [mes, qtd] of [...contagem.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (qtd > melhorContagem) { melhorContagem = qtd; melhorMes = mes; }
  }
  return melhorMes;
}

// Sugere a data de fechamento REAL desta fatura a partir do dia de
// fechamento configurado no cartão (nunca mais calculado como
// vencimento - 9, regra 3) — o fechamento de uma fatura de competência
// mesFatura cai, por convenção do sistema bancário, no mês seguinte.
function calcularFechamento(mesFatura, diaFechamento) {
  const mesFechamento = DB.somarMesISO(mesFatura, 1);
  const [ano, mes] = mesFechamento.split('-').map(Number);
  return new Date(ano, mes - 1, diaFechamento).toISOString();
}

// Sugere a data de vencimento (só o texto do prompt, "AAAA-MM-DD") a partir
// do dia de vencimento e de fechamento configurados no cartão.
function sugerirVencimento(mesFatura, cartao) {
  const mesFechamento = DB.somarMesISO(mesFatura, 1);
  const diaFech = cartao.diaFechamento;
  const diaVenc = cartao.diaVencimento;
  const mesVencimento = diaVenc >= diaFech ? mesFechamento : DB.somarMesISO(mesFechamento, 1);
  const [ano, mes] = mesVencimento.split('-').map(Number);
  return `${ano}-${String(mes).padStart(2, '0')}-${String(diaVenc).padStart(2, '0')}`;
}

async function confirmarImportacao() {
  if (itensParaImportar.length === 0) return;

  const cartao = await DB.obterPorId('cartao', idCartaoAtual);
  if (!cartao) { alert('Cartão não encontrado.'); return; }
  if (!cartao.diaFechamento) {
    alert('Antes de importar, edite o cartão (✏️) e informe o dia de fechamento real da fatura — confira na sua fatura do banco.');
    return;
  }

  // Evita reimportar a mesma compra se esse arquivo (ou uma foto da mesma
  // fatura) já tiver sido importado antes — compara valor, data e descrição
  // contra o que já existe no banco, em qualquer cartão.
  const despesasExistentes = await DB.listarTodos('despesa');
  function jaFoiImportada(item) {
    return despesasExistentes.some((d) =>
      Math.abs(d.valor - item.valor) < 0.01 &&
      d.data.slice(0, 10) === item.data.slice(0, 10) &&
      d.descricao === item.descricao
    );
  }

  const itensNovos = [];
  let jaExistiam = 0;
  for (const item of itensParaImportar) {
    if (jaFoiImportada(item)) jaExistiam++;
    else itensNovos.push(item);
  }

  if (itensNovos.length === 0) {
    alert(`Nenhuma compra nova pra importar — ${jaExistiam} já existiam no seu histórico (mesmo valor, data e descrição).`);
    itensParaImportar = [];
    valorTotalFaturaDetectado = null;
    document.getElementById('previewImportacao').innerHTML = '';
    await iniciar();
    return;
  }

  // Regra 1: o mês da fatura (competência) é o dado que a usuária confirma
  // aqui, nunca uma estimativa baseada na data da compra ou no dia de
  // fechamento — isso vira fatura.mesFatura direto, sem depender de
  // nenhuma migração posterior pra descobrir a qual fatura a despesa pertence.
  const mesFaturaTexto = prompt(
    'Qual é o mês desta fatura (competência)? Formato AAAA-MM — confira no topo/resumo da fatura do banco.',
    sugerirMesFatura(itensNovos)
  );
  if (mesFaturaTexto === null) return; // cancelou, nada foi gravado
  const mesFatura = mesFaturaTexto.trim();
  if (!/^\d{4}-\d{2}$/.test(mesFatura)) { alert('Formato inválido. Use AAAA-MM, por exemplo 2026-08.'); return; }

  const vencimentoTexto = prompt('Data de vencimento desta fatura (AAAA-MM-DD):', sugerirVencimento(mesFatura, cartao));
  if (vencimentoTexto === null) return;
  const vencimentoISO = ImportarFatura.parseDataFatura(vencimentoTexto.trim());
  if (!vencimentoISO) { alert('Data de vencimento inválida. Use AAAA-MM-DD ou DD/MM/AAAA.'); return; }

  const totalImportado = itensNovos.reduce((s, i) => s + i.valor, 0);
  const totalSugerido = valorTotalFaturaDetectado !== null ? valorTotalFaturaDetectado : totalImportado;
  const totalTexto = prompt('Valor TOTAL OFICIAL desta fatura (confira no boleto/fatura do banco):', totalSugerido.toFixed(2).replace('.', ','));
  if (totalTexto === null) return;
  const totalOficial = ImportarFatura.parseValorMonetario(totalTexto);
  if (isNaN(totalOficial) || totalOficial <= 0) { alert('Valor total inválido.'); return; }

  // Regra 3/4: detecta "Parcela 8/12" (etc.) na descrição reconhecida — só
  // quando o padrão aparece de verdade, nunca confundindo com uma data
  // (regra do extrairParcela: exige a palavra "parcela" do lado). Compra sem
  // esse padrão continua parcelaAtual/parcelaTotal 1/1 (à vista), como sempre.
  const itensParaGravar = itensNovos.map((item) => {
    const parcela = ImportarFatura.extrairParcela(item.descricao);
    return {
      valor: item.valor,
      data: item.data,
      descricao: item.descricao,
      categoriaId: idCategoriaOutros,
      parcelaAtual: parcela ? parcela.parcelaAtual : 1,
      parcelaTotal: parcela ? parcela.parcelaTotal : 1
    };
  });

  // Regra do Valor Total de Segurança (mantida): se o total oficial
  // confirmado é maior que a soma dos itens reconhecidos linha por linha,
  // lança a diferença como um ajuste na mesma fatura — garante que a fatura
  // bate com o valor real do banco mesmo quando alguma linha não foi
  // reconhecida (por OCR ou por não constar no CSV).
  const diferenca = totalOficial - totalImportado;
  if (diferenca > 0.01) {
    const dataDoAjuste = itensNovos.reduce((maisRecente, item) => item.data > maisRecente ? item.data : maisRecente, itensNovos[0].data);
    itensParaGravar.push({
      valor: diferenca,
      data: dataDoAjuste,
      descricao: 'Outros Gastos da Fatura (Ajuste)',
      categoriaId: idCategoriaOutros
    });
  }

  const fechamentoISO = calcularFechamento(mesFatura, cartao.diaFechamento);

  const resultado = await DB.importarFatura(
    {
      cartaoId: idCartaoAtual,
      mesFatura,
      vencimento: vencimentoISO,
      fechamento: fechamentoISO,
      cicloFim: fechamentoISO,
      statusPagamento: 'nao_paga',
      totalOficial
    },
    itensParaGravar
  );

  let mensagem = `${itensParaGravar.length} lançamento(s) importado(s) pra fatura de ${mesFatura}.`;
  if (jaExistiam > 0) mensagem += ` ${jaExistiam} já existiam no seu histórico e foram pulados, pra não duplicar.`;
  if (!resultado.criada) mensagem += ' Já existia uma fatura desse cartão nesse mês — os lançamentos foram vinculados a ela, sem criar fatura duplicada.';
  if (resultado.revisaoNecessaria.length > 0) {
    mensagem += ` Atenção: ${resultado.revisaoNecessaria.length} lançamento(s) parcelado(s) bateram com mais de uma previsão existente — não mesclei sozinho, pra não errar. Confira manualmente essas compras em "Compras deste cartão".`;
  }
  alert(mensagem);

  itensParaImportar = [];
  valorTotalFaturaDetectado = null;
  window.location.reload(); // recarrega tudo do zero: fatura, limite, lista de compras, avisos
}

// ---------- Leitura de fatura por foto/PDF (OCR local via Tesseract.js + PDF.js) ----------
// (o disparo agora acontece pelo roteador único do input #inputFatura, acima)

// Mostra no card azul e na barra de limite uma PRÉVIA do valor total antes
// de confirmar a importação — deixa claro que ainda não foi salvo, pra não
// parecer que já importou se a usuária sair da tela sem confirmar.
function mostrarPreviaFatura(valorPrevia) {
  const valorAtual = document.getElementById('valorFatura');
  valorAtual.textContent = `${formatarMoeda(valorPrevia)} (prévia)`;
  valorAtual.style.opacity = '0.75';

  if (limiteCartaoAtual > 0) {
    const percentual = (valorPrevia / limiteCartaoAtual) * 100;
    const status = Motor.statusLimite(percentual);
    const corBarra = status === 'ok' ? 'var(--green)' : status === 'warn' ? 'var(--amber)' : 'var(--red)';

    document.getElementById('limitPct').textContent = `${percentual.toFixed(0)}% (prévia)`;
    document.getElementById('limitFill').style.width = `${Math.min(percentual, 100).toFixed(0)}%`;
    document.getElementById('limitFill').style.background = corBarra;
    document.getElementById('limitFill').style.opacity = '0.6';
  }
}

function renderPreviewOcr(parse) {
  itensParaImportar = parse.validos;
  const box = document.getElementById('previewImportacao');

  const totalImportar = parse.validos.reduce((s, i) => s + i.valor, 0);
  const diferenca = valorTotalFaturaDetectado !== null ? valorTotalFaturaDetectado - totalImportar : null;
  const totalComAjuste = diferenca !== null && diferenca > 0.01 ? totalImportar + diferenca : totalImportar;
  mostrarPreviaFatura(totalComAjuste);

  box.innerHTML = `
    <div class="import-preview">
      <div class="import-preview-title">${parse.validos.length} compras reconhecidas — ${formatarMoeda(totalImportar)}</div>
      ${parse.ignoradas.length > 0 ? `<div class="import-preview-sub erro">${parse.ignoradas.length} linha(s) da imagem não foram reconhecidas — confira se não falta nada e cadastre manualmente se precisar</div>` : `<div class="import-preview-sub">Confira antes de confirmar — leitura por foto pode errar</div>`}
      ${valorTotalFaturaDetectado !== null ? `
        <div class="import-preview-sub" style="color:var(--blue);font-weight:600">
          Total da fatura identificado: ${formatarMoeda(valorTotalFaturaDetectado)}
          ${diferenca > 0.01 ? ` — diferença de ${formatarMoeda(diferenca)} será lançada como "Outros Gastos da Fatura (Ajuste OCR)"` : ' — bateu certinho com as compras reconhecidas'}
        </div>
      ` : ''}
      <div class="import-item-list">
        ${parse.validos.map((item, i) => `
          <div class="import-item">
            <div>
              <div class="import-item-desc">${item.descricao}</div>
              <div class="import-item-date">${new Date(item.data).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="import-item-value">${formatarMoeda(item.valor)}</div>
              <button onclick="removerItemOcr(${i})" style="background:none;border:none;color:var(--red);font-size:14px">✕</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="import-actions">
        <button class="import-cancel" onclick="cancelarImportacao()">Cancelar</button>
        <button class="import-confirm" onclick="confirmarImportacao()" ${parse.validos.length === 0 ? 'disabled' : ''}>Importar ${parse.validos.length} compras</button>
      </div>
    </div>
  `;
}

function removerItemOcr(indice) {
  itensParaImportar.splice(indice, 1);
  renderPreviewOcr({ validos: itensParaImportar, ignoradas: [] });
}

// ---------- Edição e exclusão do cartão ----------

async function abrirModalEdicao() {
  const id = getIdDaUrl();
  const cartao = await DB.obterPorId('cartao', id);
  if (!cartao) return;

  document.getElementById('inputNomeCartao').value = cartao.nome;
  aplicarMascaraMoeda(document.getElementById('inputLimiteCartao'));
  definirValorMascarado(document.getElementById('inputLimiteCartao'), cartao.limite);
  document.getElementById('inputVencimentoCartao').value = cartao.diaVencimento;
  document.getElementById('inputFechamentoCartao').value = cartao.diaFechamento || '';
  document.getElementById('sheetOverlay').classList.add('open');
}

function fecharModal() {
  document.getElementById('sheetOverlay').classList.remove('open');
}

function fecharModalSeClicarFora(event) {
  if (event.target.id === 'sheetOverlay') fecharModal();
}

async function salvarEdicaoCartao() {
  const id = getIdDaUrl();
  const cartao = await DB.obterPorId('cartao', id);
  if (!cartao) return;

  const nome = document.getElementById('inputNomeCartao').value.trim();
  const limite = valorNumericoDoInput(document.getElementById('inputLimiteCartao'));
  const diaVencimento = parseInt(document.getElementById('inputVencimentoCartao').value, 10);
  // Regra 3 do diagnóstico: fechamento real, digitado — nunca mais
  // "vencimento - 9".
  const diaFechamento = parseInt(document.getElementById('inputFechamentoCartao').value, 10);

  if (!nome) { alert('Informe o nome do banco.'); return; }
  if (!limite || limite <= 0) { alert('Informe um limite válido.'); return; }
  if (!diaVencimento || diaVencimento < 1 || diaVencimento > 31) { alert('Informe um dia de vencimento válido (1 a 31).'); return; }
  if (!diaFechamento || diaFechamento < 1 || diaFechamento > 31) { alert('Informe o dia de fechamento real da fatura (1 a 31) — confira na sua fatura do banco.'); return; }

  await DB.atualizar('cartao', {
    ...cartao,
    nome,
    limite,
    diaFechamento,
    diaVencimento
  });

  fecharModal();
  await iniciar();
}

// ---------- Ações de um lançamento (Editar / Excluir) ----------
// As ações previstas aqui são só Editar e Excluir — não existe ainda
// nenhuma detecção de lançamentos duplicados/mesclagem no app, então essa
// ação não é oferecida por enquanto (fica pendente pra quando existir).

let compraEmEdicaoId = null;

async function abrirAcoesCompra(id) {
  compraEmEdicaoId = id;
  const registro = await DB.obterPorId('despesa', id);
  if (!registro) return;

  aplicarMascaraMoeda(document.getElementById('compraValor'));
  definirValorMascarado(document.getElementById('compraValor'), registro.valor);
  document.getElementById('compraDescricao').value = registro.descricao || '';
  document.getElementById('compraData').value = registro.data.slice(0, 10);

  const categorias = await DB.listarTodos('categoria');
  document.getElementById('compraCategoriaChips').innerHTML = categorias.map((c) => `
    <div class="chip ${c.id === registro.categoriaId ? 'selected' : ''}" data-id="${c.id}" onclick="selecionarCategoriaCompra(${c.id})">${c.icone} ${c.nome}</div>
  `).join('');
  document.getElementById('compraCategoriaChips').dataset.selecionado = registro.categoriaId;

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

function fecharModalCompraSeClicarFora(event) {
  if (event.target.id === 'sheetOverlayCompra') fecharModalCompra();
}

async function salvarEdicaoCompra() {
  if (!compraEmEdicaoId) return;
  const valor = valorNumericoDoInput(document.getElementById('compraValor'));
  if (!valor || valor <= 0) { alert('Valor inválido.'); return; }

  const categoriaId = Number(document.getElementById('compraCategoriaChips').dataset.selecionado);
  if (!categoriaId) { alert('Escolha uma categoria.'); return; }

  const descricao = document.getElementById('compraDescricao').value.trim();
  const dataEscolhida = document.getElementById('compraData').value; // "AAAA-MM-DD"
  const [ano, mes, dia] = dataEscolhida.split('-').map(Number);
  const dataFinal = new Date(ano, mes - 1, dia).toISOString();

  const registro = await DB.obterPorId('despesa', compraEmEdicaoId);
  // marca como editada manualmente: uma importação/reconciliação futura
  // (Parte 2) não pode recriar nem desfazer silenciosamente essa alteração
  await DB.atualizar('despesa', { ...registro, valor, categoriaId, descricao, data: dataFinal, editadoManualmente: true });

  fecharModalCompra();
  await iniciar();
}

async function excluirCompra() {
  if (!compraEmEdicaoId) return;
  const ok = confirm('Excluir este lançamento? Essa ação não pode ser desfeita.');
  if (!ok) return;

  await DB.remover('despesa', compraEmEdicaoId);
  fecharModalCompra();
  await iniciar();
}

async function excluirCartao() {
  const id = getIdDaUrl();
  const ok = confirm('Excluir este cartão? As compras já registradas continuam no seu histórico, mas passam a aparecer como "Dinheiro/Pix" em vez do nome do banco.');
  if (!ok) return;

  // Desvincula as despesas desse cartão em vez de apagá-las
  const despesas = await DB.listarTodos('despesa');
  for (const d of despesas) {
    if (d.cartaoId === id) {
      await DB.atualizar('despesa', { ...d, cartaoId: null });
    }
  }

  await DB.remover('cartao', id);
  location.href = 'cartoes.html';
}
