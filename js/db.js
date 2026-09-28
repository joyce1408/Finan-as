// db.js
// Toda a persistência do app roda aqui, 100% local no dispositivo via IndexedDB.
// Nenhuma dessas funções faz chamada de rede.
//
// Arquitetura: Despesa → Fatura → Cartão.
// COMPETÊNCIA FINANCEIRA (regra central, ver competenciaDespesa):
//   • despesa com faturaId → fatura.mesFatura (a data real NÃO decide);
//   • despesa prevista (parcela futura) → competenciaPrevista;
//   • despesa sem fatura (Pix, dinheiro, débito, boleto) → mês da data real;
//   • receita → mês da data da receita.
// A data real de uma compra nunca é alterada para "encaixar" num mês.
//
// Datas financeiras são dias "AAAA-MM-DD" (ver js/datas.js). Registros
// antigos gravados como instante UTC continuam gravados como estão e são
// interpretados na leitura, sem depender do fuso do aparelho.
//
// Segurança do banco: nenhuma função deste arquivo apaga o banco, apaga
// stores ou recria o banco, exceto apagarBancoCompleto(), que só roda por
// ação explícita e dupla confirmação da pessoa em "Apagar todos os dados".

const _Datas = (typeof module !== 'undefined' && typeof require === 'function') ? require('./datas.js') : window.Datas;
const _Cat = (typeof module !== 'undefined' && typeof require === 'function') ? require('./categorizacao.js') : window.Categorizacao;

const DB_NAME = 'financas_db';
const DB_VERSION = 6;

// keyPath de cada store (usado por limparStore/backup, que precisam saber a
// chave de cada registro)
const CHAVE_DA_STORE = {
  categoria: 'id', cartao: 'id', despesa: 'id', renda: 'id', reserva: 'id',
  receita: 'id', aporte: 'id', fatura: 'id', meta: 'chave'
};

let conexaoPromessa = null;
let prontoPromessa = null;
let conexaoAtual = null;

function obterConexao() {
  if (conexaoPromessa) return conexaoPromessa;
  conexaoPromessa = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;

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
      // v2 — receitas avulsas
      if (!db.objectStoreNames.contains('receita')) {
        const store = db.createObjectStore('receita', { keyPath: 'id', autoIncrement: true });
        store.createIndex('data', 'data', { unique: false });
      }
      // v3 — aportes na reserva
      if (!db.objectStoreNames.contains('aporte')) {
        const store = db.createObjectStore('aporte', { keyPath: 'id', autoIncrement: true });
        store.createIndex('data', 'data', { unique: false });
      }
      // v4 — fatura (fundação)
      if (!db.objectStoreNames.contains('fatura')) {
        const store = db.createObjectStore('fatura', { keyPath: 'id', autoIncrement: true });
        store.createIndex('cartaoId', 'cartaoId', { unique: false });
      }
      const despesaStore = tx.objectStore('despesa');
      if (!despesaStore.indexNames.contains('idParcelamento')) despesaStore.createIndex('idParcelamento', 'idParcelamento', { unique: false });
      if (!despesaStore.indexNames.contains('statusDespesa')) despesaStore.createIndex('statusDespesa', 'statusDespesa', { unique: false });
      // v5 — fatura como entidade real
      const faturaStore = tx.objectStore('fatura');
      if (faturaStore.indexNames.contains('mesISO')) faturaStore.deleteIndex('mesISO'); // índice (não dado) nunca usado
      if (!faturaStore.indexNames.contains('mesFatura')) faturaStore.createIndex('mesFatura', 'mesFatura', { unique: false });
      if (!despesaStore.indexNames.contains('faturaId')) despesaStore.createIndex('faturaId', 'faturaId', { unique: false });
      // v6 — store 'meta': registros de controle e LOG das migrações (o que
      // foi alterado, quando e de quê para quê). Nenhuma store é apagada.
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'chave' });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      // outra aba abrindo uma versão nova do app: libera a conexão em vez de
      // travar a atualização do schema
      db.onversionchange = () => { try { db.close(); } catch (e) { /* já fechada */ } conexaoPromessa = null; prontoPromessa = null; conexaoAtual = null; };
      conexaoAtual = db;
      resolve(db);
    };
    request.onerror = (event) => { conexaoPromessa = null; reject(event.target.error); };
  });
  return conexaoPromessa;
}

// Abre o banco e roda as migrações (todas idempotentes, nenhuma destrutiva)
// uma única vez por abertura. Todas as telas chamam esta função antes de ler.
function abrirBanco() {
  if (!prontoPromessa) {
    prontoPromessa = obterConexao().then(async (db) => {
      await executarMigracoes();
      return db;
    }).catch((erro) => { prontoPromessa = null; throw erro; });
  }
  return prontoPromessa;
}

async function executarMigracoes() {
  const etapas = [
    ['v4_statusDespesa', migrarDespesasParaV4],
    ['v5_faturas', migrarFaturasParaV5],
    ['v6_categorias', migrarCategoriasV6],
    ['parcelamentos', migrarParcelamentosExistentes],
    ['correcao_2026_09_confirmada', aplicarCorrecaoConfirmada202609]
  ];
  for (const [nome, fn] of etapas) {
    try {
      await fn();
    } catch (erro) {
      // uma migração com erro não impede o app de abrir; fica registrada
      // para diagnóstico e roda de novo na próxima abertura (idempotente)
      if (typeof console !== 'undefined') console.error(`Migração ${nome} falhou:`, erro);
      try { await gravarMeta(`erro_migracao_${nome}`, { em: new Date().toISOString(), mensagem: String(erro && erro.message || erro) }); } catch (e) { /* sem meta */ }
    }
  }
}

function fecharBanco() {
  if (conexaoAtual) { try { conexaoAtual.close(); } catch (e) { /* já fechada */ } }
  conexaoAtual = null;
  conexaoPromessa = null;
  prontoPromessa = null;
}

// Apaga o banco inteiro. SÓ é chamada por "Apagar todos os dados" (dupla
// confirmação da pessoa) e pelo "esqueci PIN e chave". Nunca automaticamente.
function apagarBancoCompleto() {
  fecharBanco();
  return new Promise((resolve) => {
    let finalizado = false;
    const finalizar = () => { if (!finalizado) { finalizado = true; resolve(); } };
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = finalizar;
    req.onerror = finalizar;
    req.onblocked = () => {};
    setTimeout(finalizar, 2000);
  });
}

async function transacao(nomeStore, modo = 'readonly') {
  const db = await obterConexao();
  return db.transaction(nomeStore, modo).objectStore(nomeStore);
}

// ---------- CRUD genérico ----------

