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

  // agrupa cada despesa de cartão no mesmo "mês da fatura" estimado que a
  // lógica antiga usava: comprou até o dia de fechamento estimado → fatura
  // do próprio mês da compra; comprou depois → fatura do mês seguinte
  const grupos = new Map(); // chave "cartaoId|mesFatura" -> despesas[]
  for (const d of comCartao) {
    const cartao = mapaCartao[d.cartaoId];
    if (!cartao) { await atualizar('despesa', { ...d, faturaId: null }); continue; }

    const dia = new Date(d.data).getDate();
    const mesDaCompra = d.data.slice(0, 7);
    const diaFechamentoEstimado = cartao.diaFechamento || 1;
    const mesFaturaEstimado = dia <= diaFechamentoEstimado ? mesDaCompra : somarMesISO(mesDaCompra, 1);

    const chave = `${d.cartaoId}|${mesFaturaEstimado}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(d);
  }

  for (const [chave, despesasDoGrupo] of grupos) {
    const [cartaoIdTexto, mesFatura] = chave.split('|');
    const cartaoId = Number(cartaoIdTexto);
    const cartao = mapaCartao[cartaoId];

    // fechamento/vencimento estimados: aplica o dia de fechamento/vencimento
    // já cadastrado no cartão sobre o mês da fatura estimado — é a mesma
    // estimativa que já existia, só que agora fica guardada na fatura em vez
    // de recalculada toda hora
    const [ano, mes] = mesFatura.split('-').map(Number);
    const fechamentoEstimado = new Date(ano, mes - 1, cartao.diaFechamento || 1).toISOString();
    const mesVencimento = somarMesISO(mesFatura, 1);
    const [anoVenc, mesVenc] = mesVencimento.split('-').map(Number);
    const vencimentoEstimado = new Date(anoVenc, mesVenc - 1, cartao.diaVencimento || 10).toISOString();

    const totalEstimado = despesasDoGrupo.reduce((soma, d) => soma + d.valor, 0);

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

async function gastosDoMes(mesISO = mesAtualISO()) {
  const todas = await listarTodos('despesa');
  return todas.filter((d) => d.data.slice(0, 7) === mesISO);
}

async function despesasDetalhadas() {
  const despesas = await listarTodos('despesa');
  const categorias = await listarTodos('categoria');
  const cartoes = await listarTodos('cartao');
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
      valorParcela: d.valor
    }))
    .sort((a, b) => new Date(b.data) - new Date(a.data));
}

// Regra definitiva (item 12/13 da especificação): "gasto no mês" = despesas
// CONFIRMADAS cuja DATA REAL DA TRANSAÇÃO cai no mês calendário pedido,
// somando todos os cartões + à vista. Não usa mais ciclo de fatura nenhum
// pra decidir o que entra aqui — mês da transação e mês da fatura são
// conceitos diferentes, e essa função é sobre o mês da transação. Previstos
// nunca entram.
async function gastosPorCategoria(mesISO = mesAtualISO()) {
  const categorias = await listarTodos('categoria');
  const mapa = {};
  categorias.forEach((c) => { mapa[c.id] = { ...c, total: 0, itens: [] }; });

  const todasDespesas = await listarTodos('despesa');
  const relevantes = todasDespesas.filter((d) =>
    d.statusDespesa === 'confirmado' && d.data.slice(0, 7) === mesISO
  );

  relevantes.forEach((d) => {
    if (mapa[d.categoriaId]) {
      mapa[d.categoriaId].total += d.valor;
      mapa[d.categoriaId].itens.push({ ...d, valorParcela: d.valor });
    }
  });

  return Object.values(mapa).sort((a, b) => b.total - a.total);
}

async function totalGastoNoMes(mesISO = mesAtualISO()) {
  const categorias = await gastosPorCategoria(mesISO);
  return categorias.reduce((soma, c) => soma + c.total, 0);
}

async function gastosDiariosDoMes(mesISO = mesAtualISO()) {
  const despesas = (await gastosDoMes(mesISO)).filter((d) => d.statusDespesa === 'confirmado');
  const [ano, mes] = mesISO.split('-').map(Number);
  const diasNoMes = new Date(ano, mes, 0).getDate();
  const porDia = new Array(diasNoMes).fill(0);

  despesas.forEach((d) => {
    const dia = new Date(d.data).getDate();
    porDia[dia - 1] += d.valor;
  });

  return porDia;
}

// parcelas PREVISTAS (ainda não confirmadas) de compras parceladas — usado
// pro alerta de comprometimento futuro. d.valor já é o valor de cada parcela
// individual, nunca dividir por parcelaTotal de novo (regra 4).
async function parcelasProximoMes() {
  const todas = await listarTodos('despesa');
  return todas
    .filter((d) => d.parcelaTotal > 1 && d.parcelaAtual < d.parcelaTotal && d.statusDespesa !== 'confirmado')
    .reduce((soma, d) => soma + d.valor, 0);
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

// Regra definitiva 12: Saídas da Home = soma das despesas CONFIRMADAS cuja
// DATA REAL DA TRANSAÇÃO pertence ao mês calendário exibido, de todos os
// cartões (genérico — nunca lógica específica por cartão). Mês da fatura e
// mês da transação são conceitos diferentes: essa soma usa só a data da
// transação, nunca o faturaId nem o ciclo/vencimento da fatura.
async function saidasConfirmadasDoMes(mesISO = mesAtualISO()) {
  const todas = await listarTodos('despesa');
  return todas
    .filter((d) => d.statusDespesa === 'confirmado' && d.data.slice(0, 7) === mesISO)
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

// Importa um backup completo (gerado por "Exportar meus dados") — apaga tudo
// que existe no aparelho atual e recria exatamente como estava no backup,
// preservando os IDs originais pra manter as relações entre despesa/cartão/
// categoria intactas. Usado pra "clonar" o estado de um aparelho no outro,
// já que não existe sincronização automática (o app é 100% local).
async function importarDadosCompletos(dados) {
  await apagarBancoCompleto();
  await abrirBanco(); // reabre já recriando os object stores vazios

  const ordem = ['categoria', 'cartao', 'renda', 'reserva', 'receita', 'despesa'];
  for (const nomeStore of ordem) {
    const registros = dados[nomeStore] || [];
    for (const registro of registros) {
      const store = await transacao(nomeStore, 'readwrite');
      await new Promise((resolve, reject) => {
        const req = store.add(registro);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
  }
}

window.DB = {
  abrirBanco, fecharBanco, apagarBancoCompleto, limparStore, seedInicial, adicionar, listarTodos, obterPorId, atualizar, remover,
  gastosDoMes, gastosPorCategoria, totalGastoNoMes, gastosDiariosDoMes, parcelasProximoMes,
  rendaAtual, receitasDoMes, totalReceitasAvulsasNoMes, entradasTotaisDoMes,
  cartoesComResumo, faturasPorCartao, despesasDaFatura, faturasClassificadas, faturaEmDestaquePorCartao,
  mesAtualISO, mesAnteriorISO, somarMesISO, despesasDetalhadas, totalDespesasEntre, houveDespesaHoje,
  adicionarAporte, historicoAportes, despesasAVistaDoMes, saidasConfirmadasDoMes, saldoDisponivelDoMes,
  removerDespesasDuplicadas, importarDadosCompletos
};
