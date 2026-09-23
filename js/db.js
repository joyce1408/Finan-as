// db.js
// Toda a persistência do app roda aqui, 100% local no dispositivo via IndexedDB.
// Nenhuma dessas funções faz chamada de rede.

const DB_NAME = 'financas_db';
const DB_VERSION = 5;

let dbInstance = null;

function abrirBanco() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('categoria')) {
        const store = db.createObjectStore('categoria', { keyPath: 'id', autoIncrement: true });
        store.createIndex('nome', 'nome', { unique: false });
      }

      if (!db.objectStoreNames.contains('cartao')) {
        db.createObjectStore('cartao', { keyPath: 'id', autoIncrement: true });
      }

      if (!db.objectStoreNames.contains('despesa')) {
        const store = db.createObjectStore('despesa', { keyPath: 'id', autoIncrement: true });
        store.createIndex('data', 'data', { unique: false });
        store.createIndex('categoriaId', 'categoriaId', { unique: false });
        store.createIndex('cartaoId', 'cartaoId', { unique: false });
      }

      if (!db.objectStoreNames.contains('renda')) {
        db.createObjectStore('renda', { keyPath: 'id', autoIncrement: true });
      }

      if (!db.objectStoreNames.contains('reserva')) {
        db.createObjectStore('reserva', { keyPath: 'id', autoIncrement: true });
      }

      // v2 — receitas avulsas (bônus, reembolsos, freelas etc.)
      if (!db.objectStoreNames.contains('receita')) {
        const store = db.createObjectStore('receita', { keyPath: 'id', autoIncrement: true });
        store.createIndex('data', 'data', { unique: false });
      }

      // v3 — histórico de aportes na reserva de emergência, pro gráfico de evolução
      if (!db.objectStoreNames.contains('aporte')) {
        const store = db.createObjectStore('aporte', { keyPath: 'id', autoIncrement: true });
        store.createIndex('data', 'data', { unique: false });
      }
      // v4 — fundação pra parcelamento com previsão/confirmação e para
      // controle de fatura paga/não paga (ver /areas/app-financas-pessoais)
      if (!db.objectStoreNames.contains('fatura')) {
        const store = db.createObjectStore('fatura', { keyPath: 'id', autoIncrement: true });
        store.createIndex('cartaoId', 'cartaoId', { unique: false });
        store.createIndex('mesISO', 'mesISO', { unique: false }); // substituído por 'mesFatura' na v5, ver abaixo
      }

      // índice novo numa store que já existe desde a v1 — precisa pegar a
      // store de dentro da transação de upgrade, não recriar ela
      if (db.objectStoreNames.contains('despesa')) {
        const despesaStore = event.target.transaction.objectStore('despesa');
        if (!despesaStore.indexNames.contains('idParcelamento')) {
          despesaStore.createIndex('idParcelamento', 'idParcelamento', { unique: false });
        }
        if (!despesaStore.indexNames.contains('statusDespesa')) {
          despesaStore.createIndex('statusDespesa', 'statusDespesa', { unique: false });
        }
      }

      // v5 — Fatura passa a ser uma entidade real (Despesa → Fatura → Cartão),
      // com dados próprios de ciclo/fechamento/vencimento/total oficial/status
      // de pagamento, em vez de tudo ser recalculado na hora a partir da data
      // da despesa + um dia de fechamento estimado do cartão. Ver especificação
      // definitiva em /areas/app-financas-pessoais.
      if (db.objectStoreNames.contains('fatura')) {
        const faturaStore = event.target.transaction.objectStore('fatura');
        // 'mesISO' nunca chegou a ser usado (store ficava vazia) — troca limpa
        // pelo nome definitivo 'mesFatura' (o "Mês da fatura" da especificação)
        if (faturaStore.indexNames.contains('mesISO')) {
          faturaStore.deleteIndex('mesISO');
        }
        if (!faturaStore.indexNames.contains('mesFatura')) {
          faturaStore.createIndex('mesFatura', 'mesFatura', { unique: false });
        }
      }

      if (db.objectStoreNames.contains('despesa')) {
        const despesaStore = event.target.transaction.objectStore('despesa');
        if (!despesaStore.indexNames.contains('faturaId')) {
          despesaStore.createIndex('faturaId', 'faturaId', { unique: false });
        }
      }
    };

    request.onsuccess = async (event) => {
      dbInstance = event.target.result;
      await migrarDespesasParaV4();
      await migrarFaturasParaV5();
      await migrarParcelamentosExistentes();
      resolve(dbInstance);
    };

    request.onerror = (event) => reject(event.target.error);
  });
}

// Preenche os campos novos (statusDespesa, idParcelamento, editadoManualmente)
// em despesas que já existiam antes dessa versão. Idempotente: só mexe em
// registros que ainda não têm statusDespesa definido, então rodar de novo
// não duplica nem sobrescreve nada que já foi migrado. Usa atualizar() (put
// no id que já existe), nunca adicionar() — não cria registro novo nenhum.
async function migrarDespesasParaV4() {
  const todasDespesas = await listarTodos('despesa');
  for (const d of todasDespesas) {
    if (d.statusDespesa !== undefined) continue; // já migrada
    await atualizar('despesa', {
      ...d,
      statusDespesa: 'confirmado', // já existia no sistema = gasto real confirmado
      idParcelamento: d.idParcelamento ?? null, // não sabemos que é parcelada, fica nulo
      editadoManualmente: d.editadoManualmente ?? false
    });
  }
}