function executar(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function adicionar(nomeStore, objeto) { return executar((await transacao(nomeStore, 'readwrite')).add(objeto)); }
async function listarTodos(nomeStore) { return executar((await transacao(nomeStore)).getAll()); }
async function obterPorId(nomeStore, id) { return executar((await transacao(nomeStore)).get(id)); }
async function atualizar(nomeStore, objeto) { return executar((await transacao(nomeStore, 'readwrite')).put(objeto)); }
async function remover(nomeStore, id) { await executar((await transacao(nomeStore, 'readwrite')).delete(id)); }

async function limparStore(nomeStore) {
  const chave = CHAVE_DA_STORE[nomeStore] || 'id';
  const todos = await listarTodos(nomeStore);
  for (const item of todos) await remover(nomeStore, item[chave]);
}

async function lerMeta(chave) {
  const reg = await obterPorId('meta', chave);
  return reg ? reg.valor : undefined;
}

async function gravarMeta(chave, valor) {
  await atualizar('meta', { chave, valor });
}

// Acrescenta entradas a um log de migração (nunca sobrescreve o histórico).
async function registrarLog(chave, entradas) {
  if (!entradas || entradas.length === 0) return;
  const atual = (await lerMeta(chave)) || [];
  await gravarMeta(chave, atual.concat(entradas));
}

// ---------- Utilidades de data (delegam para js/datas.js) ----------

function mesAtualISO() { return _Datas.mesAtualISO(); }
function mesAnteriorISO() { return _Datas.somarMesISO(_Datas.mesAtualISO(), -1); }
function somarMesISO(mesISO, delta) { return _Datas.somarMesISO(mesISO, delta); }
function mesesEntre(inicio, fim) { return _Datas.mesesEntre(inicio, fim); }
function diaDe(valor) { return _Datas.diaFinanceiro(valor); }
function mesDe(valor) { return _Datas.mesFinanceiro(valor); }
function centavos(v) { return Math.round(Number(v) * 100); }

// ---------- Categorias ----------

function categoriaAtiva(c) { return c && c.ativa !== false; }

async function listarCategoriasAtivas() {
  const todas = await listarTodos('categoria');
  const ordem = _Cat.NOMES_DEFINITIVOS;
  return todas.filter(categoriaAtiva).sort((a, b) => {
    const ia = ordem.indexOf(a.nome); const ib = ordem.indexOf(b.nome);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.id - b.id;
  });
}

async function idCategoriaPorNome(nome) {
  const todas = await listarTodos('categoria');
  const alvo = _Cat.normalizar(nome);
  const achada = todas.filter(categoriaAtiva).find((c) => _Cat.normalizar(c.nome) === alvo);
  return achada ? achada.id : null;
}

// Categoria sugerida pela descrição (id), sempre uma das 11.
async function sugerirCategoria(descricao) {
  const { categoria, regra } = _Cat.categorizarDescricao(descricao);
  const id = await idCategoriaPorNome(categoria);
  return { categoriaId: id !== null ? id : await idCategoriaPorNome('Outros'), nome: categoria, regra };
}

// ---------- Seed inicial ----------
// Só a estrutura: as 11 categorias definitivas, renda 0 e reserva sem meta.
// Nada de cartão, despesa ou valor fictício.
async function seedInicial() {
  const categorias = await listarTodos('categoria');
  if (categorias.length === 0) await garantirTaxonomia();
  if ((await listarTodos('renda')).length === 0) await adicionar('renda', { valorMensal: 0, mesReferencia: mesAtualISO() });
  if ((await listarTodos('reserva')).length === 0) await adicionar('reserva', { valorAtual: 0, meta: 0 });
}

// Garante que as 11 categorias definitivas existam e estejam ativas.
// Reaproveita o registro (e o id) de uma categoria que já tem exatamente o
// nome definitivo. Devolve { nomeDefinitivo → id }.
async function garantirTaxonomia() {
  const categorias = (await listarTodos('categoria')).sort((a, b) => a.id - b.id);
  const idPorNome = {};
  for (const def of _Cat.CATEGORIAS_DEFINITIVAS) {
    const existente = categorias.find((c) => _Cat.nomeDefinitivoPorNome(c.nome) === def.nome && !c.substituidaPor);
    const campos = {
      nome: def.nome,
      natureza: def.natureza,
      tipo: def.natureza === 'discricionaria' ? 'estilo_de_vida' : 'essencial',
      ativa: true,
      definitiva: true
    };
    if (existente) {
      const atualizado = { ...existente, ...campos, icone: existente.icone || def.icone };
      if (JSON.stringify(atualizado) !== JSON.stringify(existente)) await atualizar('categoria', atualizado);
      idPorNome[def.nome] = existente.id;
    } else {
      idPorNome[def.nome] = await adicionar('categoria', { ...campos, icone: def.icone });
    }
  }
  return idPorNome;
}

// ---------- Migração v4: campos de status ----------
async function migrarDespesasParaV4() {
  const todasDespesas = await listarTodos('despesa');
  for (const d of todasDespesas) {
    if (d.statusDespesa !== undefined) continue;
    await atualizar('despesa', {
      ...d,
      statusDespesa: 'confirmado',
      idParcelamento: d.idParcelamento ?? null,
      editadoManualmente: d.editadoManualmente ?? false
    });
  }
}

// ---------- Faturas: regras de ciclo a partir do cartão ----------

// Mês da fatura (competência) de uma compra feita no cartão, pela regra do
// sistema: compra até o dia de fechamento → fecha no próprio mês; depois →
// fecha no mês seguinte. A fatura que FECHA no mês M é a fatura de
// competência M−1 (ex.: BB fecha dia 3; compra em 01/09 → fecha 03/09 →
// fatura de agosto). Sem dia de fechamento cadastrado → null (sem regra,
// não inventa).
function mesFaturaParaCompra(cartao, dataCompra) {
  if (!cartao || !cartao.diaFechamento) return null;
  const dia = diaDe(dataCompra);
  if (!dia) return null;
  const mesCompra = dia.slice(0, 7);
  const diaFechamentoNoMes = Math.min(cartao.diaFechamento, _Datas.diasNoMes(mesCompra));
  const mesFechamento = Number(dia.slice(8, 10)) <= diaFechamentoNoMes ? mesCompra : somarMesISO(mesCompra, 1);
  return somarMesISO(mesFechamento, -1);
}

// Fechamento/vencimento ESTIMADOS de uma fatura a partir do cartão (só usado
// quando não existe dado real importado/confirmado).
function datasEstimadasDaFatura(cartao, mesFatura) {
  const mesFechamento = somarMesISO(mesFatura, 1);
  const diaFech = cartao.diaFechamento || 1;
  const diaVenc = cartao.diaVencimento || diaFech;
  const fechamento = _Datas.diaNoMes(mesFechamento, diaFech);
  const mesVencimento = diaVenc > diaFech ? mesFechamento : somarMesISO(mesFechamento, 1);
  return { fechamento, vencimento: _Datas.diaNoMes(mesVencimento, diaVenc) };
}

async function faturaExistenteParaCartaoMes(cartaoId, mesFatura) {
  const todas = await listarTodos('fatura');
  return todas.filter((f) => f.cartaoId === cartaoId && f.mesFatura === mesFatura).sort((a, b) => a.id - b.id)[0] || null;
}

// Fatura (existente ou nova "aberta") para um lançamento MANUAL no cartão.
async function obterOuCriarFaturaParaCompra(cartaoId, dataCompra) {
  const cartao = await obterPorId('cartao', cartaoId);
  const mesFatura = mesFaturaParaCompra(cartao, dataCompra);
  if (!mesFatura) return null;
  const existente = await faturaExistenteParaCartaoMes(cartaoId, mesFatura);
  if (existente) return existente;
  const { fechamento, vencimento } = datasEstimadasDaFatura(cartao, mesFatura);
  const id = await adicionar('fatura', {
    cartaoId, mesFatura, cicloInicio: null, cicloFim: fechamento, fechamento, vencimento,
    totalOficial: 0, statusPagamento: 'nao_paga', origem: 'aberta'
  });
  return obterPorId('fatura', id);
}

// ---------- Migração v5: vincular despesas antigas a faturas ----------
// NÃO destrutiva: só trata despesas que nunca passaram por aqui
// (faturaId === undefined). Nunca apaga, recria ou renumera fatura.
// (A versão anterior apagava e recriava faturas "migradas" não pagas a cada
// abertura — isso mudava IDs e foi removido.)
async function migrarFaturasParaV5() {
  const todasDespesas = await listarTodos('despesa');
  const pendentes = todasDespesas.filter((d) => d.faturaId === undefined);
  if (pendentes.length === 0) return;

  const cartoes = await listarTodos('cartao');
  const mapaCartao = Object.fromEntries(cartoes.map((c) => [c.id, c]));
  const mesAtual = mesAtualISO();

  for (const d of pendentes) {
    const cartao = d.cartaoId ? mapaCartao[d.cartaoId] : null;
    if (!cartao || d.statusDespesa === 'previsto') {
      await atualizar('despesa', { ...d, faturaId: null });
      continue;
    }
    // estimativa histórica (a mesma que o sistema usava): dia de fechamento
    // do cartão, ou 1 quando nunca foi cadastrado; o fechamento estimado
    // nunca passa do mês atual (compra antiga não fecha no futuro)
    const cartaoEstimado = { ...cartao, diaFechamento: cartao.diaFechamento || 1 };
    let mesFatura = mesFaturaParaCompra(cartaoEstimado, d.data);
    if (somarMesISO(mesFatura, 1) > mesAtual) mesFatura = somarMesISO(mesAtual, -1);

    let fatura = await faturaExistenteParaCartaoMes(cartao.id, mesFatura);
    if (!fatura) {
      const { fechamento, vencimento } = datasEstimadasDaFatura(cartaoEstimado, mesFatura);
      const id = await adicionar('fatura', {
        cartaoId: cartao.id, mesFatura, cicloInicio: null, cicloFim: fechamento, fechamento, vencimento,
        totalOficial: 0, statusPagamento: 'nao_paga', origem: 'migrada'
      });
      fatura = await obterPorId('fatura', id);
    }
    await atualizar('despesa', { ...d, faturaId: fatura.id });
    if (fatura.origem === 'migrada') await recalcularFatura(fatura.id);
  }
}

// ---------- Migração v6: taxonomia definitiva de categorias ----------
// 1) garante as 11 categorias definitivas;
// 2) despesas em categorias antigas (Essenciais, Delivery, Fast Food /
//    Delivery, Saúde / Medicamentos, personalizadas...) ou em categoria
//    inexistente vão para a categoria definitiva por regra determinística
//    (Categorizacao.destinoMigracao);
// 3) as categorias antigas ficam INATIVAS (ativa:false, substituidaPor) —
//    o registro não é apagado, só deixa de aparecer;
// 4) despesas em "Outros" que NÃO foram categorizadas à mão recebem a
//    categorização automática por descrição.
// Só muda categoriaId. Nunca muda valor, data, fatura, competência, cartão
// ou parcelamento. Cada mudança fica registrada no log
// meta['log_migracao_categorias_v6'] (despesa, de, para, motivo), o que
// permite conferir e desfazer.
async function migrarCategoriasV6() {
  const temDados = (await listarTodos('categoria')).length > 0 || (await listarTodos('despesa')).length > 0;
  if (!temDados) return; // banco novo: o seed cria a taxonomia
  const idPorNome = await garantirTaxonomia();
  const categorias = await listarTodos('categoria');
  const mapaCategoria = Object.fromEntries(categorias.map((c) => [c.id, c]));
  const idsDefinitivos = new Set(Object.values(idPorNome));
  const nomePorIdDefinitivo = Object.fromEntries(Object.entries(idPorNome).map(([n, id]) => [id, n]));
  const agora = new Date().toISOString();
  const log = [];

  const despesas = await listarTodos('despesa');
  for (const d of despesas) {
    const atual = mapaCategoria[d.categoriaId];
    let destino = null;

    if (!atual) {
      destino = _Cat.destinoMigracao('', d.descricao);
      destino.motivo = `categoria_inexistente(${d.categoriaId}) → ${destino.motivo}`;
    } else if (!idsDefinitivos.has(atual.id)) {
      destino = _Cat.destinoMigracao(atual.nome, d.descricao);
    } else if (nomePorIdDefinitivo[atual.id] === 'Outros' && !_Cat.categoriaEhManual(d) && d.tipoLancamento !== 'ajuste_fatura') {
      const auto = _Cat.categorizarDescricao(d.descricao);
      if (auto.categoria !== 'Outros') destino = { categoria: auto.categoria, motivo: `automatica:${auto.regra}` };
    }

    if (!destino) continue;
    const novoId = idPorNome[destino.categoria];
    if (novoId === d.categoriaId) continue;
    await atualizar('despesa', {
      ...d,
      categoriaId: novoId,
      categoriaAnteriorId: d.categoriaAnteriorId ?? (d.categoriaId ?? null),
      categoriaAutomatica: true
    });
    log.push({ em: agora, despesaId: d.id, de: atual ? atual.nome : `(inexistente ${d.categoriaId})`, para: destino.categoria, motivo: destino.motivo });
  }

  for (const c of categorias) {
    if (idsDefinitivos.has(c.id) || c.ativa === false) continue;
    const def = _Cat.nomeDefinitivoPorNome(c.nome);
    const n = _Cat.normalizar(c.nome);
    const substituidaPor = def || _Cat.MAPA_LEGADO[n] || 'categorizacao_por_descricao';
    await atualizar('categoria', { ...c, ativa: false, arquivadaEm: agora, substituidaPor });
    log.push({ em: agora, categoriaId: c.id, categoriaDesativada: c.nome, substituidaPor });
  }

  await registrarLog('log_migracao_categorias_v6', log);
}

// ---------- Correção confirmada pelo usuário em 28/09/2026 ----------
// Dados REAIS confirmados explicitamente pelo usuário (não inferidos):
//  • fatura 117 (Nubank, 2026-08, total oficial R$245,27) e fatura 121
//    (Banco do Brasil, 2026-08, total oficial R$1.362,07) são faturas com
//    total oficial confirmado → origem 'importada' (estavam 'migrada');
//  • cartão Banco do Brasil: fechamento dia 3, vencimento dia 15;
//  • fatura 121: fechamento 03/09/2026, vencimento 15/09/2026.
// Só muda esses campos. Não muda IDs, mesFatura (competência), totais,
// status de pagamento, despesas, faturaId, parcelamentos, valores ou datas
// de compra, e não recalcula ajuste. Só age quando os registros batem
// EXATAMENTE com os dados confirmados (id, cartão, mês e total); em
// qualquer outro banco não faz nada. Idempotente: depois de aplicada, as
// condições deixam de bater. O antes/depois fica em
// meta['log_correcao_2026_09_confirmada'].
async function aplicarCorrecaoConfirmada202609() {
  // roda uma única vez: se depois o cartão for alterado de novo pela
  // pessoa, esta correção nunca desfaz essa escolha
  if (await lerMeta('correcao_2026_09_confirmada_aplicada')) return;
  const f117 = await obterPorId('fatura', 117);
  const f121 = await obterPorId('fatura', 121);
  const cartaoBB = f121 ? await obterPorId('cartao', f121.cartaoId) : null;
  const log = [];
  const agora = new Date().toISOString();

  const bate117 = f117 && f117.mesFatura === '2026-08' && centavos(f117.totalOficial) === 24527;
  const bate121 = f121 && f121.origem === 'migrada' && f121.mesFatura === '2026-08' && centavos(f121.totalOficial) === 136207 &&
    cartaoBB && _Cat.normalizar(cartaoBB.nome) === 'banco do brasil';
  const cartao117 = bate117 ? await obterPorId('cartao', f117.cartaoId) : null;

  if (bate117 && cartao117 && _Cat.normalizar(cartao117.nome) === 'nubank' && f117.origem === 'migrada') {
    const novo = { ...f117, origem: 'importada', totalConfirmadoEm: '2026-09-28' };
    await atualizar('fatura', novo);
    log.push({ em: agora, registro: 'fatura 117', antes: f117, depois: novo });
  }
  if (bate121) {
    const alvo = { ...f121, origem: 'importada', fechamento: '2026-09-03', cicloFim: '2026-09-03', vencimento: '2026-09-15', datasConfirmadas: true, totalConfirmadoEm: '2026-09-28' };
    await atualizar('fatura', alvo);
    log.push({ em: agora, registro: 'fatura 121', antes: f121, depois: alvo });
    if (cartaoBB.diaFechamento !== 3 || cartaoBB.diaVencimento !== 15) {
      const novoCartao = { ...cartaoBB, diaFechamento: 3, diaVencimento: 15 };
      await atualizar('cartao', novoCartao);
      log.push({ em: agora, registro: `cartao ${cartaoBB.id}`, antes: cartaoBB, depois: novoCartao });
    }
  }
  await registrarLog('log_correcao_2026_09_confirmada', log);
  if (log.length > 0) await gravarMeta('correcao_2026_09_confirmada_aplicada', agora);
}

// ---------- Parcelamentos ----------

function extrairParcelaDaDescricao(descricao) {
  if (!descricao) return null;
  const m = descricao.match(/parc(?:ela)?\.?\s*(\d{1,2})\s*\/\s*(\d{1,2})/i);
  if (!m) return null;
  const parcelaAtual = parseInt(m[1], 10);
  const parcelaTotal = parseInt(m[2], 10);
  if (!parcelaAtual || !parcelaTotal || parcelaAtual < 1 || parcelaTotal < 2 || parcelaAtual > parcelaTotal) return null;
  return { parcelaAtual, parcelaTotal };
}

// Troca "8/12" por "9/12" dentro da descrição; senão acrescenta a indicação.
function descricaoComParcelaProjetada(descricaoBase, parcelaOriginal, parcelaProjetada, parcelaTotal) {
  const padrao = new RegExp(`\\b0?${parcelaOriginal}\\s*/\\s*${parcelaTotal}\\b`);
  if (padrao.test(descricaoBase)) return descricaoBase.replace(padrao, `${parcelaProjetada}/${parcelaTotal}`);
  return `${descricaoBase} (parcela ${parcelaProjetada}/${parcelaTotal} prevista)`;
}

// Gera as parcelas parcelaAtual+1 .. parcelaTotal da série como PREVISTAS,
// uma por mês de fatura seguinte, só as que ainda não existem (idempotente).
// NUNCA gera parcelas anteriores à conhecida. Cada prevista guarda sua
// competência (competenciaPrevista) explicitamente e não tem faturaId até a
// fatura real dela chegar e ser reconciliada.
async function gerarParcelasFuturasPrevistas({ cartaoId, categoriaId, descricaoBase, valorParcela, diaReferencia, mesFaturaAtual, parcelaAtual, parcelaTotal, idParcelamento, chaveSerieOrigem }) {
  if (!idParcelamento || parcelaAtual >= parcelaTotal) return 0;
  const todasDespesas = await listarTodos('despesa');
  const existentes = new Set(todasDespesas.filter((d) => d.idParcelamento === idParcelamento).map((d) => d.parcelaAtual));
  let criadas = 0;
  for (let k = parcelaAtual + 1; k <= parcelaTotal; k++) {
    if (existentes.has(k)) continue;
    const mesAlvo = somarMesISO(mesFaturaAtual, k - parcelaAtual);
    await adicionar('despesa', {
      valor: valorParcela,
      categoriaId,
      cartaoId,
      faturaId: null,
      formaPagamento: 'cartao',
      data: _Datas.diaNoMes(mesAlvo, diaReferencia),
      dataProjetada: true,
      competenciaPrevista: mesAlvo,
      descricao: descricaoComParcelaProjetada(descricaoBase, parcelaAtual, k, parcelaTotal),
      parcelaAtual: k,
      parcelaTotal,
      idParcelamento,
      // estabelecimento de origem da série: continua identificando a série
      // mesmo que a pessoa renomeie a descrição da previsão
      chaveSerie: chaveSerieOrigem || _Cat.chaveEstabelecimento(descricaoBase),
      statusDespesa: 'previsto',
      origemLancamento: 'previsao',
      editadoManualmente: false,
      categoriaManual: false
    });
    criadas++;
  }
  return criadas;
}

// Parcelamentos que já existiam antes desta lógica: toda parcela CONFIRMADA
// ganha idParcelamento (o próprio id quando ainda não tem) e as parcelas
// FUTURAS que faltam como previstas. Roda uma vez por parcela (marca
// previsoesGeradas), para não recriar uma prevista que a pessoa excluiu.
async function migrarParcelamentosExistentes() {
  const todasDespesas = await listarTodos('despesa');
  const mapaFatura = await mapaFaturasPorId();
  for (const d of todasDespesas) {
    if (d.statusDespesa !== 'confirmado' || d.pendenteReconciliacao || d.previsoesGeradas === true) continue;
    let { parcelaAtual, parcelaTotal } = d;
    if (!parcelaTotal || parcelaTotal <= 1) {
      const detectada = extrairParcelaDaDescricao(d.descricao);
      if (detectada) ({ parcelaAtual, parcelaTotal } = detectada);
    }
    if (!parcelaTotal || parcelaTotal <= 1 || !parcelaAtual) continue;

    const idParcelamento = d.idParcelamento || d.id;
    await gerarParcelasFuturasPrevistas({
      cartaoId: d.cartaoId,
      categoriaId: d.categoriaId,
      descricaoBase: d.descricao || '',
      valorParcela: d.valor,
      diaReferencia: _Datas.diaDoMes(d.data),
      mesFaturaAtual: competenciaDespesa(d, mapaFatura),
      parcelaAtual,
      parcelaTotal,
      idParcelamento
    });
    const atual = await obterPorId('despesa', d.id);
    await atualizar('despesa', { ...atual, parcelaAtual, parcelaTotal, idParcelamento, previsoesGeradas: true });
  }
}

function estabelecimentosCompativeis(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const menor = a.length <= b.length ? a : b;
  const maior = a.length <= b.length ? b : a;
  return menor.length >= 5 && maior.startsWith(menor);
}

// Reconciliação de UMA parcela real que chegou numa fatura importada.
// Identidade da parcela = idParcelamento + parcelaAtual. Como a fatura do
// banco não traz o idParcelamento, a SÉRIE é localizada entre as previsões
// existentes por: mesmo cartão, mesma parcelaTotal, mesma parcelaAtual,
// estabelecimento compatível e competência prevista = mês da fatura (±1).
// Havendo mais de uma série possível, desempata pelo mês exato e depois pelo
// valor; séries indistinguíveis (mesma loja, mesmo valor, mesmo mês) recebem
// as parcelas reais pela ordem do idParcelamento, uma para cada — nenhuma é
// perdida e nenhuma é duplicada. Se ainda assim for ambíguo (valores
// diferentes e nenhum igual), grava a parcela real SEM série
// (pendenteReconciliacao) e pede revisão: nunca mescla no chute.
async function gravarParcelaDaFatura(cartaoId, fatura, item, parcelaAtual, parcelaTotal, jaUsadasNestaImportacao) {
  const loja = _Cat.chaveEstabelecimento(item.descricao);
  const todas = await listarTodos('despesa');
  let candidatas = todas.filter((d) =>
    d.statusDespesa === 'previsto' && d.cartaoId === cartaoId && d.idParcelamento &&
    d.parcelaTotal === parcelaTotal && d.parcelaAtual === parcelaAtual &&
    !jaUsadasNestaImportacao.has(d.id) &&
    estabelecimentosCompativeis(d.chaveSerie || _Cat.chaveEstabelecimento(d.descricao), loja)
  ).map((d) => ({ d, mes: d.competenciaPrevista || mesDe(d.data) }))
    .filter(({ mes }) => mes === fatura.mesFatura || mes === somarMesISO(fatura.mesFatura, -1) || mes === somarMesISO(fatura.mesFatura, 1));

  if (candidatas.length > 1) {
    const mesmoMes = candidatas.filter((c) => c.mes === fatura.mesFatura);
    if (mesmoMes.length > 0) candidatas = mesmoMes;
  }
  if (candidatas.length > 1) {
    const mesmoValor = candidatas.filter((c) => centavos(c.d.valor) === centavos(item.valor));
    if (mesmoValor.length > 0) candidatas = mesmoValor;
  }

  let escolhida = null;
  let ambigua = false;
  if (candidatas.length === 1) {
    escolhida = candidatas[0].d;
  } else if (candidatas.length > 1) {
    const valores = new Set(candidatas.map((c) => centavos(c.d.valor)));
    if (valores.size === 1) {
      escolhida = candidatas.sort((a, b) => a.d.idParcelamento - b.d.idParcelamento || a.d.id - b.d.id)[0].d;
    } else {
      ambigua = true;
    }
  }

  const dia = diaDe(item.data);
  if (escolhida) {
    const manual = _Cat.categoriaEhManual(escolhida);
    const atualizada = {
      ...escolhida,
      valor: item.valor,
      data: dia,
      dataProjetada: false,
      faturaId: fatura.id,
      statusDespesa: 'confirmado',
      origemLancamento: 'importacao',
      competenciaPrevista: undefined,
      valorPrevistoAnterior: escolhida.valor,
      reconciliadoEm: _Datas.hojeISO(),
      // editada à mão: preserva categoria e descrição escolhidas pela pessoa;
      // valor, data e fatura são fatos do extrato do banco
      descricao: manual ? escolhida.descricao : (item.descricao || escolhida.descricao)
    };
    delete atualizada.competenciaPrevista;
    await atualizar('despesa', atualizada);
    jaUsadasNestaImportacao.add(escolhida.id);
    await gerarParcelasFuturasPrevistas({
      cartaoId, categoriaId: atualizada.categoriaId, descricaoBase: atualizada.descricao, valorParcela: item.valor,
      diaReferencia: _Datas.diaDoMes(dia), mesFaturaAtual: fatura.mesFatura, parcelaAtual, parcelaTotal,
      idParcelamento: escolhida.idParcelamento, chaveSerieOrigem: escolhida.chaveSerie || loja
    });
    return { id: escolhida.id, acao: 'reconciliada' };
  }

  const categoria = item.categoriaId ? { categoriaId: item.categoriaId } : await sugerirCategoria(item.descricao);
  const base = {
    valor: item.valor, categoriaId: categoria.categoriaId, cartaoId, faturaId: fatura.id, formaPagamento: 'cartao',
    data: dia, descricao: item.descricao || '', parcelaAtual, parcelaTotal, statusDespesa: 'confirmado',
    origemLancamento: 'importacao', editadoManualmente: false, categoriaManual: !!item.categoriaManual,
    categoriaAutomatica: !item.categoriaId
  };
  if (ambigua) {
    const id = await adicionar('despesa', { ...base, idParcelamento: null, pendenteReconciliacao: true });
    return { id, acao: 'revisao' };
  }
  const id = await adicionar('despesa', { ...base, idParcelamento: null });
  await atualizar('despesa', { ...base, id, idParcelamento: id, previsoesGeradas: true });
  await gerarParcelasFuturasPrevistas({
    cartaoId, categoriaId: base.categoriaId, descricaoBase: base.descricao, valorParcela: item.valor,
    diaReferencia: _Datas.diaDoMes(dia), mesFaturaAtual: fatura.mesFatura, parcelaAtual, parcelaTotal, idParcelamento: id
  });
  return { id, acao: 'nova_serie' };
}

// ---------- Ajuste de fatura (OCR) e totais ----------

function ehAjusteDeFatura(d) {
  return d.tipoLancamento === 'ajuste_fatura' ||
    (!d.editadoManualmente && /^Outros Gastos da Fatura \(Ajuste( OCR)?\)$/.test(d.descricao || ''));
}

// Recalcula o que é DERIVADO numa fatura, a partir dos lançamentos dela:
//  • fatura 'aberta'/'migrada' (sem dado oficial): totalOficial = soma dos
//    lançamentos confirmados;
//  • fatura 'importada' (total oficial confirmado pela pessoa): mantém o
//    total oficial e mantém UM único ajuste "Outros Gastos da Fatura
//    (Ajuste OCR)" = total oficial − soma dos itens. Diferença zero → o
//    ajuste deixa de existir. Soma acima do total → NENHUM ajuste negativo;
//    a fatura recebe divergencia = { tipo: 'soma_acima_do_total', excesso }
//    para revisão.
async function recalcularFatura(faturaId) {
  const fatura = await obterPorId('fatura', faturaId);
  if (!fatura) return null;
  const lancamentos = (await listarTodos('despesa')).filter((d) => d.faturaId === faturaId && d.statusDespesa === 'confirmado');
  const ajustes = lancamentos.filter(ehAjusteDeFatura).sort((a, b) => a.id - b.id);
  const itens = lancamentos.filter((d) => !ehAjusteDeFatura(d));
  const somaItensC = itens.reduce((s, d) => s + centavos(d.valor), 0);

  if (fatura.origem !== 'importada') {
    const totalC = somaItensC + ajustes.reduce((s, d) => s + centavos(d.valor), 0);
    if (centavos(fatura.totalOficial || 0) !== totalC) await atualizar('fatura', { ...fatura, totalOficial: totalC / 100 });
    return { acaoAjuste: 'nenhum', valorAjuste: 0, divergencia: null };
  }

  const totalC = centavos(fatura.totalOficial || 0);
  const diferencaC = totalC - somaItensC;
  let acaoAjuste = 'nenhum';
  let divergencia = null;
  const removidos = [];

  // Fatura importada que AINDA NÃO FECHOU (fechamento depois de hoje): o
  // total informado é um saldo parcial do ciclo em andamento. Nenhum ajuste
  // é criado, alterado ou removido agora; a diferença é tratada quando a
  // fatura fechada for reimportada. Soma acima do total ainda é sinalizada.
  const fechamentoDia = diaDe(fatura.fechamento);
  if (fechamentoDia && fechamentoDia > _Datas.hojeISO()) {
    const divergenciaAberta = diferencaC < 0 ? { tipo: 'soma_acima_do_total', somaItens: somaItensC / 100, totalOficial: totalC / 100, excesso: -diferencaC / 100 } : null;
    if (JSON.stringify(fatura.divergencia || null) !== JSON.stringify(divergenciaAberta)) await atualizar('fatura', { ...fatura, divergencia: divergenciaAberta });
    return { acaoAjuste: 'adiado_fatura_aberta', valorAjuste: 0, diferencaPendente: diferencaC > 0 ? diferencaC / 100 : 0, divergencia: divergenciaAberta };
  }

  if (diferencaC > 0) {
    const valor = diferencaC / 100;
    if (ajustes.length > 0) {
      const [principal, ...extras] = ajustes;
      const atualizado = {
        ...principal, valor, tipoLancamento: 'ajuste_fatura', descricao: 'Outros Gastos da Fatura (Ajuste OCR)',
        statusDespesa: 'confirmado', cartaoId: fatura.cartaoId
      };
      if (JSON.stringify(atualizado) !== JSON.stringify(principal)) { await atualizar('despesa', atualizado); acaoAjuste = 'atualizado'; }
      for (const extra of extras) { await remover('despesa', extra.id); removidos.push(extra); }
    } else {
      const idOutros = await idCategoriaPorNome('Outros');
      const dataAjuste = itens.map((d) => diaDe(d.data)).filter(Boolean).sort().pop() || diaDe(fatura.fechamento) || `${fatura.mesFatura}-01`;
      await adicionar('despesa', {
        valor, categoriaId: idOutros, cartaoId: fatura.cartaoId, faturaId, formaPagamento: 'cartao', data: dataAjuste,
        descricao: 'Outros Gastos da Fatura (Ajuste OCR)', parcelaAtual: 1, parcelaTotal: 1, idParcelamento: null,
        statusDespesa: 'confirmado', tipoLancamento: 'ajuste_fatura', origemLancamento: 'ajuste_fatura',
        editadoManualmente: false, categoriaManual: false
      });
      acaoAjuste = 'criado';
    }
  } else {
    // diferença zero ou negativa: o ajuste (lançamento derivado, nunca uma
    // compra real) deixa de existir; a remoção fica registrada no log
    for (const a of ajustes) { await remover('despesa', a.id); removidos.push(a); }
    if (ajustes.length > 0) acaoAjuste = 'removido';
    if (diferencaC < 0) divergencia = { tipo: 'soma_acima_do_total', somaItens: somaItensC / 100, totalOficial: totalC / 100, excesso: -diferencaC / 100 };
  }

  if (removidos.length > 0) {
    await registrarLog('log_ajustes_fatura', removidos.map((a) => ({ em: new Date().toISOString(), faturaId, ajusteRemovido: a })));
  }
  const faturaAtual = await obterPorId('fatura', faturaId);
  if (JSON.stringify(faturaAtual.divergencia || null) !== JSON.stringify(divergencia)) {
    await atualizar('fatura', { ...faturaAtual, divergencia });
  }
  return { acaoAjuste, valorAjuste: diferencaC > 0 ? diferencaC / 100 : 0, divergencia };
}

// ---------- Importação de fatura real ----------
// dadosFatura: { cartaoId, mesFatura 'AAAA-MM', fechamento, vencimento
//   ('AAAA-MM-DD'), totalOficial, statusPagamento? }
// itens: [{ data, descricao, valor, categoriaId?, categoriaManual?,
//   parcelaAtual?, parcelaTotal? }] — SEM o ajuste (é calculado aqui).
//
// • Uma fatura por cartão + mês: se já existir, é REIMPORTAÇÃO segura
//   (atualiza total/datas confirmados, nunca o status de pagamento).
// • Itens que já estão nesta fatura (mesmo dia, valor e descrição, contando
//   repetições) são ignorados — reimportar o mesmo arquivo não duplica nada.
// • Parcelas "N/M" reconciliam a previsão existente (gravarParcelaDaFatura).
// • Lançamento manual já vinculado a esta fatura, com mesmo dia e valor,
//   é conciliado com o item do extrato em vez de duplicado.
// • A data real de cada item é preservada; a competência vem de mesFatura.
async function importarFatura(dadosFatura, itens, opcoes = {}) {
  const { cartaoId, mesFatura } = dadosFatura;
  if (!cartaoId) throw new Error('importarFatura: cartaoId é obrigatório');
  if (!_Datas.ehMesISO(mesFatura)) throw new Error('importarFatura: mesFatura precisa estar no formato AAAA-MM');
  const cartao = await obterPorId('cartao', cartaoId);
  if (!cartao) throw new Error('importarFatura: cartão não encontrado');
  const totalOficial = dadosFatura.totalOficial;
  if (typeof totalOficial !== 'number' || !isFinite(totalOficial) || totalOficial < 0) throw new Error('importarFatura: totalOficial inválido');

  const itensNormalizados = (itens || []).map((item, i) => {
    const dia = diaDe(item.data);
    if (!dia) throw new Error(`importarFatura: item ${i + 1} com data inválida`);
    if (typeof item.valor !== 'number' || !isFinite(item.valor) || item.valor <= 0) throw new Error(`importarFatura: item ${i + 1} com valor inválido`);
    return { ...item, data: dia, descricao: (item.descricao || '').trim() };
  });

  const datasEstimadas = datasEstimadasDaFatura(cartao, mesFatura);
  const fechamento = diaDe(dadosFatura.fechamento) || datasEstimadas.fechamento;
  const vencimento = diaDe(dadosFatura.vencimento) || datasEstimadas.vencimento;

  const existente = await faturaExistenteParaCartaoMes(cartaoId, mesFatura);
  let fatura;
  if (existente) {
    fatura = { ...existente, origem: 'importada', totalOficial, fechamento, vencimento, cicloFim: fechamento, importadaEm: _Datas.hojeISO() };
    await atualizar('fatura', fatura);
  } else {
    const id = await adicionar('fatura', {
      cartaoId, mesFatura, cicloInicio: null, cicloFim: fechamento, fechamento, vencimento, totalOficial,
      statusPagamento: dadosFatura.statusPagamento === 'paga' ? 'paga' : 'nao_paga', origem: 'importada', importadaEm: _Datas.hojeISO()
    });
    fatura = await obterPorId('fatura', id);
  }

  // multiconjunto do que já está gravado nesta fatura
  const chaveItem = (dia, valor, descricao) => `${dia}|${centavos(valor)}|${_Cat.normalizar(descricao)}`;
  const jaGravados = new Map();
  const lancamentosDaFatura = (await listarTodos('despesa')).filter((d) => d.faturaId === fatura.id && !ehAjusteDeFatura(d));
  for (const d of lancamentosDaFatura) {
    const k = chaveItem(diaDe(d.data), d.valor, d.descricao);
    jaGravados.set(k, (jaGravados.get(k) || 0) + 1);
  }

  const resultado = { faturaId: fatura.id, criada: !existente, reimportacao: !!existente, inseridos: [], reconciliados: [], ignoradosJaExistentes: 0, revisaoNecessaria: [] };
  const previsoesUsadas = new Set();
  const manuaisUsados = new Set();

  for (const item of itensNormalizados) {
    const k = chaveItem(item.data, item.valor, item.descricao);
    if ((jaGravados.get(k) || 0) > 0) {
      jaGravados.set(k, jaGravados.get(k) - 1);
      resultado.ignoradosJaExistentes++;
      continue;
    }

    const parcela = (item.parcelaTotal > 1 && item.parcelaAtual >= 1)
      ? { parcelaAtual: item.parcelaAtual, parcelaTotal: item.parcelaTotal }
      : extrairParcelaDaDescricao(item.descricao);

    if (parcela) {
      const r = await gravarParcelaDaFatura(cartaoId, fatura, item, parcela.parcelaAtual, parcela.parcelaTotal, previsoesUsadas);
      if (r.acao === 'reconciliada') resultado.reconciliados.push(r.id);
      else resultado.inseridos.push(r.id);
      if (r.acao === 'revisao') resultado.revisaoNecessaria.push(r.id);
      continue;
    }

    const manual = lancamentosDaFatura.find((d) =>
      d.origemLancamento === 'manual' && !d.conciliadoComExtrato && !manuaisUsados.has(d.id) &&
      diaDe(d.data) === item.data && centavos(d.valor) === centavos(item.valor)
    );
    if (manual) {
      manuaisUsados.add(manual.id);
      await atualizar('despesa', { ...manual, conciliadoComExtrato: true, descricao: manual.descricao || item.descricao, descricaoExtrato: item.descricao });
      resultado.reconciliados.push(manual.id);
      continue;
    }

    const categoria = item.categoriaId ? { categoriaId: item.categoriaId } : await sugerirCategoria(item.descricao);
    const id = await adicionar('despesa', {
      valor: item.valor, categoriaId: categoria.categoriaId, cartaoId, faturaId: fatura.id, formaPagamento: 'cartao',
      data: item.data, descricao: item.descricao, parcelaAtual: 1, parcelaTotal: 1, idParcelamento: null,
      statusDespesa: 'confirmado', origemLancamento: 'importacao', editadoManualmente: false,
      categoriaManual: !!item.categoriaManual, categoriaAutomatica: !item.categoriaId
    });
    resultado.inseridos.push(id);
  }

  const recalculo = await recalcularFatura(fatura.id);
  resultado.ajuste = { acao: recalculo.acaoAjuste, valor: recalculo.valorAjuste };
  resultado.divergencia = recalculo.divergencia;
  if (opcoes.retornarFatura) resultado.fatura = await obterPorId('fatura', fatura.id);
  return resultado;
}

// Prévia (sem gravar nada) do que uma importação faria.
async function previaImportacaoFatura(dadosFatura, itens) {
  const existente = dadosFatura.cartaoId && _Datas.ehMesISO(dadosFatura.mesFatura)
    ? await faturaExistenteParaCartaoMes(dadosFatura.cartaoId, dadosFatura.mesFatura) : null;
  const somaItensC = (itens || []).reduce((s, i) => s + centavos(i.valor), 0);
  const totalC = centavos(dadosFatura.totalOficial || 0);
  let jaExistentes = 0;
  if (existente) {
    const gravados = new Map();
    (await despesasDaFatura(existente.id)).filter((d) => !ehAjusteDeFatura(d)).forEach((d) => {
      const k = `${diaDe(d.data)}|${centavos(d.valor)}|${_Cat.normalizar(d.descricao)}`;
      gravados.set(k, (gravados.get(k) || 0) + 1);
    });
    for (const i of itens || []) {
      const k = `${diaDe(i.data)}|${centavos(i.valor)}|${_Cat.normalizar(i.descricao)}`;
      if ((gravados.get(k) || 0) > 0) { gravados.set(k, gravados.get(k) - 1); jaExistentes++; }
    }
  }
  return {
    reimportacao: !!existente,
    faturaExistente: existente,
    quantidadeItens: (itens || []).length,
    jaExistentes,
    somaItens: somaItensC / 100,
    totalOficial: totalC / 100,
    ajusteOcr: totalC > somaItensC ? (totalC - somaItensC) / 100 : 0,
    somaAcimaDoTotal: somaItensC > totalC ? (somaItensC - totalC) / 100 : 0
  };
}

// ---------- Lançamentos manuais (UI) ----------

// Nova despesa digitada pela pessoa. Se for no cartão, é vinculada à fatura
// do ciclo da compra (pela regra do dia de fechamento do cartão) — nunca
// fica com cartaoId e faturaId nulo sem regra.
async function adicionarDespesaManual({ valor, categoriaId, cartaoId, formaPagamento, data, descricao }) {
  if (typeof valor !== 'number' || !(valor > 0)) throw new Error('Valor inválido');
  const dia = diaDe(data) || _Datas.hojeISO();
  const ehCartao = !!cartaoId;
  let faturaId = null;
  if (ehCartao) {
    const fatura = await obterOuCriarFaturaParaCompra(cartaoId, dia);
    if (!fatura) throw new Error('Cadastre o dia de fechamento deste cartão para lançar compras nele.');
    faturaId = fatura.id;
  }
  let categoria = { categoriaId, manual: true };
  if (!categoriaId) {
    const s = await sugerirCategoria(descricao);
    categoria = { categoriaId: s.categoriaId, manual: false };
  }
  const id = await adicionar('despesa', {
    valor, categoriaId: categoria.categoriaId, cartaoId: ehCartao ? cartaoId : null, faturaId,
    formaPagamento: ehCartao ? 'cartao' : (formaPagamento || 'pix'), data: dia, descricao: (descricao || '').trim(),
    parcelaAtual: 1, parcelaTotal: 1, idParcelamento: null, statusDespesa: 'confirmado',
    origemLancamento: 'manual', editadoManualmente: false, categoriaManual: categoria.manual
  });
  if (faturaId) await recalcularFatura(faturaId);
  return id;
}

// Edição feita pela pessoa. Regras:
//  • marca editadoManualmente (e categoriaManual se a categoria mudou);
//  • trocou de cartão → a fatura antiga é desvinculada e a despesa vai para
//    a fatura do novo cartão (regra do dia de fechamento); sem cartão →
//    faturaId null. Nunca fica um faturaId de outro cartão;
//  • mudou a data de uma despesa numa fatura NÃO importada → refaz o
//    vínculo pelo ciclo; numa fatura importada a data real muda, mas o
//    lançamento continua na fatura do extrato;
//  • as faturas envolvidas têm total/ajuste recalculados.
async function atualizarDespesaManual(id, alteracoes) {
  const anterior = await obterPorId('despesa', id);
  if (!anterior) throw new Error('Despesa não encontrada');
  const novo = { ...anterior, ...alteracoes, editadoManualmente: true };
  if (alteracoes.data !== undefined) novo.data = diaDe(alteracoes.data) || anterior.data;
  if (alteracoes.categoriaId !== undefined && alteracoes.categoriaId !== anterior.categoriaId) {
    novo.categoriaManual = true;
    novo.categoriaAutomatica = false;
  }

  const faturaAnterior = anterior.faturaId != null ? await obterPorId('fatura', anterior.faturaId) : null;
  const trocouCartao = alteracoes.cartaoId !== undefined && (alteracoes.cartaoId || null) !== (anterior.cartaoId || null);
  const mudouData = alteracoes.data !== undefined && diaDe(alteracoes.data) !== diaDe(anterior.data);

  if (novo.statusDespesa !== 'previsto') {
    if (!novo.cartaoId) {
      novo.cartaoId = null;
      novo.faturaId = null;
      if (novo.formaPagamento === 'cartao') novo.formaPagamento = 'pix';
    } else if (trocouCartao || (mudouData && (!faturaAnterior || faturaAnterior.origem !== 'importada'))) {
      const fatura = await obterOuCriarFaturaParaCompra(novo.cartaoId, novo.data);
      if (!fatura) throw new Error('Cadastre o dia de fechamento deste cartão antes de mover lançamentos para ele.');
      novo.faturaId = fatura.id;
      novo.formaPagamento = 'cartao';
      if (trocouCartao) novo.conciliadoComExtrato = false;
    }
  }

  await atualizar('despesa', novo);
  const afetadas = new Set([anterior.faturaId, novo.faturaId].filter((f) => f != null));
  for (const f of afetadas) await recalcularFatura(f);
  return novo;
}

async function excluirDespesa(id) {
  const anterior = await obterPorId('despesa', id);
  if (!anterior) return;
  await remover('despesa', id);
  if (anterior.faturaId != null) await recalcularFatura(anterior.faturaId);
}

// Excluir cartão = ARQUIVAR: o cartão some das listas, mas despesas,
// faturas, cartaoId e faturaId ficam intactos (a competência histórica não
// muda e nada é apagado).
async function arquivarCartao(id) {
  const cartao = await obterPorId('cartao', id);
  if (!cartao) return;
  await atualizar('cartao', { ...cartao, arquivado: true, arquivadoEm: _Datas.hojeISO() });
}

async function listarCartoesAtivos() {
  return (await listarTodos('cartao')).filter((c) => !c.arquivado);
}

// ---------- Competência financeira ----------

function competenciaDespesa(despesa, mapaFatura) {
  if (despesa.faturaId != null && mapaFatura && mapaFatura[despesa.faturaId]) {
    return mapaFatura[despesa.faturaId].mesFatura;
  }
  if (despesa.statusDespesa === 'previsto' && despesa.competenciaPrevista) return despesa.competenciaPrevista;
  return mesDe(despesa.data);
}

function competenciaReceita(receita) { return mesDe(receita.data); }

async function mapaFaturasPorId() {
  const faturas = await listarTodos('fatura');
  return Object.fromEntries(faturas.map((f) => [f.id, f]));
}

async function gastosDoMes(mesISO = mesAtualISO()) {
  const [todas, mapaFatura] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId()]);
  return todas.filter((d) => competenciaDespesa(d, mapaFatura) === mesISO);
}

