// avisos.js — Central de Avisos: gera localmente, a cada abertura do app,
// os alertas que seriam notificações push (sem servidor, custo zero).

async function gerarAvisos() {
  const avisos = [];
  const moeda = (v) => UI.moeda(v);

  // 1) Faturas vencendo em até 3 dias, vencidas não pagas, ou com
  //    divergência de importação (soma dos itens acima do total oficial)
  const faturas = await DB.faturasClassificadas();
  for (const f of faturas) {
    if (f.situacao === 'vencida') {
      avisos.push({ tipo: 'alerta', icone: '💳', texto: `Fatura do ${f.cartaoNome} venceu há ${Math.abs(f.diasRestantes)} dia(s) e ainda está marcada como não paga: ${moeda(f.totalOficial)}.` });
    } else if (f.situacao === 'proxima' && f.diasRestantes !== null && f.diasRestantes <= 3) {
      avisos.push({ tipo: 'alerta', icone: '💳', texto: `Fatura do ${f.cartaoNome} vence em ${f.diasRestantes} dia(s): ${moeda(f.totalOficial)}. Separe o valor com antecedência.` });
    }
    if (f.divergencia && f.divergencia.tipo === 'soma_acima_do_total') {
      avisos.push({ tipo: 'alerta', icone: '🔎', texto: `Fatura ${Datas.rotuloMes(f.mesFatura)} do ${f.cartaoNome}: os lançamentos somam ${moeda(f.divergencia.somaItens)}, acima do total oficial de ${moeda(f.divergencia.totalOficial)}. Revise os itens.` });
    }
  }

  // 2) Parcelas que precisam de revisão manual (reconciliação ambígua)
  const pendentes = (await DB.listarTodos('despesa')).filter((d) => d.pendenteReconciliacao);
  if (pendentes.length > 0) {
    avisos.push({ tipo: 'lembrete', icone: '🧩', texto: `${pendentes.length} parcela(s) importada(s) não puderam ser ligadas com segurança a um parcelamento. Confira em Cartões.` });
  }

  // 3) Lembrete noturno, se ainda não registrou nada hoje
  if (Datas.agora().getHours() >= 20 && !(await DB.houveDespesaHoje())) {
    avisos.push({ tipo: 'lembrete', icone: '🌙', texto: 'Você ainda não registrou nenhum gasto hoje. Leva 10 segundos e mantém seu controle em dia.' });
  }

  // 4) Semana atual × semana anterior (dias reais de compra)
  const hoje = Datas.hojeISO();
  const menosDias = (dia, n) => { const [a, m, d] = dia.split('-').map(Number); const t = new Date(Date.UTC(a, m - 1, d - n)); return Datas.montarDiaISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
  const gastoSemanaAtual = await DB.totalDespesasEntre(menosDias(hoje, 6), hoje);
  const gastoSemanaAnterior = await DB.totalDespesasEntre(menosDias(hoje, 13), menosDias(hoje, 7));
  if (gastoSemanaAnterior > 0 && gastoSemanaAtual > 0 && gastoSemanaAtual < gastoSemanaAnterior) {
    const percentual = ((gastoSemanaAnterior - gastoSemanaAtual) / gastoSemanaAnterior) * 100;
    avisos.push({ tipo: 'sucesso', icone: '🌟', texto: `Você gastou ${percentual.toFixed(0)}% menos essa semana do que na anterior. Continue assim!` });
  }

  // 5) Sobra do mês → reserva (só quando existe meta definida e não atingida)
  const { entradas, saldo } = await DB.saldoDisponivelDoMes();
  const reserva = Analises.avaliarReserva(await DB.obterReserva());
  if (saldo > 100 && reserva.estado === 'em_formacao') {
    avisos.push({ tipo: 'sugestao', icone: '💰', texto: `Sobrou ${moeda(saldo)} este mês. Que tal transferir para sua reserva de emergência?` });
  }

  // 6) Parcelas do próximo mês × renda do próximo mês (limite de 30%)
  const mesSeguinte = DB.somarMesISO(DB.mesAtualISO(), 1);
  const avaliacaoCartao = Analises.avaliarComprometimentoCartao(await DB.parcelasProximoMes(), await DB.rendaAtual(mesSeguinte));
  if (avaliacaoCartao.bloquear && entradas >= 0) {
    avisos.push({ tipo: 'alerta', icone: '⚠️', texto: avaliacaoCartao.texto });
  }

  return avisos;
}

window.Avisos = { gerarAvisos };