// Soma (ou subtrai, com delta negativo) meses a uma chave "AAAA-MM".
function somarMesISO(mesISO, delta) {
  const [ano, mes] = mesISO.split('-').map(Number);
  const d = new Date(ano, mes - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- Migração v5: Fatura como entidade real ----------
// Antes da v5, "a qual fatura uma despesa pertence" nunca era guardado —
// era recalculado toda vez, comparando a data da despesa com a data de hoje
// e um dia de fechamento estimado do cartão (vencimento - 9). Isso causava
// os problemas descritos em /areas/app-financas-pessoais: fatura mostrando
// R$0,00 depois que o vencimento passava, compras somem da tela "entra na
// próxima fatura", Saídas da Home não batendo entre cartões.
//
// Essa migração roda uma vez (é idempotente: despesa que já tem faturaId
// definido — mesmo null — é pulada, então rodar de novo nunca duplica fatura
// nem sobrescreve nada). Ela reconstrói, da melhor forma possível com o dado
// que já existia, uma fatura por cartão/ciclo e vincula as despesas antigas
// a ela. Essas faturas reconstruídas ficam com origem: 'migrada', porque
// fechamento/vencimento/total são ESTIMADOS (a mesma estimativa que o
// sistema já usava antes), nunca o dado real da fatura — só uma importação
// de verdade (fluxo que ainda vai ser construído) cria fatura com
// origem: 'importada' e dados confiáveis.
async function migrarFaturasParaV5() {
  // Correção: faturas 'migrada' são estimativas, nunca dado confirmado pelo
  // usuário (não existe ainda tela pra editar/pagar uma fatura). Por isso é
  // seguro reprocessá-las do zero toda vez, com a estimativa mais recente —
  // isso autocorrige, nas próximas aberturas do app, quem já tinha sido
  // migrado com a estimativa antiga (o bug relatado: fatura de agosto sendo
  // apresentada como se vencesse em outubro/novembro). Uma fatura 'importada'
  // (dado real, quando o fluxo de importação existir) nunca é tocada aqui.
  const faturasExistentes = await listarTodos('fatura');
  const faturasParaRefazer = faturasExistentes.filter((f) => f.origem === 'migrada' && f.statusPagamento === 'nao_paga');
  if (faturasParaRefazer.length > 0) {
    const idsParaRefazer = new Set(faturasParaRefazer.map((f) => f.id));
    const todasDespesasAtuais = await listarTodos('despesa');
    for (const d of todasDespesasAtuais) {
      if (idsParaRefazer.has(d.faturaId)) {
        await atualizar('despesa', { ...d, faturaId: undefined });
      }
    }
    for (const f of faturasParaRefazer) {
      await remover('fatura', f.id);
    }
  }

  const todasDespesas = await listarTodos('despesa');
  const pendentes = todasDespesas.filter((d) => d.faturaId === undefined);
  if (pendentes.length === 0) return;

  // despesas à vista (sem cartão) não têm fatura — só marca como migrada
  // (faturaId: null), nunca cria fatura pra elas
  const semCartao = pendentes.filter((d) => !d.cartaoId);
  for (const d of semCartao) {
    await atualizar('despesa', { ...d, faturaId: null });
  }

  const comCartao = pendentes.filter((d) => d.cartaoId);
  if (comCartao.length === 0) return;

  const cartoes = await listarTodos('cartao');
  const mapaCartao = Object.fromEntries(cartoes.map((c) => [c.id, c]));
  const mesAtual = mesAtualISO();

  // Correção da causa raiz 2 do diagnóstico: nunca criar uma segunda fatura
  // pro mesmo cartaoId + mesFatura. Mantém um mapa "cartaoId|mesFatura" das
  // faturas que já existem (importadas OU migradas, pagas OU não) — carregado
  // de novo aqui porque faturasExistentes (lá em cima) pode já estar
  // desatualizado depois do passo de "refazer". Esse mapa é atualizado à
  // medida que despesas pendentes vão sendo linkadas/agrupadas abaixo, pra
  // que duas despesas pendentes do mesmo grupo nunca gerem duas faturas.
  const faturasAtuais = await listarTodos('fatura');
  const mapaFaturaPorChave = new Map(faturasAtuais.map((f) => [`${f.cartaoId}|${f.mesFatura}`, f]));

  // agrupa cada despesa de cartão pelo MÊS DE FECHAMENTO estimado (não é o
  // mesFatura/competência — são conceitos diferentes, ver abaixo): comprou
  // até o dia de fechamento estimado → fecha no próprio mês da compra;
  // comprou depois → fecha no mês seguinte. Trava importante: o mês de
  // fechamento estimado NUNCA pode passar do mês atual — toda despesa
  // migrada já aconteceu no passado, então não existe base real pra estimar
  // um fechamento num mês que ainda nem começou. Sem essa trava, uma compra
  // no fim do mês (como a Espaço Laser, dia 12, com o cartão configurado com
  // dia de fechamento bem cedo) podia ser jogada pra um fechamento futuro,
  // fazendo o sistema tratar uma fatura que já existe (e já pode estar
  // vencida) como se fosse uma fatura ainda não criada lá na frente.
  const grupos = new Map(); // chave "cartaoId|mesFechamento" -> despesas[]
  for (const d of comCartao) {
    const cartao = mapaCartao[d.cartaoId];
    if (!cartao) { await atualizar('despesa', { ...d, faturaId: null }); continue; }

    const dia = new Date(d.data).getDate();
    const mesDaCompra = d.data.slice(0, 7);
    const diaFechamentoEstimado = cartao.diaFechamento || 1;
    let mesFechamentoEstimado = dia <= diaFechamentoEstimado ? mesDaCompra : somarMesISO(mesDaCompra, 1);
    if (mesFechamentoEstimado > mesAtual) mesFechamentoEstimado = mesAtual; // trava: nunca estima fechamento no futuro

    const chave = `${d.cartaoId}|${mesFechamentoEstimado}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(d);
  }

  for (const [chave, despesasDoGrupo] of grupos) {
    const [cartaoIdTexto, mesFechamento] = chave.split('|');
    const cartaoId = Number(cartaoIdTexto);
    const cartao = mapaCartao[cartaoId];
    const diaFech = cartao.diaFechamento || 1;
    const diaVenc = cartao.diaVencimento || 10;

    // fechamento estimado: dia de fechamento do cartão, no mês de fechamento.
    const [ano, mes] = mesFechamento.split('-').map(Number);
    const fechamentoEstimado = new Date(ano, mes - 1, diaFech).toISOString();

    // vencimento estimado: se o dia de vencimento do cartão é maior ou igual
    // ao dia de fechamento, o vencimento cai no mesmo mês do fechamento; só
    // cai no mês seguinte quando o dia de vencimento é menor (fechou no fim
    // de um mês, vence já no começo do próximo).
    const mesVencimento = diaVenc >= diaFech ? mesFechamento : somarMesISO(mesFechamento, 1);
    const [anoVenc, mesVenc] = mesVencimento.split('-').map(Number);
    const vencimentoEstimado = new Date(anoVenc, mesVenc - 1, diaVenc).toISOString();

    // mesFatura (competência/statement) é diferente do mês de fechamento —
    // essa regra (fechamento - 1 mês) é uma ESTIMATIVA exclusiva da migração
    // histórica, porque não temos o mesFatura real confirmado por ninguém.
    // Fatura importada de verdade (DB.importarFatura) usa o mesFatura que o
    // usuário informou/confirmou, nunca esse cálculo.
    const mesFatura = somarMesISO(mesFechamento, -1);

    const totalEstimado = despesasDoGrupo.reduce((soma, d) => soma + d.valor, 0);
    const chaveFatura = `${cartaoId}|${mesFatura}`;
    const faturaExistente = mapaFaturaPorChave.get(chaveFatura);

    if (faturaExistente) {
      // Já existe fatura pra esse cartão + mês (importada ou migrada, paga ou
      // não) — nunca cria uma segunda. Só vincula as despesas pendentes a
      // ela. Se a fatura já existente for 'importada', totalOficial é dado
      // real confirmado pelo usuário e NUNCA é sobrescrito aqui. Se for
      // 'migrada', o total ainda é só uma soma do que existe, então é seguro
      // atualizar somando as despesas que estão entrando agora.
      for (const d of despesasDoGrupo) {
        await atualizar('despesa', { ...d, faturaId: faturaExistente.id });
      }
      if (faturaExistente.origem === 'migrada') {
        const atualizada = { ...faturaExistente, totalOficial: faturaExistente.totalOficial + totalEstimado };
        await atualizar('fatura', atualizada);
        mapaFaturaPorChave.set(chaveFatura, atualizada);
      }
      continue;
    }

    const novaFaturaId = await adicionar('fatura', {
      cartaoId,
      mesFatura,
      cicloInicio: null, // desconhecido — não há fatura anterior real pra basear o início do ciclo
      cicloFim: fechamentoEstimado,
      fechamento: fechamentoEstimado,
      vencimento: vencimentoEstimado,
      totalOficial: totalEstimado, // única fonte disponível: soma do que já existia
      statusPagamento: 'nao_paga', // não há como saber se já foi paga — fica como pendente de conferência
      origem: 'migrada'
    });

    for (const d of despesasDoGrupo) {
      await atualizar('despesa', { ...d, faturaId: novaFaturaId });
    }
    mapaFaturaPorChave.set(chaveFatura, { id: novaFaturaId, cartaoId, mesFatura, totalOficial: totalEstimado, origem: 'migrada' });
  }
}

// Mesma regra de reconhecimento usada na importação (js/importar-fatura.js,
// extrairParcela) — duplicada aqui, de propósito, porque essa migração roda
// dentro de abrirBanco() e precisa funcionar em QUALQUER tela, mesmo nas que
// não carregam importar-fatura.js (ex.: index.html). Mantém exatamente a
// mesma regra: só reconhece "parcela"/"parc" do lado do número, nunca um
// "N/M" solto, pra nunca confundir com uma data (ex.: "12/09").
function extrairParcelaDaDescricao(descricao) {
  if (!descricao) return null;
  const m = descricao.match(/parc(?:ela)?\.?\s*(\d{1,2})\s*\/\s*(\d{1,2})/i);
  if (!m) return null;
  const parcelaAtual = parseInt(m[1], 10);
  const parcelaTotal = parseInt(m[2], 10);
  if (!parcelaAtual || !parcelaTotal || parcelaAtual < 1 || parcelaTotal < 1 || parcelaAtual > parcelaTotal) return null;
  return { parcelaAtual, parcelaTotal };
}

// ---------- Migração de parcelamentos que já existiam antes desta lógica (regra 5) ----------
// gerarParcelasFuturasPrevistas só passou a rodar a partir de uma importação
// feita com DB.importarFatura. Um parcelamento que já estava gravado no
// banco ANTES dessa lógica existir (ex.: a Espaço Laser 8/12, importada
// antes desta revisão) nunca teve as parcelas futuras (9/12..12/12) geradas,
// nem uma idParcelamento definida. Esta migração reprocessa esses casos de
// forma GENÉRICA — nunca específica de uma loja ou banco: qualquer despesa
// CONFIRMADA que seja uma parcela (parcelaTotal > 1, já salvo no registro ou
// reconhecido de novo na própria descrição, ex. "Parcela N/M") ganha uma
// idParcelamento (o próprio id, quando ainda não tem nenhuma — mesma regra
// usada em gravarOuReconciliarItemDaFatura pra despesa nova) e tem as
// parcelas FUTURAS que ainda faltam geradas como previstas — nunca as
// anteriores à parcela conhecida (regra 6, já garantida dentro de
// gerarParcelasFuturasPrevistas, que nunca gera pra trás de parcelaAtual).
// Idempotente: reaproveita a mesma trava de gerarParcelasFuturasPrevistas
// (confere a série já existente por idParcelamento antes de criar), então
// rodar de novo (toda vez que o app abre) nunca duplica nada.
async function migrarParcelamentosExistentes() {
  const todasDespesas = await listarTodos('despesa');
  const mapaFatura = await mapaFaturasPorId();

  for (const d of todasDespesas) {
    if (d.statusDespesa !== 'confirmado') continue; // só reprocessa gasto real confirmado, nunca uma previsão

    let parcelaAtual = d.parcelaAtual;
    let parcelaTotal = d.parcelaTotal;

    // campo ainda não preenchido (despesa de antes dessa estrutura existir)
    // — tenta reconhecer "parcela N/M" na própria descrição
    if (!parcelaTotal || parcelaTotal <= 1) {
      const detectada = extrairParcelaDaDescricao(d.descricao);
      if (detectada) {
        parcelaAtual = detectada.parcelaAtual;
        parcelaTotal = detectada.parcelaTotal;
      }
    }

    if (!parcelaTotal || parcelaTotal <= 1 || !parcelaAtual) continue; // não é parcelada, ou falta informação pra saber quais parcelas faltam

    // normaliza a identidade da série: sem idParcelamento ainda, essa
    // despesa É a raiz da série
    let idParcelamento = d.idParcelamento;
    const camposMudaram = d.parcelaAtual !== parcelaAtual || d.parcelaTotal !== parcelaTotal || !idParcelamento;
    if (!idParcelamento) idParcelamento = d.id;

    if (camposMudaram) {
      await atualizar('despesa', { ...d, parcelaAtual, parcelaTotal, idParcelamento });
    }

    // mesFatura de referência: da fatura vinculada, quando existir; senão, o
    // mês da própria data real da parcela atual (única informação disponível)
    const fatura = d.faturaId != null ? mapaFatura[d.faturaId] : null;
    const mesFaturaAtual = fatura ? fatura.mesFatura : d.data.slice(0, 7);

    await gerarParcelasFuturasPrevistas({
      cartaoId: d.cartaoId,
      categoriaId: d.categoriaId,
      descricaoBase: d.descricao || '',
      valorParcela: d.valor,
      diaReferencia: diaDoMes(d.data),
      mesFaturaAtual,
      parcelaAtual,
      parcelaTotal,
      idParcelamento
    });
  }
}

// ---------- Importação de fatura real (Despesa → Fatura → Cartão, regra 1) ----------
// Diferente da migração acima (que só ESTIMA e reconstrói o passado), essa
// função é o caminho de dado real: cria (ou reaproveita) a fatura com o
// mesFatura que o usuário confirmou, nunca uma estimativa, e já vincula o
// faturaId nas despesas no mesmo instante em que elas são gravadas — não
// depende de nenhuma migração posterior pra descobrir a qual fatura elas
// pertencem.
async function faturaExistenteParaCartaoMes(cartaoId, mesFatura) {
  const todas = await listarTodos('fatura');
  return todas.find((f) => f.cartaoId === cartaoId && f.mesFatura === mesFatura) || null;
}

// dadosFatura: { cartaoId, mesFatura, vencimento, fechamento, cicloInicio,
// cicloFim, totalOficial, statusPagamento } — mesFatura é o dado informado/
// confirmado pelo usuário na importação, nunca calculado a partir da data das
// compras. itens: [{ valor, data, descricao, categoriaId, parcelaAtual,
// parcelaTotal }] — cada item vira uma despesa já com faturaId, cartaoId e
// statusDespesa: 'confirmado' preenchidos.
//
// Se já existir uma fatura pra esse cartaoId + mesFatura (regra 2: nunca
// duplicar), os itens são vinculados a ela em vez de criar uma nova; o
// totalOficial informado atualiza a fatura existente (é sempre o dado mais
// recente confirmado pelo usuário), e a fatura passa a ser origem:'importada'
// (uma fatura 'migrada' que recebe uma importação real de verdade deixa de
// ser estimativa — ela agora tem dado confirmado pelo usuário). statusPagamento
// NUNCA é alterado aqui — marcar uma fatura como paga é uma ação separada
// (marcarFaturaComoPaga) e não pode ser desfeita por uma nova importação.
async function importarFatura(dadosFatura, itens) {
  const { cartaoId, mesFatura } = dadosFatura;
  if (!cartaoId) throw new Error('importarFatura: cartaoId é obrigatório');
  if (!mesFatura || !/^\d{4}-\d{2}$/.test(mesFatura)) throw new Error('importarFatura: mesFatura precisa estar no formato AAAA-MM');

  const existente = await faturaExistenteParaCartaoMes(cartaoId, mesFatura);
  let faturaId;
  let criada;

  if (existente) {
    faturaId = existente.id;
    criada = false;
    const atualizacao = { ...existente, origem: 'importada' };
    if (dadosFatura.totalOficial !== undefined && dadosFatura.totalOficial !== null) atualizacao.totalOficial = dadosFatura.totalOficial;
    if (dadosFatura.vencimento) atualizacao.vencimento = dadosFatura.vencimento;
    if (dadosFatura.fechamento) atualizacao.fechamento = dadosFatura.fechamento;
    if (dadosFatura.cicloFim) atualizacao.cicloFim = dadosFatura.cicloFim;
    await atualizar('fatura', atualizacao);
  } else {
    faturaId = await adicionar('fatura', {
      cartaoId,
      mesFatura,
      cicloInicio: dadosFatura.cicloInicio ?? null,
      cicloFim: dadosFatura.cicloFim ?? dadosFatura.fechamento ?? null,
      fechamento: dadosFatura.fechamento ?? null,
      vencimento: dadosFatura.vencimento,
      totalOficial: dadosFatura.totalOficial ?? 0,
      statusPagamento: dadosFatura.statusPagamento || 'nao_paga',
      origem: 'importada'
    });
    criada = true;
  }

  const despesaIds = [];
  const revisaoNecessaria = []; // itens que bateram em mais de uma previsão — não mesclados sozinhos, ficam pra conferência manual
  for (const item of itens || []) {
    const { id, precisaRevisao } = await gravarOuReconciliarItemDaFatura(cartaoId, faturaId, mesFatura, item);
    despesaIds.push(id);
    if (precisaRevisao) revisaoNecessaria.push(id);
  }

  return { faturaId, criada, despesaIds, revisaoNecessaria };
}

function diaDoMes(dataISO) {
  return new Date(dataISO).getDate();
}

// Mesmo dia-do-mês da despesa original, projetado pro mês informado —
// clampado ao último dia do mês quando ele tem menos dias (ex.: dia 31
// projetado pra um mês de 30 dias vira dia 30).
function dataProjetadaNoMes(mesISO, dia) {
  const [ano, mes] = mesISO.split('-').map(Number);
  const diasNoMes = new Date(ano, mes, 0).getDate();
  return new Date(ano, mes - 1, Math.min(dia, diasNoMes)).toISOString();
}

// Troca "8/12" por "9/12" (etc.) dentro da descrição original, se o padrão
// aparecer nela; senão só acrescenta a indicação no fim. Usado só pra gerar
// o texto das parcelas PREVISTAS — nunca altera a descrição real gravada
// numa despesa confirmada/importada.
function descricaoComParcelaProjetada(descricaoBase, parcelaOriginal, parcelaProjetada, parcelaTotal) {
  const padrao = new RegExp(`\\b${parcelaOriginal}\\s*/\\s*${parcelaTotal}\\b`);
  if (padrao.test(descricaoBase)) return descricaoBase.replace(padrao, `${parcelaProjetada}/${parcelaTotal}`);
  return `${descricaoBase} (parcela ${parcelaProjetada}/${parcelaTotal} prevista)`;
}

// Regra 3/5/6/7 do pedido de revisão: uma despesa com parcelaTotal > 1 é uma
// compra parcelada. Se o item que está chegando (de uma importação real)
// bate por identidade — mesmo cartão, mesma parcelaTotal, mesma parcelaAtual,
// status 'previsto' — com uma parcela que já tínhamos PREVISTO antes (gerada
// numa importação anterior), ela é RECONCILIADA: a previsão vira confirmada,
// com o valor/data/descrição/faturaId REAIS que acabaram de chegar — nunca
// cria uma segunda despesa pra essa parcela. Se houver mais de uma previsão
// batendo (identidade ambígua), NÃO mescla sozinho — grava como uma despesa
// nova e devolve precisaRevisao:true, pra quem chamou avisar a usuária.
// Depois de gravar/reconciliar, gera (só as que ainda não existem) as
// parcelas FUTURAS como previstas — nunca as passadas (regra 6) — usando o
// mesmo valor da parcela atual como estimativa, até a fatura real de cada
// mês futuro chegar e reconciliar de novo.
async function gravarOuReconciliarItemDaFatura(cartaoId, faturaId, mesFatura, item) {
  const parcelaAtual = item.parcelaAtual ?? 1;
  const parcelaTotal = item.parcelaTotal ?? 1;
  const dadosReais = {
    valor: item.valor,
    categoriaId: item.categoriaId,
    cartaoId,
    faturaId,
    formaPagamento: 'cartao',
    data: item.data,
    descricao: item.descricao || '',
    parcelaAtual,
    parcelaTotal,
    statusDespesa: item.statusDespesa || 'confirmado',
    editadoManualmente: false
  };

  let id;
  let idParcelamento = null;
  let precisaRevisao = false;

  if (parcelaTotal > 1) {
    const todasDespesas = await listarTodos('despesa');
    const candidatas = todasDespesas.filter((d) =>
      d.cartaoId === cartaoId && d.parcelaTotal === parcelaTotal && d.parcelaAtual === parcelaAtual && d.statusDespesa === 'previsto'
    );

    if (candidatas.length === 1) {
      const prevista = candidatas[0];
      idParcelamento = prevista.idParcelamento ?? prevista.id;
      await atualizar('despesa', { ...prevista, ...dadosReais, idParcelamento });
      id = prevista.id;
    } else {
      if (candidatas.length > 1) precisaRevisao = true; // identidade ambígua — não mescla sozinho
      id = await adicionar('despesa', { ...dadosReais, idParcelamento: null });
      idParcelamento = id; // primeira vez que essa série aparece: a própria despesa é a "raiz" da série
      await atualizar('despesa', { ...dadosReais, id, idParcelamento });
    }

    await gerarParcelasFuturasPrevistas({ cartaoId, categoriaId: item.categoriaId, descricaoBase: item.descricao || '', valorParcela: item.valor, diaReferencia: diaDoMes(item.data), mesFaturaAtual: mesFatura, parcelaAtual, parcelaTotal, idParcelamento });
  } else {
    id = await adicionar('despesa', { ...dadosReais, idParcelamento: null });
  }

  return { id, precisaRevisao };
}

// Gera as parcelas parcelaAtual+1 .. parcelaTotal como PREVISTAS, uma por
// mês seguinte, só as que ainda não existem (idempotente: rodar de novo pra
// a mesma parcela confirmada nunca duplica). Nunca gera parcelaAtual pra
// trás (regra 6 — não recriar parcelas passadas: o laço nem começa antes de
// parcelaAtual + 1). Cada uma tem faturaId: null (a fatura real dela ainda
// não existe) — por isso a competência dela usa a própria data projetada
// (ver competenciaDespesa), que é exatamente o mês em que ela é esperada.
async function gerarParcelasFuturasPrevistas({ cartaoId, categoriaId, descricaoBase, valorParcela, diaReferencia, mesFaturaAtual, parcelaAtual, parcelaTotal, idParcelamento }) {
  if (parcelaAtual >= parcelaTotal) return;

  const todasDespesas = await listarTodos('despesa');
  const existentesDaSerie = new Set(
    todasDespesas.filter((d) => d.idParcelamento === idParcelamento).map((d) => d.parcelaAtual)
  );

  for (let k = parcelaAtual + 1; k <= parcelaTotal; k++) {
    if (existentesDaSerie.has(k)) continue; // já existe (prevista de uma rodada anterior, ou já reconciliada) — não duplica

    const mesAlvo = somarMesISO(mesFaturaAtual, k - parcelaAtual);
    await adicionar('despesa', {
      valor: valorParcela,
      categoriaId,
      cartaoId,
      faturaId: null,
      formaPagamento: 'cartao',
      data: dataProjetadaNoMes(mesAlvo, diaReferencia),
      descricao: descricaoComParcelaProjetada(descricaoBase, parcelaAtual, k, parcelaTotal),
      parcelaAtual: k,
      parcelaTotal,
      idParcelamento,
      statusDespesa: 'previsto',
      editadoManualmente: false
    });
  }
}

function fecharBanco() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// Fecha a conexão aberta e só resolve quando o banco for REALMENTE apagado
// (ou depois de um tempo limite, pra nunca travar a usuária numa tela presa)
function apagarBancoCompleto() {
  fecharBanco();
  return new Promise((resolve) => {
    let finalizado = false;
    const finalizar = () => {
      if (finalizado) return;
      finalizado = true;
      resolve();
    };

    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = finalizar;
    req.onerror = finalizar;
    req.onblocked = () => {
      // Alguma outra aba/conexão ainda está com o banco aberto — não trava
      // pra sempre, resolve depois de um tempo mesmo assim
    };
    setTimeout(finalizar, 2000);
  });
}

function transacao(nomeStore, modo = 'readonly') {
  return abrirBanco().then((db) => db.transaction(nomeStore, modo).objectStore(nomeStore));
}

// ---------- CRUD genérico ----------

async function adicionar(nomeStore, objeto) {
  const store = await transacao(nomeStore, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.add(objeto);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function listarTodos(nomeStore) {
  const store = await transacao(nomeStore);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function obterPorId(nomeStore, id) {
  const store = await transacao(nomeStore);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function atualizar(nomeStore, objeto) {
  const store = await transacao(nomeStore, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(objeto);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function remover(nomeStore, id) {
  const store = await transacao(nomeStore, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- Seed inicial ----------

async function limparStore(nomeStore) {
  const todos = await listarTodos(nomeStore);
  for (const item of todos) {
    await remover(nomeStore, item.id);
  }
}

async function seedInicial() {
  const categorias = await listarTodos('categoria');
  if (categorias.length > 0) return; // já foi semeado antes

  // Só as categorias (estrutura de organização) são pré-criadas — nada de
  // cartão, despesa, renda ou reserva fictícios. O app começa 100% zerado.
  // "grupoGrafico" é a coluna do gráfico de Relatórios em que essa categoria
  // entra — categorias novas criadas em "Gerenciar Categorias" também
  // recebem esse campo, e o gráfico se ajusta sozinho.
  await adicionar('categoria', { nome: 'Essenciais', tipo: 'essencial', icone: '🏠', limiteMensal: 1500, grupoGrafico: 'Essenciais' });
  await adicionar('categoria', { nome: 'Alimentação', tipo: 'essencial', icone: '🍴', limiteMensal: 500, grupoGrafico: 'Alimentação' });
  await adicionar('categoria', { nome: 'Transporte', tipo: 'essencial', icone: '🚗', limiteMensal: 400, grupoGrafico: 'Transporte' });
  await adicionar('categoria', { nome: 'Delivery', tipo: 'estilo_de_vida', icone: '🍔', limiteMensal: 200, grupoGrafico: 'Lazer' });
  await adicionar('categoria', { nome: 'Assinaturas', tipo: 'estilo_de_vida', icone: '📺', limiteMensal: 150, grupoGrafico: 'Lazer' });
  await adicionar('categoria', { nome: 'Lazer', tipo: 'estilo_de_vida', icone: '🍿', limiteMensal: 150, grupoGrafico: 'Lazer' });
  await adicionar('categoria', { nome: 'Outros', tipo: 'estilo_de_vida', icone: '💬', limiteMensal: 300, grupoGrafico: 'Outros' });

  await adicionar('renda', { valorMensal: 0, mesReferencia: mesAtualISO() });
  await adicionar('reserva', { valorAtual: 0, meta: 0 });
}

// ---------- Utilidades de data ----------

function mesAtualISO() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
}

function mesAnteriorISO() {
  const hoje = new Date();
  const anterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  return `${anterior.getFullYear()}-${String(anterior.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- Despesas ----------
// ---------- Competência financeira (regra definitiva) ----------
// Três conceitos diferentes, que nunca podem ser confundidos:
//   A) DATA REAL DA TRANSAÇÃO  — quando a compra aconteceu de verdade,
//      preservada exatamente como veio (nunca alterada pra "encaixar" num mês).
//   B) FATURA — a entidade real (Despesa.faturaId → Fatura.mesFatura).
//   C) COMPETÊNCIA FINANCEIRA — o mês ao qual o gasto pertence pros cálculos
//      mensais do app (Saídas, Relatórios, filtro de Período, categorias...).
//
// Regra: despesa de CARTÃO com faturaId vinculado a uma fatura real usa
// fatura.mesFatura como competência (nunca a data real, nunca o fechamento,
// nunca o vencimento). Despesa em DINHEIRO/PIX (sem cartão) e RECEITA usam o
// mês da própria data real. Nada disso depende do nome do banco — só da
// relação estrutural Despesa → Fatura.
function competenciaDespesa(despesa, mapaFatura) {
  if (despesa.cartaoId && despesa.faturaId != null) {
    const fatura = mapaFatura[despesa.faturaId];
    if (fatura) return fatura.mesFatura;
  }
  // dinheiro/pix, ou cartão cuja fatura ainda não foi vinculada (estado
  // transitório) — única informação disponível é a data real
  return despesa.data.slice(0, 7);
}

async function mapaFaturasPorId() {
  const faturas = await listarTodos('fatura');
  return Object.fromEntries(faturas.map((f) => [f.id, f]));
}

async function gastosDoMes(mesISO = mesAtualISO()) {
  const [todas, mapaFatura] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId()]);
  return todas.filter((d) => competenciaDespesa(d, mapaFatura) === mesISO);
}

async function despesasDetalhadas() {
  const [despesas, categorias, cartoes, mapaFatura] = await Promise.all([
    listarTodos('despesa'), listarTodos('categoria'), listarTodos('cartao'), mapaFaturasPorId()
  ]);
  const mapaCategoria = Object.fromEntries(categorias.map((c) => [c.id, c]));
  const mapaCartao = Object.fromEntries(cartoes.map((c) => [c.id, c]));

  return despesas
    .map((d) => ({
      ...d,
      categoriaNome: mapaCategoria[d.categoriaId]?.nome || 'Outros',
      categoriaIcone: mapaCategoria[d.categoriaId]?.icone || '💰',
      cartaoNome: d.cartaoId ? (mapaCartao[d.cartaoId]?.nome || null) : null,
      // regra definitiva: d.valor já É o valor da parcela (ex.: "Parcela 8/12
      // — R$245,27" grava valor:245.27), nunca dividir por parcelaTotal de novo
      valorParcela: d.valor,
      // mês ao qual o gasto pertence financeiramente — nunca o mês da data
      // real quando a despesa é de cartão com fatura vinculada (ver
      // competenciaDespesa acima). A data real exibida na tela NÃO muda.
      mesCompetencia: competenciaDespesa(d, mapaFatura)
    }))
    .sort((a, b) => new Date(b.data) - new Date(a.data));
}

// Regra definitiva: "gasto no mês" = despesas CONFIRMADAS cuja COMPETÊNCIA
// FINANCEIRA (não a data real) cai no mês calendário pedido, somando todos
// os cartões + à vista. Despesa de cartão usa fatura.mesFatura; dinheiro/pix
// usa a data real. Previstos nunca entram.
//
// Categoria órfã (correção do diagnóstico de 23/09): antes, uma despesa cujo
// categoriaId não batia com nenhuma categoria existente (ex.: categoria
// excluída por fora do fluxo normal de exclusão, ou dado antigo) era
// descartada em silêncio daqui — ela nunca aparecia nas barras nem entrava
// no total, mesmo sendo uma despesa confirmada real. Isso divergia de
// saidasConfirmadasDoMes() (usado pelo "Saídas" da Home), que soma TODAS as
// despesas confirmadas do mês sem checar categoria. Agora essa despesa é
// reatribuída para a categoria "Outros" (mesmo destino já usado por
// excluirCategoria() em categorias.js quando uma categoria é apagada pela
// tela de gerenciamento) — nunca é descartada, e nenhuma categoria "Outros"
// nova é criada: reaproveita a que já existe, buscando por nome. Só no caso
// extremo de nem "Outros" existir mais (banco sem seed nenhum) é que uma
// entrada temporária, só em memória, é usada — nada é gravado no IndexedDB
// por isso.
async function gastosPorCategoria(mesISO = mesAtualISO()) {
  const categorias = await listarTodos('categoria');
  const mapa = {};
  categorias.forEach((c) => { mapa[c.id] = { ...c, total: 0, itens: [] }; });

  const outros = categorias.find((c) => c.nome === 'Outros');
  const idFallback = outros ? outros.id : 'outros_fallback_memoria';
  if (!mapa[idFallback]) {
    mapa[idFallback] = { id: null, nome: 'Outros', icone: '💬', tipo: 'estilo_de_vida', total: 0, itens: [] };
  }

  const [todasDespesas, mapaFatura] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId()]);
  const relevantes = todasDespesas.filter((d) =>
    d.statusDespesa === 'confirmado' && competenciaDespesa(d, mapaFatura) === mesISO
  );

  relevantes.forEach((d) => {
    const destino = mapa[d.categoriaId] ? d.categoriaId : idFallback;
    mapa[destino].total += d.valor;
    mapa[destino].itens.push({ ...d, valorParcela: d.valor });
  });

  return Object.values(mapa).sort((a, b) => b.total - a.total);
}

async function totalGastoNoMes(mesISO = mesAtualISO()) {
  const categorias = await gastosPorCategoria(mesISO);
  return categorias.reduce((soma, c) => soma + c.total, 0);
}

// ---------- Histórico mensal (regra 5) ----------
// Lista todos os meses "AAAA-MM" entre mesInicioISO e mesFimISO, inclusive,
// em ordem crescente. Não assume nada sobre o tamanho do intervalo.
function mesesEntre(mesInicioISO, mesFimISO) {
  const meses = [];
  let atual = mesInicioISO;
  let guarda = 0; // trava de segurança pra nunca entrar em loop infinito
  while (atual <= mesFimISO && guarda < 1000) {
    meses.push(atual);
    atual = somarMesISO(atual, 1);
    guarda++;
  }
  return meses;
}

// Total gasto por COMPETÊNCIA FINANCEIRA, mês a mês, respeitando a mesma
// regra definitiva de sempre: despesa de cartão com faturaId usa
// fatura.mesFatura; sem faturaId usa a data real; só despesas confirmadas
// entram. Reaproveita totalGastoNoMes (já correto) pra cada mês do
// intervalo — não recalcula a regra de competência de novo. Usado pela visão
// "Julho/2026, Agosto/2026, Setembro/2026..." em Relatórios, que é uma visão
// ADICIONAL — não substitui o gráfico diário do mês atual.
async function historicoGastosMensais(mesInicioISO, mesFimISO = mesAtualISO()) {
  const meses = mesesEntre(mesInicioISO, mesFimISO);
  const totais = await Promise.all(meses.map((mesISO) => totalGastoNoMes(mesISO)));
  return meses.map((mesISO, i) => ({ mesISO, total: totais[i] }));
}

// Evolução diária: o eixo continua sendo o DIA REAL da transação (isso não
// muda — a data real nunca é alterada), mas o CONJUNTO de despesas somadas
// é filtrado pela competência financeira do mês selecionado, não pelo mês
// da data real. Uma despesa de cartão com competência em agosto, mas com
// data real em setembro, entra na evolução de agosto (no dia do mês
// correspondente à sua data real), nunca na de setembro.
async function gastosDiariosDoMes(mesISO = mesAtualISO()) {
  const despesas = (await gastosDoMes(mesISO)).filter((d) => d.statusDespesa === 'confirmado');
  const [ano, mes] = mesISO.split('-').map(Number);
  const diasNoMes = new Date(ano, mes, 0).getDate();
  const porDia = new Array(diasNoMes).fill(0);

  despesas.forEach((d) => {
    const dia = new Date(d.data).getDate();
    if (dia >= 1 && dia <= diasNoMes) porDia[dia - 1] += d.valor;
  });

  return porDia;
}

// "Comprometimento do cartão" (regra 8/9 da revisão): precisa representar
// quanto do cartão está comprometido NO MÊS SEGUINTE ao atual — um único
// mês, nunca a soma de todas as parcelas futuras restantes como se fossem
// cobradas de uma vez só (isso inflava o percentual: 4 parcelas futuras de
// R$245,27 viravam R$981,08 contra a renda de 1 mês só). O nome da função e
// o texto em motor.js ("comprometem X% da sua renda do PRÓXIMO MÊS") já
// deixavam esse conceito claro — só a implementação não filtrava por mês
// nenhum. Usa a MESMA regra de competência financeira de sempre
// (competenciaDespesa, a mesma função usada em gastosPorCategoria,
// historicoGastosMensais, saídas etc. — nunca uma lógica de mês separada só
// pra esse indicador): uma parcela com faturaId vinculado usa
// fatura.mesFatura; senão, o mês da própria data (que, pra uma prevista
// recém-gerada, já É a projeção dela pro mês certo). Só conta despesas que
// são parcela de verdade (parcelaTotal > 1) — regra 10: uma parcela já
// confirmada em outro mês (ex.: 8/12 em agosto) nunca é recontada aqui,
// porque a competência dela não é o mês seguinte.
async function parcelasProximoMes() {
  const mesSeguinte = somarMesISO(mesAtualISO(), 1);
  const [todas, mapaFatura] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId()]);
  return todas
    .filter((d) => d.parcelaTotal > 1 && competenciaDespesa(d, mapaFatura) === mesSeguinte)
    .reduce((soma, d) => soma + d.valor, 0); // d.valor já é o valor da parcela individual (regra 4), nunca dividir de novo
}