async function despesasConfirmadasDoMes(mesISO) {
  return (await gastosDoMes(mesISO)).filter((d) => d.statusDespesa === 'confirmado');
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
      dia: diaDe(d.data),
      categoriaNome: mapaCategoria[d.categoriaId] && categoriaAtiva(mapaCategoria[d.categoriaId]) ? mapaCategoria[d.categoriaId].nome : 'Outros',
      categoriaIcone: mapaCategoria[d.categoriaId] && categoriaAtiva(mapaCategoria[d.categoriaId]) ? mapaCategoria[d.categoriaId].icone : '💬',
      cartaoNome: d.cartaoId ? (mapaCartao[d.cartaoId]?.nome || 'Cartão removido') : null,
      valorParcela: d.valor, // d.valor já é o valor da parcela; nunca dividir por parcelaTotal
      mesCompetencia: competenciaDespesa(d, mapaFatura)
    }))
    .sort((a, b) => (b.dia || '').localeCompare(a.dia || '') || (b.parcelaAtual || 0) - (a.parcelaAtual || 0));
}

// Gastos confirmados do mês (competência) por categoria. Categoria
// inexistente ou desativada → "Outros" (nunca descartada).
async function gastosPorCategoria(mesISO = mesAtualISO()) {
  const categorias = await listarTodos('categoria');
  const mapa = {};
  categorias.filter(categoriaAtiva).forEach((c) => { mapa[c.id] = { ...c, total: 0, itens: [] }; });
  const outros = categorias.filter(categoriaAtiva).find((c) => c.nome === 'Outros');
  const idFallback = outros ? outros.id : 'outros_fallback_memoria';
  if (!mapa[idFallback]) mapa[idFallback] = { id: null, nome: 'Outros', icone: '💬', tipo: 'essencial', total: 0, itens: [] };

  for (const d of await despesasConfirmadasDoMes(mesISO)) {
    const destino = mapa[d.categoriaId] ? d.categoriaId : idFallback;
    mapa[destino].total += d.valor;
    mapa[destino].itens.push({ ...d, valorParcela: d.valor });
  }
  for (const c of Object.values(mapa)) c.total = centavos(c.total) / 100;
  return Object.values(mapa).sort((a, b) => b.total - a.total);
}

