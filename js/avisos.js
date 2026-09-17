// avisos.js — Central de Avisos: gera localmente, a cada abertura do app,
// os mesmos alertas que seriam notificações push — sem precisar de servidor
// (notificações push agendadas de verdade exigiriam infraestrutura paga,
// o que quebraria a regra de custo zero do projeto).

async function gerarAvisos() {
  const avisos = [];
  const hoje = new Date();

  // 1) Fatura vencendo em até 3 dias (ou já vencida e ainda não paga) —
  // sempre a partir das faturas reais, nunca mais recalculado por data
  const faturas = await DB.faturasClassificadas();
  for (const f of faturas) {
    if (f.situacao === 'vencida') {
      avisos.push({
        tipo: 'alerta',
        icone: '💳',
        texto: `Fatura do ${f.cartaoNome} venceu há ${Math.abs(f.diasRestantes)} dia(s) e ainda está marcada como não paga — ${f.totalOficial.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`
      });
    } else if (f.situacao === 'proxima' && f.diasRestantes <= 3) {
      avisos.push({
        tipo: 'alerta',
        icone: '💳',
        texto: `Fatura do ${f.cartaoNome} vence em ${f.diasRestantes} dia(s) — ${f.totalOficial.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Separe o valor com antecedência.`
      });
    }
  }

  // 2) Lembrete noturno, se ainda não registrou nada hoje
  if (hoje.getHours() >= 20) {
    const registrouHoje = await DB.houveDespesaHoje();
    if (!registrouHoje) {
      avisos.push({
        tipo: 'lembrete',
        icone: '🌙',
        texto: 'Você ainda não registrou nenhum gasto hoje. Leva 10 segundos e mantém seu controle em dia.'
      });
    }
  }

  // 3) Comparação da semana atual com a semana anterior
  const fimSemanaAtual = hoje;
  const inicioSemanaAtual = new Date(hoje);
  inicioSemanaAtual.setDate(hoje.getDate() - 6);

  const fimSemanaAnterior = new Date(inicioSemanaAtual);
  fimSemanaAnterior.setDate(inicioSemanaAtual.getDate() - 1);
  const inicioSemanaAnterior = new Date(fimSemanaAnterior);
  inicioSemanaAnterior.setDate(fimSemanaAnterior.getDate() - 6);

  const gastoSemanaAtual = await DB.totalDespesasEntre(inicioSemanaAtual, fimSemanaAtual);
  const gastoSemanaAnterior = await DB.totalDespesasEntre(inicioSemanaAnterior, fimSemanaAnterior);

  if (gastoSemanaAnterior > 0 && gastoSemanaAtual < gastoSemanaAnterior) {
    const percentual = ((gastoSemanaAnterior - gastoSemanaAtual) / gastoSemanaAnterior) * 100;
    avisos.push({
      tipo: 'sucesso',
      icone: '🌟',
      texto: `Você gastou ${percentual.toFixed(0)}% menos essa semana do que na anterior. Continue assim!`
    });
  }

  // 4) Sugestão de enviar a sobra do mês para a reserva
  const entradas = await DB.entradasTotaisDoMes();
  const despesasDoMes = await DB.totalGastoNoMes();
  const saldo = entradas - despesasDoMes;
  const reservas = await DB.listarTodos('reserva');
  const reserva = reservas[0] || { valorAtual: 0, meta: 15000 };

  if (saldo > 100 && reserva.valorAtual < reserva.meta) {
    avisos.push({
      tipo: 'sugestao',
      icone: '💰',
      texto: `Sobrou ${saldo.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} este mês. Que tal transferir para sua reserva de emergência?`
    });
  }

  // 5) Comprometimento alto do cartão frente à renda
  const parcelas = await DB.parcelasProximoMes();
  const avaliacaoCartao = Motor.avaliarComprometimentoCartao(parcelas, entradas);
  if (avaliacaoCartao.bloquear) {
    avisos.push({ tipo: 'alerta', icone: '⚠️', texto: avaliacaoCartao.texto });
  }

  return avisos;
}

window.Avisos = { gerarAvisos };