// ---------- Receitas ----------

async function receitasDoMes(mesISO = mesAtualISO()) {
  const todas = await listarTodos('receita');
  return todas.filter((r) => r.data.slice(0, 7) === mesISO);
}

async function totalReceitasAvulsasNoMes(mesISO = mesAtualISO()) {
  const receitas = await receitasDoMes(mesISO);
  return receitas.reduce((soma, r) => soma + r.valor, 0);
}

async function rendaAtual(mesISO = mesAtualISO()) {
  const rendas = await listarTodos('renda');
  const atual = rendas.find((r) => r.mesReferencia === mesISO);
  return atual ? atual.valorMensal : 0;
}

async function entradasTotaisDoMes(mesISO = mesAtualISO()) {
  const renda = await rendaAtual(mesISO);
  const avulsas = await totalReceitasAvulsasNoMes(mesISO);
  return renda + avulsas;
}

// ---------- Cartões ----------

// ---------- Fatura (entidade real — Despesa → Fatura → Cartão) ----------
// A partir da v5, "qual é a fatura atual/próxima de um cartão" nunca mais é
// calculado a partir de cartão + dia de fechamento estimado + data de hoje.
// É sempre consultado nos registros reais da store 'fatura' (importados ou
// reconstruídos pela migração). Regra 19/20 da especificação definitiva.