async function totalGastoNoMes(mesISO = mesAtualISO()) {
  const despesas = await despesasConfirmadasDoMes(mesISO);
  return despesas.reduce((s, d) => s + centavos(d.valor), 0) / 100;
}

async function saidasConfirmadasDoMes(mesISO = mesAtualISO()) { return totalGastoNoMes(mesISO); }

// Evolução mensal: total por competência + se o mês TEM dados.
async function historicoGastosMensais(mesInicioISO, mesFimISO = mesAtualISO()) {
  const [todas, mapaFatura] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId()]);
  const confirmadas = todas.filter((d) => d.statusDespesa === 'confirmado');
  return mesesEntre(mesInicioISO, mesFimISO).map((mesISO) => {
    const doMes = confirmadas.filter((d) => competenciaDespesa(d, mapaFatura) === mesISO);
    return { mesISO, total: doMes.reduce((s, d) => s + centavos(d.valor), 0) / 100, temDados: doMes.length > 0 };
  });
}

// Evolução POR CATEGORIA. A existência de dados é decidida por categoria e
// por mês: uma categoria sem nenhum gasto confirmado naquele mês fica com
// total null / temDados false ("Sem dados"), mesmo que o mês tenha gastos em
// outras categorias. Nunca usa uma verificação global de "mês tem dados".
async function evolucaoPorCategoria(mesInicioISO, mesFimISO = mesAtualISO()) {
  const [todas, mapaFatura, categorias] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId(), listarTodos('categoria')]);
  const ativas = categorias.filter(categoriaAtiva);
  const idsAtivos = new Set(ativas.map((c) => c.id));
  const outros = ativas.find((c) => c.nome === 'Outros');
  const meses = mesesEntre(mesInicioISO, mesFimISO);
  const acumulado = new Map(); // `${catId}|${mes}` → { totalC, n }
  for (const d of todas) {
    if (d.statusDespesa !== 'confirmado') continue;
    const mes = competenciaDespesa(d, mapaFatura);
    if (mes < mesInicioISO || mes > mesFimISO) continue;
    const catId = idsAtivos.has(d.categoriaId) ? d.categoriaId : (outros ? outros.id : null);
    const k = `${catId}|${mes}`;
    const atual = acumulado.get(k) || { totalC: 0, n: 0 };
    atual.totalC += centavos(d.valor); atual.n++;
    acumulado.set(k, atual);
  }
  const ordem = _Cat.NOMES_DEFINITIVOS;
  return ativas
    .sort((a, b) => ordem.indexOf(a.nome) - ordem.indexOf(b.nome))
    .map((c) => ({
      categoriaId: c.id, nome: c.nome, icone: c.icone, natureza: c.natureza,
      meses: meses.map((mesISO) => {
        const a = acumulado.get(`${c.id}|${mesISO}`);
        return a ? { mesISO, total: a.totalC / 100, temDados: true, quantidade: a.n } : { mesISO, total: null, temDados: false, quantidade: 0 };
      })
    }));
}

