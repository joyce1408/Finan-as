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
  document.getElementById('bankSub').textContent = `Fecha dia ${cartao.diaFechamento} · vence dia ${cartao.diaVencimento}`;

  const agora = new Date();
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()); // sem hora — evita empurrar "vence hoje" pro mês seguinte por causa do horário
  let vencimento = new Date(hoje.getFullYear(), hoje.getMonth(), cartao.diaVencimento);
  if (vencimento < hoje) vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 1, cartao.diaVencimento);
  const mesISOFatura = `${vencimento.getFullYear()}-${String(vencimento.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('dueChip').textContent = `📅 Vence em ${vencimento.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })}`;

  const despesasDoCiclo = await DB.despesasDoCicloFatura(id, mesISOFatura);
  const valorFatura = despesasDoCiclo.reduce((soma, d) => soma + d.valor / (d.parcelaTotal || 1), 0);
  document.getElementById('valorFatura').textContent = formatarMoeda(valorFatura);
  limiteCartaoAtual = cartao.limite;

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
  const idsDoCicloAtual = new Set(despesasDoCiclo.map((d) => d.id));

  const todasDespesas = await DB.listarTodos('despesa');
  const compras = todasDespesas
    .filter((d) => d.cartaoId === id)
    .map((d) => ({
      ...d,
      categoriaIcone: mapaCategoria[d.categoriaId]?.icone || '💰',
      categoriaNome: mapaCategoria[d.categoriaId]?.nome || 'Outros',
      valorParcela: d.valor / (d.parcelaTotal || 1),
      noCicloAtual: idsDoCicloAtual.has(d.id)
    }))
    .sort((a, b) => new Date(b.data) - new Date(a.data));
  const listaCompras = document.getElementById('listaCompras');

  if (compras.length === 0) {
    listaCompras.innerHTML = `<div style="text-align:center;padding:30px 0;color:var(--ink-soft);font-size:13px">Nenhuma compra registrada neste cartão ainda.</div>`;
  } else {
    listaCompras.innerHTML = compras.map((c) => `
      <div class="purchase-card">
        <div class="p-icon">${c.categoriaIcone}</div>
        <div class="p-info">
          <div class="p-name">${c.descricao || c.categoriaNome}</div>
          <div class="p-date">${new Date(c.data).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}${c.parcelaTotal > 1 ? ` · parcela ${c.parcelaAtual}/${c.parcelaTotal}` : ''}${!c.noCicloAtual ? ' · entra na próxima fatura' : ''}</div>
        </div>
        <div class="p-value">${formatarMoeda(c.valorParcela)}</div>
      </div>
    `).join('');
  }
}

iniciar();

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

async function confirmarImportacao() {
  const totalImportado = itensParaImportar.reduce((s, i) => s + i.valor, 0);

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

  let importadas = 0;
  let jaExistiam = 0;

  for (const item of itensParaImportar) {
    if (jaFoiImportada(item)) {
      jaExistiam++;
      continue;
    }
    await DB.adicionar('despesa', {
      valor: item.valor,
      categoriaId: idCategoriaOutros,
      cartaoId: idCartaoAtual,
      data: item.data,
      parcelaAtual: 1,
      parcelaTotal: 1,
      descricao: item.descricao
    });
    importadas++;
  }

  // Regra do Valor Total de Segurança: se identificamos o total real da
  // fatura no texto (via OCR) e ele é maior que a soma das compras que
  // conseguimos reconhecer linha por linha, lança a diferença como um
  // ajuste — garante que a fatura na tela bate com o valor real do banco
  // mesmo quando o OCR pula alguma linha.
  if (valorTotalFaturaDetectado !== null) {
    const diferenca = valorTotalFaturaDetectado - totalImportado;
    if (diferenca > 0.01) {
      // Usa a MAIOR data entre os itens importados (não "hoje") — assim o
      // ajuste cai garantidamente no mesmo ciclo de fatura das compras que
      // ele está compensando, em vez de vazar pro ciclo do mês seguinte
      const dataDoAjuste = itensParaImportar.length > 0
        ? itensParaImportar.reduce((maisRecente, item) => item.data > maisRecente ? item.data : maisRecente, itensParaImportar[0].data)
        : new Date().toISOString();

      await DB.adicionar('despesa', {
        valor: diferenca,
        categoriaId: idCategoriaOutros,
        cartaoId: idCartaoAtual,
        data: dataDoAjuste,
        parcelaAtual: 1,
        parcelaTotal: 1,
        descricao: 'Outros Gastos da Fatura (Ajuste OCR)'
      });
    }
  }

  if (jaExistiam > 0) {
    alert(`${importadas} compra(s) nova(s) importada(s). ${jaExistiam} já existiam no seu histórico (mesmo valor, data e descrição) e foram puladas, pra não duplicar.`);
  }

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

  if (!nome) { alert('Informe o nome do banco.'); return; }
  if (!limite || limite <= 0) { alert('Informe um limite válido.'); return; }
  if (!diaVencimento || diaVencimento < 1 || diaVencimento > 31) { alert('Informe um dia de vencimento válido (1 a 31).'); return; }

  await DB.atualizar('cartao', {
    ...cartao,
    nome,
    limite,
    diaFechamento: Math.max(1, diaVencimento - 9),
    diaVencimento
  });

  fecharModal();
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
