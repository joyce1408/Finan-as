// validar-backup.js — confere um JSON exportado pelo app ("Exportar meus
// dados") SEM tocar no iPhone: valida a estrutura e simula, num IndexedDB
// falso em memória, a restauração + todas as migrações desta versão.
// O arquivo original nunca é alterado.
//
// Uso: node ferramentas/validar-backup.js caminho/do/backup.json [AAAA-MM ...]
//   (os meses opcionais recebem o total de gastos por competência)
const fs = require('node:fs');
const { instalarIndexedDBFalso } = require('../test/fake-indexeddb.js');
const DB = require('../js/db.js');

(async () => {
  const arquivo = process.argv[2];
  if (!arquivo) { console.error('Uso: node ferramentas/validar-backup.js backup.json [AAAA-MM ...]'); process.exit(2); }
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const original = JSON.stringify(dados);

  const v = DB.validarBackup(dados);
  console.log('== Validação');
  console.log(v.valido ? 'Estrutura válida.' : 'INVÁLIDO — o app recusaria este backup:');
  v.erros.forEach((e) => console.log('  ERRO:', e));
  v.avisos.forEach((a) => console.log('  aviso:', a));
  console.log('Registros:', Object.fromEntries(DB.STORES_RESTAURAVEIS.map((s) => [s, Array.isArray(dados[s]) ? dados[s].length : '—'])));
  if (!v.valido) process.exit(1);

  instalarIndexedDBFalso();
  await DB.abrirBanco();
  const r = await DB.restaurarBackup(JSON.parse(original), { confirmarSubstituicao: true });
  console.log('\n== Simulação de restauração + migrações:', r.status);
  console.log('Parcelas previstas criadas pela migração:', r.parcelasGeradasPelaMigracao);

  console.log('\n== Faturas');
  for (const f of r.faturas.sort((a, b) => a.mesFatura.localeCompare(b.mesFatura) || a.cartaoId - b.cartaoId)) {
    const lanc = (await DB.despesasDaFatura(f.id)).filter((d) => d.statusDespesa === 'confirmado');
    const soma = lanc.reduce((s, d) => s + Math.round(d.valor * 100), 0) / 100;
    console.log(`  id ${f.id} · cartão ${f.cartaoId} · ${f.mesFatura} · total ${f.totalOficial} · lançamentos ${soma} · ${f.statusPagamento} · ${f.origem}${Math.round(soma * 100) !== Math.round(f.totalOficial * 100) ? '  <-- DIFERENTE' : ''}`);
  }
  console.log('\n== Séries de parcelamento');
  for (const s of r.seriesDeParcelamento) console.log(`  ${s.idParcelamento}: ${s.parcelas.map((p) => `${p.parcelaAtual}/${p.parcelaTotal} ${p.statusDespesa} ${p.valor} ${p.data} fatura ${p.faturaId ?? '—'}`).join(' | ')}`);

  const log = (await DB.lerMeta('log_migracao_categorias_v6')) || [];
  console.log(`\n== Migração de categorias: ${log.length} registro(s)`);
  log.forEach((e) => console.log('  ', e.despesaId ? `despesa ${e.despesaId}: ${e.de} → ${e.para} (${e.motivo})` : `categoria desativada: ${e.categoriaDesativada} → ${e.substituidaPor}`));

  const meses = process.argv.slice(3);
  if (meses.length) {
    console.log('\n== Totais por competência (só confirmados)');
    for (const m of meses) console.log(`  ${m}: ${await DB.totalGastoNoMes(m)}`);
  }
  if (JSON.stringify(dados) !== original) throw new Error('o objeto original foi alterado — não deveria');
})().catch((e) => { console.error(e); process.exit(1); });