// Evolução diária do mês (eixo = dia real; conjunto = competência do mês).
async function gastosDiariosDoMes(mesISO = mesAtualISO()) {
  const despesas = await despesasConfirmadasDoMes(mesISO);
  const porDia = new Array(_Datas.diasNoMes(mesISO)).fill(0);
  despesas.forEach((d) => {
    const dia = diaDe(d.data);
    // compra de outro mês civil numa fatura deste mês (ex.: 01/09 na fatura
    // de agosto) entra no último dia do mês de competência
    const indice = dia && dia.slice(0, 7) === mesISO ? Number(dia.slice(8, 10)) - 1 : porDia.length - 1;
    porDia[indice] += d.valor;
  });
  return porDia.map((v) => centavos(v) / 100);
}

// Parcelas (confirmadas ou previstas) cuja competência é o PRÓXIMO mês.
async function parcelasProximoMes() {
  const mesSeguinte = somarMesISO(mesAtualISO(), 1);
  const [todas, mapaFatura] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId()]);
  return todas
    .filter((d) => d.parcelaTotal > 1 && competenciaDespesa(d, mapaFatura) === mesSeguinte)
    .reduce((s, d) => s + centavos(d.valor), 0) / 100;
}

// Previstas (parcelas futuras) por competência — "compromissos futuros".
async function previstasPorMes(mesInicioISO, quantidade = 6) {
  const [todas, mapaFatura] = await Promise.all([listarTodos('despesa'), mapaFaturasPorId()]);
  const meses = mesesEntre(mesInicioISO, somarMesISO(mesInicioISO, quantidade - 1));
  return meses.map((mesISO) => {
    const doMes = todas.filter((d) => d.statusDespesa === 'previsto' && competenciaDespesa(d, mapaFatura) === mesISO);
    return { mesISO, total: doMes.reduce((s, d) => s + centavos(d.valor), 0) / 100, quantidade: doMes.length };
  });
}