async function faturasPorCartao(cartaoId) {
  const todas = await listarTodos('fatura');
  return todas.filter((f) => f.cartaoId === cartaoId);
}

async function despesasDaFatura(faturaId) {
  const todas = await listarTodos('despesa');
  return todas.filter((d) => d.faturaId === faturaId);
}

// Classifica TODAS as faturas existentes em 'proxima' (não paga, vencimento
// no futuro), 'vencida' (não paga, vencimento já passou — antes isso fazia
// a fatura sumir da tela mostrando R$0,00; agora ela continua visível, só
// marcada como vencida) ou 'quitada' (statusPagamento = 'paga'). Fatura não
// paga NUNCA significa valor R$0,00 (regra 11): o valor mostrado é sempre
// faturaOficial, nunca recalculado.
async function faturasClassificadas() {
  const [faturas, cartoes] = await Promise.all([listarTodos('fatura'), listarTodos('cartao')]);
  const mapaCartao = Object.fromEntries(cartoes.map((c) => [c.id, c]));
  const hoje = new Date();

  return faturas
    .map((f) => {
      const cartao = mapaCartao[f.cartaoId];
      const vencimento = new Date(f.vencimento);
      let situacao;
      if (f.statusPagamento === 'paga') situacao = 'quitada';
      else situacao = vencimento < hoje ? 'vencida' : 'proxima';
      const diasRestantes = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));
      return { ...f, cartaoNome: cartao ? cartao.nome : 'Cartão removido', vencimento, diasRestantes, situacao };
    })
    .sort((a, b) => a.vencimento - b.vencimento);
}

