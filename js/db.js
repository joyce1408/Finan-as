// db.js
// Toda a persistência do app roda aqui, 100% local no dispositivo via IndexedDB.
// Nenhuma dessas funções faz chamada de rede.

const DB_NAME = 'financas_db';
const DB_VERSION = 3;

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
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => reject(event.target.error);
  });
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
      valorParcela: d.valor / (d.parcelaTotal || 1)
    }))
    .sort((a, b) => new Date(b.data) - new Date(a.data));
}

async function gastosPorCategoria(mesISO = mesAtualISO()) {
  const despesas = await gastosDoMes(mesISO);
  const categorias = await listarTodos('categoria');
  const mapa = {};

  categorias.forEach((c) => { mapa[c.id] = { ...c, total: 0, itens: [] }; });

  despesas.forEach((d) => {
    const parcela = d.valor / (d.parcelaTotal || 1);
    if (mapa[d.categoriaId]) {
      mapa[d.categoriaId].total += parcela;
      mapa[d.categoriaId].itens.push({ ...d, valorParcela: parcela });
    }
  });

  return Object.values(mapa).sort((a, b) => b.total - a.total);
}

async function totalGastoNoMes(mesISO = mesAtualISO()) {
  const despesas = await gastosDoMes(mesISO);
  return despesas.reduce((soma, d) => soma + d.valor / (d.parcelaTotal || 1), 0);
}

async function gastosDiariosDoMes(mesISO = mesAtualISO()) {
  const despesas = await gastosDoMes(mesISO);
  const [ano, mes] = mesISO.split('-').map(Number);
  const diasNoMes = new Date(ano, mes, 0).getDate();
  const porDia = new Array(diasNoMes).fill(0);

  despesas.forEach((d) => {
    const dia = new Date(d.data).getDate();
    porDia[dia - 1] += d.valor / (d.parcelaTotal || 1);
  });

  return porDia;
}

// parcelas de compras parceladas que ainda vão cair no próximo mês
async function parcelasProximoMes() {
  const todas = await listarTodos('despesa');
  return todas
    .filter((d) => d.parcelaTotal > 1 && d.parcelaAtual < d.parcelaTotal)
    .reduce((soma, d) => soma + d.valor / d.parcelaTotal, 0);
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

async function proximasFaturas() {
  const cartoes = await listarTodos('cartao');
  const hoje = new Date();

  return cartoes
    .map((c) => {
      let vencimento = new Date(hoje.getFullYear(), hoje.getMonth(), c.diaVencimento);
      if (vencimento < hoje) vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 1, c.diaVencimento);
      const diasRestantes = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));
      return { ...c, vencimento, diasRestantes };
    })
    .sort((a, b) => a.diasRestantes - b.diasRestantes);
}

async function valorFaturaCartao(cartaoId, mesISO = mesAtualISO()) {
  const despesas = await gastosDoMes(mesISO);
  return despesas
    .filter((d) => d.cartaoId === cartaoId)
    .reduce((soma, d) => soma + d.valor / (d.parcelaTotal || 1), 0);
}