// ---------- Receitas e renda ----------

async function receitasDoMes(mesISO = mesAtualISO()) {
  return (await listarTodos('receita')).filter((r) => competenciaReceita(r) === mesISO);
}

async function totalReceitasAvulsasNoMes(mesISO = mesAtualISO()) {
  return (await receitasDoMes(mesISO)).reduce((s, r) => s + centavos(r.valor), 0) / 100;
}

// Renda mensal FIXA vigente no mês: o último valor cadastrado com
// mesReferencia ≤ mês pedido (vale até ser alterada). Antes, a renda só
// valia no mês exato em que foi digitada e "sumia" ao virar o mês.
async function rendaAtual(mesISO = mesAtualISO()) {
  const vigentes = (await listarTodos('renda'))
    .filter((r) => _Datas.ehMesISO(r.mesReferencia) && r.mesReferencia <= mesISO)
    .sort((a, b) => b.mesReferencia.localeCompare(a.mesReferencia) || b.id - a.id);
  return vigentes.length > 0 ? vigentes[0].valorMensal : 0;
}

// Define a renda a partir de um mês (não altera meses anteriores).
async function definirRenda(valorMensal, mesISO = mesAtualISO()) {
  const doMes = (await listarTodos('renda')).find((r) => r.mesReferencia === mesISO);
  if (doMes) await atualizar('renda', { ...doMes, valorMensal });
  else await adicionar('renda', { valorMensal, mesReferencia: mesISO });
}