// Pra cada cartão, a fatura que deve aparecer em destaque na Home/detalhe:
// a mais recente entre as não pagas (próxima ou vencida); se todas estiverem
// pagas, a última paga; se o cartão não tiver nenhuma fatura ainda (nunca
// foi importada), retorna null — a tela deve mostrar "fatura ainda não
// importada", nunca inventar R$0,00 disfarçado de valor real.
async function faturaEmDestaquePorCartao(cartaoId) {
  const todas = await faturasClassificadas();
  const doCartao = todas.filter((f) => f.cartaoId === cartaoId);
  if (doCartao.length === 0) return null;

  const naoPagas = doCartao.filter((f) => f.situacao !== 'quitada').sort((a, b) => a.vencimento - b.vencimento);
  if (naoPagas.length > 0) return naoPagas[0];

  return doCartao.sort((a, b) => b.vencimento - a.vencimento)[0];
}

// Marca/desmarca uma fatura como paga. Altera SOMENTE statusPagamento da
// própria fatura — nunca mexe em despesas, valores, datas, mesFatura,
// faturaId, statusDespesa, nem cria parcela ou fatura nova. Funciona pra
// qualquer fatura de qualquer cartão/banco (não depende do nome do banco).
async function marcarFaturaComoPaga(faturaId) {
  const fatura = await obterPorId('fatura', faturaId);
  if (!fatura) return null;
  const atualizada = { ...fatura, statusPagamento: 'paga' };
  await atualizar('fatura', atualizada);
  return atualizada;
}