async function cartoesComResumo() {
  const cartoes = await listarTodos('cartao');
  const resultado = [];
  for (const c of cartoes) {
    const valorFatura = await valorFaturaCartao(c.id);
    const percentualUsado = c.limite > 0 ? (valorFatura / c.limite) * 100 : 0;
    resultado.push({ ...c, valorFatura, percentualUsado });
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
  const despesas = await gastosDoMes(mesISO);
  return despesas
    .filter((d) => !d.cartaoId)
    .reduce((soma, d) => soma + d.valor / (d.parcelaTotal || 1), 0);
}

// Determina em qual mês (mesISO) a fatura de um cartão específico deve ser
// paga, considerando o dia de fechamento: compra feita ATÉ o fechamento cai
// na fatura deste mesmo mês; compra feita DEPOIS do fechamento cai na fatura
// do mês seguinte (é assim que cartão de crédito de verdade funciona).
// Retorna as DESPESAS (não só a soma) que pertencem ao ciclo de fatura de um
// cartão — mesma regra de faturaDevidaNoMes, mas devolvendo os registros
// completos, pra telas que precisam listar item por item.
async function despesasDoCicloFatura(cartaoId, mesISO = mesAtualISO()) {
  const cartao = await obterPorId('cartao', cartaoId);
  if (!cartao) return [];

  const todas = await listarTodos('despesa');
  const [ano, mes] = mesISO.split('-').map(Number);
  const mesAnteriorData = new Date(ano, mes - 2, 1);
  const chaveAnterior = `${mesAnteriorData.getFullYear()}-${String(mesAnteriorData.getMonth() + 1).padStart(2, '0')}`;

  return todas.filter((d) => {
    if (d.cartaoId !== cartaoId) return false;
    const dia = new Date(d.data).getDate();
    const chaveDaDespesa = d.data.slice(0, 7);
    if (chaveDaDespesa === mesISO && dia <= cartao.diaFechamento) return true;
    if (chaveDaDespesa === chaveAnterior && dia > cartao.diaFechamento) return true;
    return false;
  });
}

async function faturaDevidaNoMes(cartaoId, mesISO) {
  const cartao = await obterPorId('cartao', cartaoId);
  if (!cartao) return 0;

  const todas = await listarTodos('despesa');
  const [ano, mes] = mesISO.split('-').map(Number);
  const mesAnteriorData = new Date(ano, mes - 2, 1); // mes-2: Date usa mês 0-indexado, e queremos o mês anterior a mesISO
  const chaveAnterior = `${mesAnteriorData.getFullYear()}-${String(mesAnteriorData.getMonth() + 1).padStart(2, '0')}`;

  return todas
    .filter((d) => d.cartaoId === cartaoId)
    .filter((d) => {
      const dia = new Date(d.data).getDate();
      const chaveDaDespesa = d.data.slice(0, 7);
      // comprou até o dia de fechamento, no próprio mês de referência → entra na fatura deste mês
      if (chaveDaDespesa === mesISO && dia <= cartao.diaFechamento) return true;
      // comprou depois do fechamento, no mês anterior → "empurra" pra fatura deste mês
      if (chaveDaDespesa === chaveAnterior && dia > cartao.diaFechamento) return true;
      return false;
    })
    .reduce((soma, d) => soma + d.valor / (d.parcelaTotal || 1), 0);
}

async function faturasVencendoNoMes(mesISO = mesAtualISO()) {
  const cartoes = await listarTodos('cartao');
  let total = 0;
  for (const c of cartoes) {
    total += await faturaDevidaNoMes(c.id, mesISO);
  }
  return total;
}

async function saldoDisponivelDoMes(mesISO = mesAtualISO()) {
  const entradas = await entradasTotaisDoMes(mesISO);
  const aVista = await despesasAVistaDoMes(mesISO);
  const faturas = await faturasVencendoNoMes(mesISO);
  const saidas = aVista + faturas;
  return { entradas, saidas, saldo: entradas - saidas, aVista, faturas };
}

async function totalDespesasEntre(dataInicio, dataFim) {
  const todas = await listarTodos('despesa');
  return todas
    .filter((d) => {
      const t = new Date(d.data).getTime();
      return t >= dataInicio.getTime() && t <= dataFim.getTime();
    })
    .reduce((soma, d) => soma + d.valor / (d.parcelaTotal || 1), 0);
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
  const vistos = new Map();
  const idsParaRemover = [];

  for (const d of despesas) {
    const chave = [d.valor, d.data, d.descricao, d.cartaoId, d.categoriaId, d.parcelaAtual, d.parcelaTotal].join('|');
    if (vistos.has(chave)) {
      idsParaRemover.push(d.id);
    } else {
      vistos.set(chave, d.id);
    }
  }

  for (const id of idsParaRemover) {
    await remover('despesa', id);
  }

  return idsParaRemover.length;
}

window.DB = {
  abrirBanco, fecharBanco, apagarBancoCompleto, limparStore, seedInicial, adicionar, listarTodos, obterPorId, atualizar, remover,
  gastosDoMes, gastosPorCategoria, totalGastoNoMes, gastosDiariosDoMes, parcelasProximoMes,
  rendaAtual, receitasDoMes, totalReceitasAvulsasNoMes, entradasTotaisDoMes,
  proximasFaturas, valorFaturaCartao, cartoesComResumo,
  mesAtualISO, mesAnteriorISO, despesasDetalhadas, totalDespesasEntre, houveDespesaHoje,
  adicionarAporte, historicoAportes, despesasAVistaDoMes, faturaDevidaNoMes, faturasVencendoNoMes, saldoDisponivelDoMes,
  despesasDoCicloFatura, removerDespesasDuplicadas
};