async function entradasTotaisDoMes(mesISO = mesAtualISO()) {
  const renda = await rendaAtual(mesISO);
  const avulsas = await totalReceitasAvulsasNoMes(mesISO);
  return (centavos(renda) + centavos(avulsas)) / 100;
}

async function adicionarReceita({ valor, data, descricao }) {
  if (typeof valor !== 'number' || !(valor > 0)) throw new Error('Valor inválido');
  return adicionar('receita', { valor, data: diaDe(data) || _Datas.hojeISO(), descricao: (descricao || '').trim() || 'Receita avulsa' });
}

// ---------- Faturas (consulta) ----------

async function faturasPorCartao(cartaoId) {
  return (await listarTodos('fatura')).filter((f) => f.cartaoId === cartaoId).sort((a, b) => b.mesFatura.localeCompare(a.mesFatura));
}

async function despesasDaFatura(faturaId) {
  return (await listarTodos('despesa')).filter((d) => d.faturaId === faturaId);
}

function dataParaExibicao(dia) {
  const p = _Datas.partesDoDia(dia);
  return p ? new Date(Date.UTC(p.ano, p.mes - 1, p.dia, 12)) : null;
}

// 'quitada' (paga), 'vencida' (não paga, vencimento antes de hoje) ou
// 'proxima'. Fatura não paga nunca vira R$0,00.
async function faturasClassificadas() {
  const [faturas, cartoes] = await Promise.all([listarTodos('fatura'), listarTodos('cartao')]);
  const mapaCartao = Object.fromEntries(cartoes.map((c) => [c.id, c]));
  const hoje = _Datas.hojeISO();
  return faturas
    .map((f) => {
      const vencimentoDia = diaDe(f.vencimento);
      const diasRestantes = vencimentoDia ? _Datas.diferencaEmDias(hoje, vencimentoDia) : null;
      let situacao;
      if (f.statusPagamento === 'paga') situacao = 'quitada';
      else situacao = diasRestantes !== null && diasRestantes < 0 ? 'vencida' : 'proxima';
      const cartao = mapaCartao[f.cartaoId];
      return {
        ...f, cartaoNome: cartao ? cartao.nome : 'Cartão removido', cartaoArquivado: !!(cartao && cartao.arquivado),
        vencimentoDia, fechamentoDia: diaDe(f.fechamento), vencimento: dataParaExibicao(vencimentoDia), diasRestantes, situacao
      };
    })
    .sort((a, b) => (a.vencimentoDia || '9999').localeCompare(b.vencimentoDia || '9999'));
}

async function faturaEmDestaquePorCartao(cartaoId) {
  const doCartao = (await faturasClassificadas()).filter((f) => f.cartaoId === cartaoId);
  if (doCartao.length === 0) return null;
  const naoPagas = doCartao.filter((f) => f.situacao !== 'quitada');
  if (naoPagas.length > 0) return naoPagas[0];
  return doCartao.sort((a, b) => (b.vencimentoDia || '').localeCompare(a.vencimentoDia || ''))[0];
}

// Status de pagamento: só muda statusPagamento, nada mais.
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

// Confirma fechamento/vencimento REAIS digitados pela pessoa.
async function corrigirDatasFatura(faturaId, { fechamento, vencimento }) {
  const fatura = await obterPorId('fatura', faturaId);
  if (!fatura) return null;
  const f = diaDe(fechamento);
  const v = diaDe(vencimento);
  if (!f || !v) throw new Error('Datas inválidas');
  const atualizada = { ...fatura, fechamento: f, vencimento: v, cicloFim: f, datasConfirmadas: true };
  await atualizar('fatura', atualizada);
  return atualizada;
}

async function cartoesComResumo() {
  const cartoes = await listarCartoesAtivos();
  const resultado = [];
  for (const c of cartoes) {
    const fatura = await faturaEmDestaquePorCartao(c.id);
    const valorFatura = fatura ? fatura.totalOficial : 0;
    const percentualUsado = fatura && c.limite > 0 ? (valorFatura / c.limite) * 100 : 0;
    resultado.push({ ...c, fatura, valorFatura, percentualUsado });
  }
  return resultado;
}

// ---------- Reserva de emergência ----------

async function obterReserva() {
  const reservas = (await listarTodos('reserva')).sort((a, b) => a.id - b.id);
  return reservas[0] || { valorAtual: 0, meta: 0 };
}

// meta 0 = "meta não definida". prazoMeses só é gravado quando informado.
async function definirMetaReserva(meta, prazoMeses) {
  const reserva = await obterReserva();
  const atualizada = { ...reserva, meta };
  if (prazoMeses === null) delete atualizada.prazoMeses;
  else if (prazoMeses !== undefined) atualizada.prazoMeses = prazoMeses;
  if (reserva.id) await atualizar('reserva', atualizada);
  else await adicionar('reserva', { valorAtual: 0, ...atualizada });
}

async function adicionarAporte(valor, descricao = 'Aporte na reserva', data) {
  if (typeof valor !== 'number' || !(valor > 0)) throw new Error('Valor inválido');
  await adicionar('aporte', { valor, descricao, data: diaDe(data) || _Datas.hojeISO() });
  const reserva = await obterReserva();
  const novoValor = (centavos(reserva.valorAtual || 0) + centavos(valor)) / 100;
  if (reserva.id) await atualizar('reserva', { ...reserva, valorAtual: novoValor });
  else await adicionar('reserva', { valorAtual: novoValor, meta: 0 });
  return novoValor;
}

async function historicoAportes() {
  const aportes = (await listarTodos('aporte')).sort((a, b) => (diaDe(a.data) || '').localeCompare(diaDe(b.data) || '') || a.id - b.id);
  let acumuladoC = 0;
  return aportes.map((a) => { acumuladoC += centavos(a.valor); return { ...a, dia: diaDe(a.data), acumulado: acumuladoC / 100 }; });
}

// ---------- Saldo ----------

async function despesasAVistaDoMes(mesISO = mesAtualISO()) {
  const todas = await listarTodos('despesa');
  return todas
    .filter((d) => !d.cartaoId && d.faturaId == null && d.statusDespesa === 'confirmado' && mesDe(d.data) === mesISO)
    .reduce((s, d) => s + centavos(d.valor), 0) / 100;
}

async function saldoDisponivelDoMes(mesISO = mesAtualISO()) {
  const entradas = await entradasTotaisDoMes(mesISO);
  const aVista = await despesasAVistaDoMes(mesISO);
  const saidas = await saidasConfirmadasDoMes(mesISO);
  return { entradas, saidas, saldo: (centavos(entradas) - centavos(saidas)) / 100, aVista };
}

// Gastos confirmados com data real entre dois dias (inclusive).
async function totalDespesasEntre(inicio, fim) {
  const a = diaDe(inicio);
  const b = diaDe(fim);
  return (await listarTodos('despesa'))
    .filter((d) => d.statusDespesa === 'confirmado' && d.tipoLancamento !== 'ajuste_fatura')
    .filter((d) => { const dia = diaDe(d.data); return dia && dia >= a && dia <= b; })
    .reduce((s, d) => s + centavos(d.valor), 0) / 100;
}

async function houveDespesaHoje() {
  const hoje = _Datas.hojeISO();
  return (await listarTodos('despesa')).some((d) => d.statusDespesa === 'confirmado' && diaDe(d.data) === hoje);
}

// Lista POSSÍVEIS duplicatas para revisão. Não apaga nada: duas compras
// iguais no mesmo dia (dois cafés) são legítimas, então não existe critério
// seguro para remover sozinho.
async function listarPossiveisDuplicatas() {
  const grupos = new Map();
  for (const d of await listarTodos('despesa')) {
    if (d.statusDespesa !== 'confirmado' || ehAjusteDeFatura(d)) continue;
    const k = [d.cartaoId || 0, diaDe(d.data), centavos(d.valor), _Cat.normalizar(d.descricao), d.parcelaAtual || 1, d.parcelaTotal || 1].join('|');
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(d);
  }
  return [...grupos.values()].filter((g) => g.length > 1);
}

// ---------- Backup / restauração ----------

const STORES_RESTAURAVEIS = ['categoria', 'cartao', 'renda', 'reserva', 'receita', 'fatura', 'despesa', 'aporte', 'meta'];
const STORES_OBRIGATORIAS_BACKUP = ['categoria', 'cartao', 'despesa', 'renda', 'reserva', 'receita', 'fatura'];

// Exporta TODAS as stores que existem no banco (lista lida do próprio
// IndexedDB, então uma store nova nunca fica de fora do backup).
async function exportarBackup() {
  const db = await obterConexao();
  const dump = {
    _backup: { app: 'Finanças Fácil', versaoSchema: DB_VERSION, exportadoEm: new Date().toISOString() }
  };
  for (const nome of [...db.objectStoreNames]) dump[nome] = await listarTodos(nome);
  return dump;
}