async function desmarcarFaturaComoPaga(faturaId) {
  const fatura = await obterPorId('fatura', faturaId);
  if (!fatura) return null;
  const atualizada = { ...fatura, statusPagamento: 'nao_paga' };
  await atualizar('fatura', atualizada);
  return atualizada;
}

// Correção 1/4 da homologação (revisão cirúrgica): confirma o
// fechamento/vencimento REAIS de uma fatura que já existe — mesmo já paga.
// Não é inferência nem estimativa: é o dado que a própria usuária confirma
// depois de conferir na fatura do banco. Existe porque uma fatura 'migrada'
// que já foi marcada como paga nunca mais é reprocessada pela migração
// (migrarFaturasParaV5 só reprocessa migrada+não paga, de propósito, pra
// nunca sobrescrever o pagamento) — então, se ela foi criada com uma
// estimativa antiga (baseada no dia de fechamento/vencimento que o CARTÃO
// tinha configurado NAQUELE momento) e essa configuração do cartão mudou
// depois, a fatura fica congelada com o valor velho pra sempre, a menos que
// alguém confirme o dado real aqui. Só mexe em fechamento/vencimento/
// origem — nunca em totalOficial, statusPagamento, despesas vinculadas,
// mesFatura ou cartaoId.
async function corrigirDatasFatura(faturaId, { fechamento, vencimento }) {
  const fatura = await obterPorId('fatura', faturaId);
  if (!fatura) return null;
  const atualizada = { ...fatura, fechamento, vencimento, origem: 'importada' };
  await atualizar('fatura', atualizada);
  return atualizada;
}

