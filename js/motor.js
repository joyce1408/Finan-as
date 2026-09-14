// motor.js
// Regras condicionais de análise financeira — nada de API externa,
// só lógica if/else rodando no dispositivo.

function avaliarPoupanca(rendaMensal, gastoEstiloVida) {
  if (!rendaMensal) return { alerta: false, texto: 'Cadastre sua renda para receber sugestões de economia.' };
  const percentual = gastoEstiloVida / rendaMensal;
  if (percentual > 0.30) {
    const corte = gastoEstiloVida * 0.125;
    return {
      alerta: true,
      texto: `Seus gastos com Delivery, Assinaturas e Lazer passam de 30% da renda. Um corte de 10% a 15% aqui libera cerca de R$ ${corte.toFixed(2).replace('.', ',')}.`
    };
  }
  return { alerta: false, texto: 'Seus gastos de estilo de vida estão sob controle este mês.' };
}

function avaliarComprometimentoCartao(parcelasProximoMes, rendaMensal) {
  if (!rendaMensal) return { bloquear: false, texto: 'Cadastre sua renda para monitorar o comprometimento do cartão.' };
  const comprometimento = parcelasProximoMes / rendaMensal;
  if (comprometimento > 0.30) {
    return {
      bloquear: true,
      texto: `Suas parcelas comprometem ${(comprometimento * 100).toFixed(0)}% da sua renda do próximo mês. Novas compras parceladas estão desaconselhadas agora.`
    };
  }
  return { bloquear: false, texto: `Comprometimento do cartão em ${(comprometimento * 100).toFixed(0)}% — dentro do limite seguro.` };
}

function recomendarInvestimento(reservaAtual, metaReserva, prazoMeses) {
  if (reservaAtual < metaReserva) {
    return 'Sem reserva formada: priorize 100% em Tesouro Selic ou CDB 100% do CDI com liquidez diária — a Caixinha do Nubank, por exemplo, funciona nesse formato (é um CDB com liquidez diária) e é uma forma prática de começar.';
  }
  if (prazoMeses <= 24) {
    return 'Reserva formada, objetivo de até 2 anos: considere LCI/LCA (isentos de Imposto de Renda).';
  }
  return 'Reserva formada, objetivo de longo prazo: considere Tesouro IPCA+.';
}

function statusLimite(percentual) {
  if (percentual >= 85) return 'danger';
  if (percentual >= 70) return 'warn';
  return 'ok';
}

window.Motor = {
  avaliarPoupanca, avaliarComprometimentoCartao, recomendarInvestimento, statusLimite
};