function validarBackup(dados) {
  const erros = [];
  const avisos = [];
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) {
    return { valido: false, erros: ['O arquivo não é um objeto JSON de backup válido.'], avisos };
  }

  for (const nomeStore of STORES_RESTAURAVEIS) {
    const obrigatoria = STORES_OBRIGATORIAS_BACKUP.includes(nomeStore);
    if (!(nomeStore in dados)) {
      if (obrigatoria) erros.push(`Store obrigatória ausente no backup: "${nomeStore}".`);
      else avisos.push(`Store "${nomeStore}" não está no backup (backup antigo) — fica vazia após restaurar.`);
      continue;
    }
    if (!Array.isArray(dados[nomeStore])) { erros.push(`Store "${nomeStore}" precisa ser uma lista (array).`); continue; }
    const chave = CHAVE_DA_STORE[nomeStore];
    const vistos = new Set();
    for (const r of dados[nomeStore]) {
      if (!r || typeof r !== 'object' || r[chave] === undefined || r[chave] === null) { erros.push(`Registro sem "${chave}" na store "${nomeStore}".`); break; }
      if (vistos.has(r[chave])) erros.push(`${chave} ${r[chave]} repetido na store "${nomeStore}".`);
      vistos.add(r[chave]);
    }
  }
  const lista = (n) => (Array.isArray(dados[n]) ? dados[n] : []);

  for (const d of lista('despesa')) {
    if (typeof d.valor !== 'number' || !isFinite(d.valor)) erros.push(`despesa id ${d.id}: valor inválido.`);
    if (!diaDe(d.data)) erros.push(`despesa id ${d.id}: data inválida (${d.data}).`);
  }
  for (const r of lista('receita')) if (!diaDe(r.data)) erros.push(`receita id ${r.id}: data inválida.`);
  for (const a of lista('aporte')) if (typeof a.valor !== 'number') erros.push(`aporte id ${a.id}: valor inválido.`);
  for (const f of lista('fatura')) if (!_Datas.ehMesISO(f.mesFatura)) erros.push(`fatura id ${f.id}: mesFatura inválido (${f.mesFatura}).`);

  const idsCartao = new Set(lista('cartao').map((c) => c.id));
  const idsCategoria = new Set(lista('categoria').map((c) => c.id));
  const idsFatura = new Set(lista('fatura').map((f) => f.id));
  const idsDespesa = new Set(lista('despesa').map((d) => d.id));
  const faturaPorId = Object.fromEntries(lista('fatura').map((f) => [f.id, f]));
  for (const d of lista('despesa')) {
    if (d.cartaoId != null && !idsCartao.has(d.cartaoId)) erros.push(`despesa id ${d.id}: cartaoId ${d.cartaoId} não existe no backup.`);
    if (d.faturaId != null && !idsFatura.has(d.faturaId)) erros.push(`despesa id ${d.id}: faturaId ${d.faturaId} não existe no backup.`);
    if (d.faturaId != null && faturaPorId[d.faturaId] && d.cartaoId != null && faturaPorId[d.faturaId].cartaoId !== d.cartaoId) {
      avisos.push(`despesa id ${d.id}: está no cartão ${d.cartaoId}, mas a fatura ${d.faturaId} é do cartão ${faturaPorId[d.faturaId].cartaoId}.`);
    }
    if (d.categoriaId != null && !idsCategoria.has(d.categoriaId)) avisos.push(`despesa id ${d.id}: categoriaId ${d.categoriaId} não existe — será contada em "Outros".`);
    if (d.idParcelamento != null && !idsDespesa.has(d.idParcelamento)) avisos.push(`despesa id ${d.id}: série de parcelamento ${d.idParcelamento} sem a despesa de origem (a série continua funcionando).`);
  }
  for (const f of lista('fatura')) if (!idsCartao.has(f.cartaoId)) avisos.push(`fatura id ${f.id}: cartão ${f.cartaoId} não existe no backup.`);

  return { valido: erros.length === 0, erros, avisos };
}

async function contagemPorStore() {
  const contagem = {};
  for (const nomeStore of STORES_RESTAURAVEIS) contagem[nomeStore] = (await listarTodos(nomeStore)).length;
  return contagem;
}

async function relatorioFaturasEParcelamentos() {
  const [faturas, despesas] = await Promise.all([listarTodos('fatura'), listarTodos('despesa')]);
  const listaFaturas = faturas.map((f) => ({
    id: f.id, cartaoId: f.cartaoId, mesFatura: f.mesFatura, totalOficial: f.totalOficial,
    statusPagamento: f.statusPagamento, origem: f.origem, fechamento: diaDe(f.fechamento), vencimento: diaDe(f.vencimento)
  }));
  const series = new Map();
  for (const d of despesas) {
    if (!(d.parcelaTotal > 1)) continue;
    const chave = d.idParcelamento ?? `sem-idParcelamento-${d.id}`;
    if (!series.has(chave)) series.set(chave, []);
    series.get(chave).push({ id: d.id, parcelaAtual: d.parcelaAtual, parcelaTotal: d.parcelaTotal, statusDespesa: d.statusDespesa, valor: d.valor, data: diaDe(d.data), faturaId: d.faturaId });
  }
  return {
    faturas: listaFaturas,
    seriesDeParcelamento: [...series.entries()].map(([idParcelamento, parcelas]) => ({ idParcelamento, parcelas: parcelas.sort((a, b) => a.parcelaAtual - b.parcelaAtual) }))
  };
}

// Restaura um backup:
// 1) valida o JSON inteiro antes de escrever qualquer coisa;
// 2) banco com dados → só substitui com confirmarSubstituicao:true (segunda
//    ação explícita da pessoa); nunca mescla nem apaga em silêncio;
// 3) preserva os IDs originais (put), então faturaId, cartaoId,
//    categoriaId e idParcelamento continuam apontando para os mesmos
//    registros; valores e datas não são recalculados;
// 4) roda as migrações (idempotentes, não destrutivas) sobre o que foi
//    restaurado;
// 5) nunca chama deleteDatabase: a substituição limpa store a store.
async function restaurarBackup(dados, opcoes = {}) {
  const validacao = validarBackup(dados);
  if (!validacao.valido) return { status: 'invalido', erros: validacao.erros, avisos: validacao.avisos };

  await abrirBanco();
  const contagemAtual = await contagemPorStore();
  const existeDadoAtual = ['despesa', 'fatura', 'cartao', 'receita', 'aporte'].some((s) => contagemAtual[s] > 0)
    || (await listarTodos('reserva')).some((r) => r.valorAtual > 0 || r.meta > 0)
    || (await listarTodos('renda')).some((r) => r.valorMensal > 0);

  if (existeDadoAtual && opcoes.confirmarSubstituicao !== true) {
    const contagemBackup = {};
    for (const s of STORES_RESTAURAVEIS) contagemBackup[s] = (dados[s] || []).length;
    return { status: 'aguardando_confirmacao', contagemAtual, contagemBackup, avisos: validacao.avisos };
  }

  for (const s of STORES_RESTAURAVEIS) await limparStore(s);
  const contagemRestaurada = {};
  for (const s of STORES_RESTAURAVEIS) {
    const registros = dados[s] || [];
    for (const r of registros) await atualizar(s, r);
    contagemRestaurada[s] = registros.length;
  }

  const despesasAntes = (await listarTodos('despesa')).length;
  await executarMigracoes();
  await seedInicial();
  const despesasDepois = (await listarTodos('despesa')).length;

  return {
    status: 'restaurado',
    avisos: validacao.avisos,
    contagemAntes: contagemAtual,
    contagemRestaurada,
    contagemDepois: await contagemPorStore(),
    parcelasGeradasPelaMigracao: despesasDepois - despesasAntes,
    ...(await relatorioFaturasEParcelamentos())
  };
}

async function importarDadosCompletos(dados) {
  return restaurarBackup(dados, { confirmarSubstituicao: true });
}

// Só para testes automatizados: esquece a conexão atual.
function _reiniciarParaTestes() { fecharBanco(); }

const DB = {
  DB_VERSION, abrirBanco, fecharBanco, apagarBancoCompleto, limparStore, seedInicial, adicionar, listarTodos, obterPorId, atualizar, remover,
  lerMeta, gravarMeta, garantirTaxonomia, listarCategoriasAtivas, idCategoriaPorNome, sugerirCategoria,
  gastosDoMes, despesasConfirmadasDoMes, gastosPorCategoria, totalGastoNoMes, gastosDiariosDoMes, parcelasProximoMes, previstasPorMes,
  rendaAtual, definirRenda, receitasDoMes, totalReceitasAvulsasNoMes, entradasTotaisDoMes, adicionarReceita,
  cartoesComResumo, listarCartoesAtivos, arquivarCartao, faturasPorCartao, despesasDaFatura, faturasClassificadas, faturaEmDestaquePorCartao,
  marcarFaturaComoPaga, desmarcarFaturaComoPaga, corrigirDatasFatura, recalcularFatura,
  mesFaturaParaCompra, datasEstimadasDaFatura, obterOuCriarFaturaParaCompra,
  mesAtualISO, mesAnteriorISO, somarMesISO, despesasDetalhadas, totalDespesasEntre, houveDespesaHoje,
  obterReserva, definirMetaReserva, adicionarAporte, historicoAportes, despesasAVistaDoMes, saidasConfirmadasDoMes, saldoDisponivelDoMes,
  competenciaDespesa, competenciaReceita, mapaFaturasPorId, listarPossiveisDuplicatas, importarDadosCompletos,
  faturaExistenteParaCartaoMes, importarFatura, previaImportacaoFatura, gerarParcelasFuturasPrevistas,
  adicionarDespesaManual, atualizarDespesaManual, excluirDespesa,
  migrarFaturasParaV5, migrarDespesasParaV4, migrarCategoriasV6, migrarParcelamentosExistentes, executarMigracoes,
  mesesEntre, historicoGastosMensais, evolucaoPorCategoria, extrairParcelaDaDescricao,
  exportarBackup, validarBackup, restaurarBackup, contagemPorStore, relatorioFaturasEParcelamentos,
  STORES_RESTAURAVEIS, _reiniciarParaTestes
};

if (typeof window !== 'undefined') window.DB = DB;
if (typeof module !== 'undefined') module.exports = DB;