async function cartoesComResumo() {
  const cartoes = await listarTodos('cartao');
  const resultado = [];
  for (const c of cartoes) {
    const fatura = await faturaEmDestaquePorCartao(c.id);
    const valorFatura = fatura ? fatura.totalOficial : 0;
    const percentualUsado = fatura && c.limite > 0 ? (valorFatura / c.limite) * 100 : 0;
    resultado.push({ ...c, fatura, valorFatura, percentualUsado });
  }
  return resultado;
}

// ---------- Reserva de emergência (aportes) ----------

async function adicionarAporte(valor, descricao = 'Aporte na reserva') {
  await adicionar('aporte', { valor, descricao, data: new Date().toISOString() });

  const reservas = await listarTodos('reserva');
  const reserva = reservas[0] || { valorAtual: 0, meta: 0 };
  const novoValor = reserva.valorAtual + valor;

  if (reservas[0]) {
    await atualizar('reserva', { ...reservas[0], valorAtual: novoValor });
  } else {
    await adicionar('reserva', { valorAtual: novoValor, meta: 0 });
  }
  return novoValor;
}

async function historicoAportes() {
  const aportes = await listarTodos('aporte');
  aportes.sort((a, b) => new Date(a.data) - new Date(b.data));

  let acumulado = 0;
  return aportes.map((a) => {
    acumulado += a.valor;
    return { ...a, acumulado };
  });
}

// ---------- Saldo em caixa vs. gasto no cartão ----------
// O saldo do mês reflete DINHEIRO DE VERDADE disponível: uma compra no
// cartão de crédito não sai do bolso na hora, só quando a fatura vence.
// "Gastos por categoria" e os relatórios continuam somando TODO gasto
// (cartão incluso) — isso é análise de comportamento, não saldo em caixa.

async function despesasAVistaDoMes(mesISO = mesAtualISO()) {
  const todas = await listarTodos('despesa');
  return todas
    .filter((d) => !d.cartaoId && d.statusDespesa === 'confirmado' && d.data.slice(0, 7) === mesISO)
    .reduce((soma, d) => soma + d.valor, 0);
}

// Regra definitiva: Saídas da Home = soma das despesas CONFIRMADAS cuja
// COMPETÊNCIA FINANCEIRA pertence ao mês calendário exibido, de todos os
// cartões (genérico — nunca lógica específica por cartão). Despesa de
// cartão usa fatura.mesFatura; dinheiro/pix usa a data real. Um lançamento
// como "Espaço Laser, data real 12/09, fatura de agosto" conta como saída
// de AGOSTO, nunca de setembro — mesmo aparecendo na tela com a data real
// de 12/09 (a data exibida não muda, só o mês em que ele é somado).
async function saidasConfirmadasDoMes(mesISO = mesAtualISO()) {
  const [todas, mapaFatura] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId()]);
  return todas
    .filter((d) => d.statusDespesa === 'confirmado' && competenciaDespesa(d, mapaFatura) === mesISO)
    .reduce((soma, d) => soma + d.valor, 0);
}

async function saldoDisponivelDoMes(mesISO = mesAtualISO()) {
  const entradas = await entradasTotaisDoMes(mesISO);
  const aVista = await despesasAVistaDoMes(mesISO);
  const saidas = await saidasConfirmadasDoMes(mesISO);
  return { entradas, saidas, saldo: entradas - saidas, aVista };
}

async function totalDespesasEntre(dataInicio, dataFim) {
  const todas = await listarTodos('despesa');
  return todas
    .filter((d) => {
      if (d.statusDespesa !== 'confirmado') return false;
      const t = new Date(d.data).getTime();
      return t >= dataInicio.getTime() && t <= dataFim.getTime();
    })
    .reduce((soma, d) => soma + d.valor, 0);
}

async function houveDespesaHoje() {
  const todas = await listarTodos('despesa');
  const hoje = new Date();
  return todas.some((d) => {
    const data = new Date(d.data);
    return data.getFullYear() === hoje.getFullYear() && data.getMonth() === hoje.getMonth() && data.getDate() === hoje.getDate();
  });
}

// Remove despesas duplicadas (mesmo valor, data, descrição, cartão e
// categoria) — útil quando uma importação acaba rodando duas vezes.
// Mantém sempre a primeira ocorrência de cada uma.
async function removerDespesasDuplicadas() {
  const despesas = await listarTodos('despesa');

  // Agrupa despesas idênticas (valor + data + descrição, arredondando o
  // valor pra centavos pra evitar diferenças escondidas de ponto flutuante)
  const grupos = new Map();
  for (const d of despesas) {
    const chave = [Math.round(d.valor * 100), d.data.slice(0, 10), d.descricao].join('|');
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(d);
  }

  const idsParaRemover = [];
  for (const grupo of grupos.values()) {
    if (grupo.length <= 1) continue;

    // Dentro de cada grupo de duplicatas, mantém a cópia vinculada a um
    // cartão (mais provável de ser "a certa") em vez de uma solta como
    // Dinheiro/Pix — evita que a limpeza jogue fora a versão correta
    const ordenado = [...grupo].sort((a, b) => (b.cartaoId ? 1 : 0) - (a.cartaoId ? 1 : 0));
    for (let i = 1; i < ordenado.length; i++) idsParaRemover.push(ordenado[i].id);
  }

  for (const id of idsParaRemover) {
    await remover('despesa', id);
  }

  return idsParaRemover.length;
}

// Importa um backup completo (gerado por "Exportar meus dados") — recria
// exatamente como estava no backup, preservando os IDs originais pra manter
// as relações entre despesa/cartão/categoria/fatura intactas. Usado tanto
// pra "clonar" o estado de um aparelho no outro quanto pra restaurar depois
// de uma limpeza de dados do navegador (já que não existe sincronização
// automática — o app é 100% local).
//
// ORDEM restaurada: categoria, cartao, renda, reserva, receita, fatura,
// despesa, aporte. 'fatura' e 'aporte' precisam estar aqui — antes desta
// correção a lista não incluía 'fatura', então um backup restaurado por
// esta função perdia silenciosamente mesFatura/totalOficial/statusPagamento/
// origem de toda fatura (Despesa → Fatura → Cartão), mesmo já estando
// corretamente presentes no JSON exportado (exportarDados, em mais.js, já
// inclui 'fatura' desde antes desta correção).
const STORES_RESTAURAVEIS = ['categoria', 'cartao', 'renda', 'reserva', 'receita', 'fatura', 'despesa', 'aporte'];
// 'aporte' é opcional: a versão atual de exportarDados ainda não o inclui,
// então um backup real pode legitimamente não trazer essa store.
const STORES_OBRIGATORIAS_BACKUP = ['categoria', 'cartao', 'despesa', 'renda', 'reserva', 'receita', 'fatura'];

