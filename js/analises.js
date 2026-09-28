// analises.js — indicadores financeiros do app. Funções PURAS (sem banco),
// cada uma com definição matemática própria. Nenhum indicador reaproveita o
// percentual de outro: cada limite abaixo tem nome, significado e fonte.
//
// Convenções usadas por todos:
//   entradas          = renda fixa vigente no mês + receitas avulsas do mês
//                       (competência = mês da data da receita)
//   saidasConfirmadas = soma das despesas com statusDespesa 'confirmado' cuja
//                       COMPETÊNCIA é o mês (cartão → fatura.mesFatura;
//                       sem fatura → mês da data real). Previstas nunca entram.

(function (raiz) {
  function numeroValido(v) { return typeof v === 'number' && isFinite(v); }
  function arred2(v) { return Math.round(v * 100) / 100; }

  // =====================================================================
  // 1) BATERIA FINANCEIRA
  // ---------------------------------------------------------------------
  // Pergunta que responde: "quanto do dinheiro que entrou neste mês ainda
  // não foi gasto?"
  //   entrada ........ entradas do mês (E) e saídas confirmadas do mês (S)
  //   referência ..... as próprias entradas do mês (E)
  //   fórmula ........ nivel = (E − S) / E, limitado ao intervalo [0, 1]
  //   100% ........... nada foi gasto ainda (S = 0)
  //   50% ............ metade das entradas do mês já foi gasta (S = E/2)
  //   0% ............. gastou tudo o que entrou (S = E) ou mais que isso
  //   renda zero ..... E = 0 → estado 'sem_renda', nivel = null (não existe
  //                    percentual sem referência; nunca mostra 0% ou 100%)
  //   sem dados ...... E = 0 e S = 0 → estado 'sem_dados', nivel = null
  //   negativos ...... S > E → nivel 0 e estado 'negativa' com o déficit
  //                    (S − E) informado; E < 0 ou S < 0 → estado
  //                    'dados_invalidos', nivel = null (nunca adivinha)
  //   faixas ......... ≥ 50% 'alta', 20% a 50% 'media', < 20% 'baixa'
  //                    (só a cor/rótulo; o percentual é sempre o exato)
  // =====================================================================
  const BATERIA_FAIXA_MEDIA = 0.20;
  const BATERIA_FAIXA_ALTA = 0.50;

  function avaliarBateria({ entradas, saidasConfirmadas }) {
    const E = entradas;
    const S = saidasConfirmadas;
    if (!numeroValido(E) || !numeroValido(S) || E < 0 || S < 0) {
      return { estado: 'dados_invalidos', nivel: null, percentual: null, texto: 'Não foi possível calcular: há valores inválidos.' };
    }
    if (E === 0 && S === 0) {
      return { estado: 'sem_dados', nivel: null, percentual: null, texto: 'Sem dados neste mês: cadastre sua renda e seus gastos.' };
    }
    if (E === 0) {
      return { estado: 'sem_renda', nivel: null, percentual: null, gasto: arred2(S), texto: 'Cadastre a renda do mês para calcular a bateria.' };
    }
    const bruto = (E - S) / E;
    const nivel = Math.min(1, Math.max(0, bruto));
    const percentual = arred2(nivel * 100);
    if (S > E) {
      return { estado: 'negativa', nivel: 0, percentual: 0, deficit: arred2(S - E), faixa: 'baixa', texto: `Os gastos confirmados passaram as entradas do mês em ${arred2(S - E).toFixed(2).replace('.', ',')}.` };
    }
    const faixa = nivel >= BATERIA_FAIXA_ALTA ? 'alta' : nivel >= BATERIA_FAIXA_MEDIA ? 'media' : 'baixa';
    return { estado: 'ok', nivel, percentual, restante: arred2(E - S), faixa, texto: `Ainda restam ${percentual.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}% das entradas do mês.` };
  }

  // =====================================================================
  // 2) GASTOS SOB CONTROLE
  // ---------------------------------------------------------------------
  // Pergunta: "o que eu já gastei neste mês cabe na minha renda, com folga?"
  //   entrada ........ E e S (mesmas definições acima)
  //   referência ..... entradas do mês (E) — é % DA RENDA, não dos gastos
  //   fórmula ........ uso = S / E
  //   limites ........ uso ≤ 80% → 'sob_controle' (sobra pelo menos 20% das
  //                    entradas, a mesma folga mínima que o app recomenda
  //                    manter para reserva/investimento);
  //                    80% < uso ≤ 100% → 'atencao';
  //                    uso > 100% → 'acima_da_renda'
  //   sem renda ...... E = 0 → 'sem_renda' (sem conclusão)
  //   sem gasto ...... S = 0 → 'sem_gastos' (sem conclusão: não diz "sob
  //                    controle" quando não há o que avaliar)
  // Não usa 30% em lugar nenhum.
  // =====================================================================
  const SOB_CONTROLE_LIMITE_ATENCAO = 0.80;
  const SOB_CONTROLE_LIMITE_ESTOURO = 1.00;

  function avaliarGastosSobControle({ entradas, saidasConfirmadas }) {
    const E = entradas;
    const S = saidasConfirmadas;
    if (!numeroValido(E) || !numeroValido(S) || E < 0 || S < 0) {
      return { estado: 'dados_invalidos', uso: null, titulo: 'Sem avaliação', texto: 'Há valores inválidos no mês.' };
    }
    if (E === 0) {
      return { estado: 'sem_renda', uso: null, titulo: 'Sem avaliação', texto: 'Cadastre a renda do mês para avaliar se os gastos estão sob controle.' };
    }
    if (S === 0) {
      return { estado: 'sem_gastos', uso: 0, titulo: 'Sem gastos confirmados', texto: 'Ainda não há gastos confirmados neste mês.' };
    }
    const uso = S / E;
    const pct = (uso * 100).toFixed(0);
    if (uso <= SOB_CONTROLE_LIMITE_ATENCAO) {
      return { estado: 'sob_controle', uso, titulo: 'Gastos sob controle', texto: `Você usou ${pct}% das entradas do mês. Sobram pelo menos 20% para reserva ou investimento.` };
    }
    if (uso <= SOB_CONTROLE_LIMITE_ESTOURO) {
      return { estado: 'atencao', uso, titulo: 'Atenção', texto: `Você já usou ${pct}% das entradas do mês. A folga para reserva está abaixo de 20%.` };
    }
    return { estado: 'acima_da_renda', uso, titulo: 'Gastos acima da renda', texto: `Os gastos confirmados chegaram a ${pct}% das entradas do mês.` };
  }

  // =====================================================================
  // 3) COMPROMETIMENTO DO CARTÃO COM PARCELAS (regra original do projeto)
  // ---------------------------------------------------------------------
  // Pergunta: "as parcelas que já contratei vão pesar demais no mês que vem?"
  //   entrada ........ P = soma das parcelas (confirmadas ou previstas) cuja
  //                    competência é o PRÓXIMO mês
  //   referência ..... R = renda do próximo mês (renda fixa vigente)
  //   fórmula ........ c = P / R
  //   limite ......... c > 30% → desaconselhar novas compras parceladas.
  //                    Esse 30% é exclusivo deste indicador.
  //   renda zero ..... sem avaliação
  // =====================================================================
  const COMPROMETIMENTO_PARCELAS_LIMITE = 0.30;

  function avaliarComprometimentoCartao(parcelasProximoMes, rendaReferencia) {
    if (!numeroValido(rendaReferencia) || rendaReferencia <= 0) {
      return { bloquear: false, percentual: null, texto: 'Cadastre sua renda para monitorar o comprometimento do cartão.' };
    }
    const P = numeroValido(parcelasProximoMes) && parcelasProximoMes > 0 ? parcelasProximoMes : 0;
    const c = P / rendaReferencia;
    const pct = (c * 100).toFixed(0);
    if (c > COMPROMETIMENTO_PARCELAS_LIMITE) {
      return { bloquear: true, percentual: c * 100, texto: `Suas parcelas do próximo mês comprometem ${pct}% da renda. Novas compras parceladas estão desaconselhadas agora.` };
    }
    return { bloquear: false, percentual: c * 100, texto: `Parcelas do próximo mês: ${pct}% da renda, dentro do limite de 30%.` };
  }

  // =====================================================================
  // 4) ONDE POSSO POUPAR?
  // ---------------------------------------------------------------------
  // Recebe a evolução POR CATEGORIA (cada mês com total ou null = sem dados
  // daquela categoria) e o mês analisado. Para cada categoria:
  //   mesesComDados .. quantidade de meses (até o mês analisado, inclusive)
  //                    em que ESTA categoria teve gasto confirmado
  //   confiança ...... 0–1 mês: 'insuficiente'; 2: 'baixa' (comparação
  //                    inicial); 3: 'tendencia'; 4+: 'confiavel'
  //   média .......... média dos meses ANTERIORES com dados (nunca conta
  //                    mês sem dados como zero)
  //   oportunidade ... só com confiança ≥ 'tendencia', o mês analisado com
  //                    dados, valor atual > média × 1,15 e diferença ≥ R$20.
  //                    Gasto isolado ou só 2 meses nunca vira "oportunidade".
  //   economia ....... excesso sobre a média (voltar ao seu padrão). Para
  //                    categorias discricionárias também mostra a faixa de
  //                    corte de 10% a 15% do valor atual (regra do projeto).
  // =====================================================================
  const POUPAR_VARIACAO_MINIMA = 0.15;
  const POUPAR_DIFERENCA_MINIMA = 20;

  function confiancaPorMeses(n) {
    if (n <= 1) return 'insuficiente';
    if (n === 2) return 'baixa';
    if (n === 3) return 'tendencia';
    return 'confiavel';
  }

  function avaliarOndePoupar(evolucaoPorCategoria, mesReferencia, naturezaPorNome = {}) {
    const resultado = [];
    for (const cat of evolucaoPorCategoria) {
      const meses = cat.meses.filter((m) => m.mesISO <= mesReferencia);
      const comDados = meses.filter((m) => m.temDados);
      const atual = meses.find((m) => m.mesISO === mesReferencia);
      const anteriores = comDados.filter((m) => m.mesISO < mesReferencia);
      const n = comDados.length;
      const confianca = confiancaPorMeses(n);
      const media = anteriores.length > 0 ? anteriores.reduce((s, m) => s + m.total, 0) / anteriores.length : null;
      const valorAtual = atual && atual.temDados ? atual.total : null;

      let oportunidade = false;
      let economiaPotencial = null;
      let faixaCorte = null;
      let variacao = null;
      if (valorAtual !== null && media !== null && media > 0) variacao = (valorAtual - media) / media;

      if ((confianca === 'tendencia' || confianca === 'confiavel') && valorAtual !== null && media !== null
        && valorAtual > media * (1 + POUPAR_VARIACAO_MINIMA) && valorAtual - media >= POUPAR_DIFERENCA_MINIMA) {
        oportunidade = true;
        economiaPotencial = arred2(valorAtual - media);
        if (naturezaPorNome[cat.nome] === 'discricionaria') {
          faixaCorte = { de: arred2(valorAtual * 0.10), ate: arred2(valorAtual * 0.15) };
        }
      }

      resultado.push({
        categoriaId: cat.categoriaId, nome: cat.nome, mesesComDados: n, confianca,
        valorAtual, media: media === null ? null : arred2(media), variacao, oportunidade, economiaPotencial, faixaCorte
      });
    }
    return resultado.sort((a, b) => (b.oportunidade - a.oportunidade) || ((b.economiaPotencial || 0) - (a.economiaPotencial || 0)));
  }

  // =====================================================================
  // 5) RESERVA FINANCEIRA
  // ---------------------------------------------------------------------
  //   entrada ........ valorAtual, meta, prazoMeses (opcional)
  //   meta ≤ 0 ou ausente → 'meta_nao_definida' (NUNCA "formada")
  //   valorAtual < meta → 'em_formacao', percentual = atual/meta
  //   valorAtual ≥ meta → 'formada'
  //   aporte mensal .. só existe quando prazoMeses > 0 foi configurado:
  //                    (meta − atual) / prazoMeses. Sem prazo → null (o app
  //                    não inventa prazo, aporte nem contribuição).
  // =====================================================================
  function avaliarReserva(reserva) {
    const valorAtual = reserva && numeroValido(reserva.valorAtual) ? reserva.valorAtual : 0;
    const meta = reserva && numeroValido(reserva.meta) ? reserva.meta : 0;
    const prazoMeses = reserva && numeroValido(reserva.prazoMeses) && reserva.prazoMeses > 0 ? Math.floor(reserva.prazoMeses) : null;

    if (meta <= 0) {
      return { estado: 'meta_nao_definida', valorAtual, meta: null, percentual: null, faltante: null, prazoMeses, aporteMensalNecessario: null };
    }
    const faltante = Math.max(0, arred2(meta - valorAtual));
    const percentual = arred2(Math.min(1, valorAtual / meta) * 100);
    const estado = valorAtual >= meta ? 'formada' : 'em_formacao';
    const aporteMensalNecessario = estado === 'em_formacao' && prazoMeses ? arred2(faltante / prazoMeses) : null;
    return { estado, valorAtual, meta, percentual, faltante, prazoMeses, aporteMensalNecessario };
  }

  const AVISO_RISCO = 'Aviso: investimentos podem ter perdas. Tesouro IPCA+ oscila de preço se vendido antes do vencimento. CDB, LCI e LCA têm garantia do FGC até R$250 mil por instituição. Rentabilidade passada não garante rentabilidade futura.';

  function recomendarInvestimento(avaliacaoReserva) {
    if (avaliacaoReserva.estado === 'meta_nao_definida') {
      return { texto: 'Defina a meta da reserva em "Mais". Enquanto isso, o mais seguro é guardar em Tesouro Selic ou CDB 100% do CDI com liquidez diária.', aviso: AVISO_RISCO };
    }
    if (avaliacaoReserva.estado === 'em_formacao') {
      return { texto: 'Reserva ainda não formada: priorize 100% em Tesouro Selic ou CDB 100% do CDI com liquidez diária.', aviso: AVISO_RISCO };
    }
    return { texto: 'Reserva formada. Para objetivos de até 2 anos, considere LCI/LCA (isentas de IR). Para prazos mais longos, Tesouro IPCA+.', aviso: AVISO_RISCO };
  }

  const Analises = {
    BATERIA_FAIXA_MEDIA, BATERIA_FAIXA_ALTA, SOB_CONTROLE_LIMITE_ATENCAO, SOB_CONTROLE_LIMITE_ESTOURO,
    COMPROMETIMENTO_PARCELAS_LIMITE, POUPAR_VARIACAO_MINIMA, POUPAR_DIFERENCA_MINIMA, AVISO_RISCO,
    avaliarBateria, avaliarGastosSobControle, avaliarComprometimentoCartao, confiancaPorMeses,
    avaliarOndePoupar, avaliarReserva, recomendarInvestimento
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Analises;
  if (raiz) raiz.Analises = Analises;
})(typeof window !== 'undefined' ? window : null);
