// categorias.js — mostra a taxonomia DEFINITIVA (11 categorias fixas) com o
// que foi gasto em cada uma no mês, e as categorias antigas desativadas pela
// migração (só para conferência; nada é apagado).

async function renderCategoriasLista() {
  const ativas = await DB.listarCategoriasAtivas();
  const gastos = await DB.gastosPorCategoria(DB.mesAtualISO());
  const totalPorId = Object.fromEntries(gastos.map((c) => [c.id, c.total]));
  const exemplos = {
    'Moradia': 'aluguel, condomínio, luz, água, internet', 'Alimentação': 'mercado, padaria, restaurante, iFood',
    'Transporte': 'Uber, 99, combustível, estacionamento', 'Assinaturas': 'Netflix, Spotify, serviços mensais',
    'Saúde': 'farmácia, drogaria, consultas, exames', 'Pet': 'veterinário, pet shop, ração',
    'Vestuário': 'roupas e calçados', 'Compras': 'eletrônicos e compras gerais', 'Lazer': 'cinema, jogos, viagens',
    'Taxas e encargos': 'IOF, tarifas, anuidade, juros', 'Outros': 'o que não se encaixa acima'
  };
  document.getElementById('listaCategorias').innerHTML = ativas.map((c) => `
    <div class="cat-manage-row">
      <div class="cat-manage-icon">${UI.escapar(c.icone)}</div>
      <div class="cat-manage-info">
        <div class="cat-manage-nome">${UI.escapar(c.nome)}</div>
        <div class="cat-manage-meta">${UI.escapar(exemplos[c.nome] || '')} · neste mês: ${UI.moeda(totalPorId[c.id] || 0)}</div>
      </div>
    </div>`).join('');

  const arquivadas = (await DB.listarTodos('categoria')).filter((c) => c.ativa === false);
  document.getElementById('categoriasArquivadas').innerHTML = arquivadas.length === 0 ? '' : `
    <div style="font-size:12px;color:var(--ink-soft);margin-top:18px;line-height:1.5">
      Categorias antigas desativadas na atualização (os lançamentos foram para as categorias novas):
      ${arquivadas.map((c) => `${UI.escapar(c.nome)} → ${UI.escapar(c.substituidaPor === 'categorizacao_por_descricao' ? 'conforme a descrição' : c.substituidaPor)}`).join(' · ')}
    </div>`;
}

(async function iniciar() {
  await DB.abrirBanco();
  await DB.seedInicial();
  await renderCategoriasLista();
})();