// Valida a estrutura do JSON inteiro ANTES de qualquer escrita no banco.
// Não corrige nem inventa nada — só aponta o que está fora do esperado.
function validarBackup(dados) {
  const erros = [];
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) {
    return { valido: false, erros: ['O arquivo não é um objeto JSON de backup válido.'] };
  }

  for (const nomeStore of STORES_OBRIGATORIAS_BACKUP) {
    if (!(nomeStore in dados)) {
      erros.push(`Store obrigatória ausente no backup: "${nomeStore}".`);
      continue;
    }
    if (!Array.isArray(dados[nomeStore])) {
      erros.push(`Store "${nomeStore}" precisa ser uma lista (array) no backup — veio ${typeof dados[nomeStore]}.`);
      continue;
    }
    for (const registro of dados[nomeStore]) {
      if (!registro || typeof registro !== 'object' || registro.id === undefined || registro.id === null) {
        erros.push(`Existe um registro sem "id" válido na store "${nomeStore}" — não dá pra preservar relacionamentos sem o id original.`);
        break;
      }
    }
  }

  if (dados.aporte !== undefined && !Array.isArray(dados.aporte)) {
    erros.push('Store "aporte" está presente no backup mas não é uma lista (array).');
  }

  // Integridade relacional: toda despesa.cartaoId/categoriaId/faturaId,
  // quando presente, precisa apontar pra um id que existe dentro do PRÓPRIO
  // backup — só avisa, nunca corrige ou remove nada sozinho.
  if (Array.isArray(dados.despesa) && Array.isArray(dados.cartao) && Array.isArray(dados.categoria) && Array.isArray(dados.fatura)) {
    const idsCartao = new Set(dados.cartao.map((c) => c.id));
    const idsCategoria = new Set(dados.categoria.map((c) => c.id));
    const idsFatura = new Set(dados.fatura.map((f) => f.id));
    for (const d of dados.despesa) {
      if (d.cartaoId != null && !idsCartao.has(d.cartaoId)) erros.push(`despesa id ${d.id}: cartaoId ${d.cartaoId} não existe entre os cartões do backup.`);
      if (d.categoriaId != null && !idsCategoria.has(d.categoriaId)) erros.push(`despesa id ${d.id}: categoriaId ${d.categoriaId} não existe entre as categorias do backup.`);
      if (d.faturaId != null && !idsFatura.has(d.faturaId)) erros.push(`despesa id ${d.id}: faturaId ${d.faturaId} não existe entre as faturas do backup.`);
    }
  }

  return { valido: erros.length === 0, erros };
}

async function contagemPorStore() {
  const contagem = {};
  for (const nomeStore of STORES_RESTAURAVEIS) {
    contagem[nomeStore] = (await listarTodos(nomeStore)).length;
  }
  return contagem;
}

// Monta um retrato genérico (sem citar nenhum banco específico) das faturas
// e das séries de parcelamento restauradas, pra dar pra usuária conferir
// visualmente os valores reais contra o backup — nunca afirma um valor
// esperado, só mostra o que está gravado.
async function relatorioFaturasEParcelamentos() {
  const [faturas, despesas] = await Promise.all([listarTodos('fatura'), listarTodos('despesa')]);
  const listaFaturas = faturas.map((f) => ({
    id: f.id, cartaoId: f.cartaoId, mesFatura: f.mesFatura,
    totalOficial: f.totalOficial, statusPagamento: f.statusPagamento, origem: f.origem,
    fechamento: f.fechamento, vencimento: f.vencimento
  }));

  const series = new Map();
  for (const d of despesas) {
    if (!(d.parcelaTotal > 1)) continue;
    const chave = d.idParcelamento ?? `sem-idParcelamento-${d.id}`;
    if (!series.has(chave)) series.set(chave, []);
    series.get(chave).push({
      id: d.id, parcelaAtual: d.parcelaAtual, parcelaTotal: d.parcelaTotal,
      statusDespesa: d.statusDespesa, valor: d.valor, data: d.data, faturaId: d.faturaId
    });
  }
  const listaSeries = [...series.entries()].map(([idParcelamento, parcelas]) => ({
    idParcelamento,
    parcelas: parcelas.sort((a, b) => a.parcelaAtual - b.parcelaAtual)
  }));

  return { faturas: listaFaturas, seriesDeParcelamento: listaSeries };
}

// Restaura um backup completo. Regras (pedido explícito da usuária):
// 1) valida o JSON inteiro antes de escrever qualquer coisa;
// 2) se o banco atual já tiver QUALQUER dado, não sobrescreve sozinho —
//    devolve status 'aguardando_confirmacao' com as contagens dos dois
//    lados, e só substitui de fato quando chamada de novo com
//    confirmarSubstituicao:true (segunda ação explícita da usuária na UI);
// 3) preserva IDs originais (usa put via atualizar(), nunca gera um id novo);
// 4) não recalcula valor nem altera data de nenhum registro;
// 5) depois de escrever os dados, reprocessa as migrações existentes (na
//    mesma ordem que abrirBanco() já usa) — elas já tinham rodado contra o
//    banco vazio antes da restauração, então precisam rodar de novo agora
//    que os dados reais estão lá. Todas as três são idempotentes (mesma
//    trava de sempre, nunca duplicam).
// 6) NUNCA chama indexedDB.deleteDatabase() (nem via apagarBancoCompleto) —
//    mesmo na substituição já confirmada, a limpeza é feita store a store
//    com limparStore() (delete registro a registro, a mesma função que já
//    existe pra "Limpar despesas de exemplo"), nunca apagando o banco inteiro.
async function restaurarBackup(dados, opcoes = {}) {
  const confirmarSubstituicao = opcoes.confirmarSubstituicao === true;

  const validacao = validarBackup(dados);
  if (!validacao.valido) {
    return { status: 'invalido', erros: validacao.erros };
  }

  await abrirBanco();
  const contagemAtual = await contagemPorStore();
  const existeDadoAtual = Object.values(contagemAtual).some((n) => n > 0);

  if (existeDadoAtual && !confirmarSubstituicao) {
    const contagemBackup = {};
    for (const nomeStore of STORES_RESTAURAVEIS) contagemBackup[nomeStore] = (dados[nomeStore] || []).length;
    return { status: 'aguardando_confirmacao', contagemAtual, contagemBackup };
  }

  if (existeDadoAtual) {
    for (const nomeStore of STORES_RESTAURAVEIS) await limparStore(nomeStore);
  }

  const contagemRestaurada = {};
  for (const nomeStore of STORES_RESTAURAVEIS) {
    const registros = dados[nomeStore] || [];
    for (const registro of registros) {
      await atualizar(nomeStore, registro); // put — preserva o id original, nunca gera um novo
    }
    contagemRestaurada[nomeStore] = registros.length;
  }

  const despesasAntesDaMigracao = (await listarTodos('despesa')).length;
  await migrarDespesasParaV4();
  await migrarFaturasParaV5();
  await migrarParcelamentosExistentes();
  const despesasDepoisDaMigracao = (await listarTodos('despesa')).length;

  const contagemDepois = await contagemPorStore();
  const relatorioFaturas = await relatorioFaturasEParcelamentos();

  return {
    status: 'restaurado',
    contagemAntes: contagemAtual,
    contagemRestaurada,
    contagemDepois,
    parcelasGeradasPelaMigracao: despesasDepoisDaMigracao - despesasAntesDaMigracao,
    ...relatorioFaturas
  };
}

async function importarDadosCompletos(dados) {
  return restaurarBackup(dados, { confirmarSubstituicao: true });
}

const DB = {
  abrirBanco, fecharBanco, apagarBancoCompleto, limparStore, seedInicial, adicionar, listarTodos, obterPorId, atualizar, remover,
  gastosDoMes, gastosPorCategoria, totalGastoNoMes, gastosDiariosDoMes, parcelasProximoMes,
  rendaAtual, receitasDoMes, totalReceitasAvulsasNoMes, entradasTotaisDoMes,
  cartoesComResumo, faturasPorCartao, despesasDaFatura, faturasClassificadas, faturaEmDestaquePorCartao,
  marcarFaturaComoPaga, desmarcarFaturaComoPaga, corrigirDatasFatura,
  mesAtualISO, mesAnteriorISO, somarMesISO, despesasDetalhadas, totalDespesasEntre, houveDespesaHoje,
  adicionarAporte, historicoAportes, despesasAVistaDoMes, saidasConfirmadasDoMes, saldoDisponivelDoMes,
  competenciaDespesa, removerDespesasDuplicadas, importarDadosCompletos,
  faturaExistenteParaCartaoMes, importarFatura, migrarFaturasParaV5, migrarDespesasParaV4,
  mesesEntre, historicoGastosMensais, migrarParcelamentosExistentes, extrairParcelaDaDescricao,
  validarBackup, restaurarBackup, contagemPorStore, relatorioFaturasEParcelamentos
};

if (typeof window !== 'undefined') window.DB = DB;
if (typeof module !== 'undefined') module.exports = DB;
