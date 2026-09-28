# Finanças Fácil — PWA local

App de controle financeiro pessoal. Roda 100% no seu iPhone, sem servidor,
sem nuvem, sem custo. Todos os dados ficam no IndexedDB do Safari, no
próprio aparelho.

## Como rodar localmente (para testar no computador)

Como o app usa `service-worker.js`, ele precisa ser servido por HTTP (não
funciona abrindo o `index.html` direto como arquivo `file://`). Formas
simples de servir localmente:

```
# Python já vem instalado na maioria dos sistemas
cd financas-pwa
python3 -m http.server 8000
```

Depois acesse `http://localhost:8000` no navegador.

## Como instalar no iPhone

1. Coloque esses arquivos em algum lugar acessível pelo Safari do iPhone
   (ex.: hospede numa pasta local via um serviço simples como GitHub Pages,
   ou sirva na sua própria rede Wi-Fi com o comando acima e acesse pelo IP
   do computador, ex.: `http://192.168.0.10:8000`)
2. Abra o endereço no **Safari** do iPhone (tem que ser Safari, não Chrome)
3. Toque no ícone de compartilhar (□ com seta para cima)
4. Toque em **"Adicionar à Tela de Início"**
5. Pronto — o app abre como um app nativo, com ícone próprio, sem barra
   do navegador, e continua funcionando offline depois da primeira visita

## Estrutura

```
financas-pwa/
 ├── index.html          Tela inicial + modal de cadastro de despesa
 ├── manifest.json        Configuração do PWA (nome, ícone, cores)
 ├── service-worker.js    Cache local para funcionar offline
 ├── css/style.css        Design system (cores, componentes)
 ├── js/db.js              Banco de dados local (IndexedDB)
 ├── js/motor.js           Regras de poupança/investimento/cartão
 ├── js/app.js             Liga tudo e renderiza a tela
 └── assets/logos/         Coloque aqui logos de bancos baixados por você
                            (ex.: nubank.png, inter.png) — o código já
                            está comentado indicando onde trocar o
                            avatar de iniciais pela imagem real
```

## O que já funciona

- **Início**: saldo, gastos por categoria e próximas faturas calculados de dados reais
- **Cadastro**: botão "+" com alternância Despesa/Receita, salvando de verdade
- **Transações**: extrato completo (despesas + receitas), busca, filtro por forma de pagamento e por período (mês/ano)
- **Cartões**: listagem com fatura atual e barra de limite; tela de detalhe por cartão (`cartao-detalhe.html?id=`) com compras do mês; cadastro de novo cartão
- **Relatórios**: visão geral do mês (com variação vs. mês passado), evolução diária dos gastos, categorias com drill-down das compras, insights de poupança/investimento (motor de regras), comprometimento do cartão frente à renda
- **Mais**: contadores reais, edição de meta de reserva e renda mensal, exportar dados em JSON, apagar todos os dados
- **Segurança**: tela de bloqueio por PIN de 4 dígitos. Se Face ID/Touch ID estiver configurado, ele dispara **automaticamente** assim que a tela de bloqueio aparece — sem precisar tocar em nada — e cai sozinho pro teclado de PIN se falhar (rosto coberto, sem luz, cancelou, etc.), então nunca trava o acesso. Isso usa WebAuthn, o equivalente correto de BiometricPrompt/LocalAuthentication dentro de um PWA — a validação acontece no processador seguro do aparelho, e nenhuma imagem facial ou digital chega ao app ou ao banco de dados.
- **Chave de Recuperação**: ao criar (ou trocar) o PIN, o app gera uma chave de 4 palavras em português (ex.: `casa-carro-sol-chuva`) e pede pra você anotar. "Esqueci meu PIN" nunca apaga os dados diretamente — ele pede essa chave, e se estiver certa, deixa você criar um PIN novo com todos os dados intactos. Só existe uma opção de apagar tudo como último recurso, separada, exigindo digitar "APAGAR TUDO" — para quem realmente perdeu a chave e o PIN.
- **Importar fatura (CSV, PDF ou foto)**: Cartões → cartão → Faturas → Importar fatura. Antes de gravar mostra uma prévia com cartão, mês da fatura, fechamento, vencimento, total oficial, quantidade de itens e a categoria sugerida de cada item (editável). Aceita faturas antigas, trata reimportação sem duplicar e cria no máximo um "Ajuste OCR" por fatura.
- **Central de Avisos**: substitui as notificações push tradicionais — que exigiriam um servidor rodando o tempo todo, quebrando a regra de custo zero. Em vez disso, toda vez que você abre o app, ele recalcula na hora os mesmos alertas (fatura vencendo, lembrete de registrar gasto, comparação com a semana anterior, sugestão de reserva, comprometimento do cartão) e mostra na Home
- **Onboarding**: tela de boas-vindas que aparece só no primeiro acesso (marcador salvo em `localStorage`), depois disso vai direto pra Home
- **Alertas visuais dinâmicos**: o card de saldo pulsa em vermelho quando o saldo cai a 15% ou menos da renda do mês; cards de cartão pulsam em laranja/vermelho quando a fatura atinge 80% ou mais do limite; e quando está tudo tranquilo (sem fatura vencendo em 3 dias, saldo positivo e reserva formada), aparece um aviso calmo em verde no topo da Home, sem nenhuma piscada
- **Ocultar valores**: botão de olho no card de saldo e no card de reserva — os valores começam sempre ocultos (`R$ ••••`) toda vez que você reabre o app, e só aparecem se você tocar no ícone

- **Leitura de fatura por foto, PDF ou CSV (OCR)**: agora é **um único botão** ("📎 Importar fatura") na tela de detalhe do cartão — o app identifica sozinho se é foto, PDF ou CSV e lê do jeito certo. PDF é renderizado localmente com PDF.js (biblioteca gratuita, 100% no navegador) e cada página passa por um filtro de binarização (preto e branco) antes do OCR, o que melhora bastante a precisão em fotos com sombra ou papel amarelado. Tudo roda no aparelho — nenhum arquivo é enviado a servidor nenhum. Como PDF.js e Tesseract.js vêm de um CDN externo, a **primeira leitura** exige internet; depois disso o navegador tende a cachear as bibliotecas. Sempre mostra uma prévia antes de importar, porque OCR de documento real erra às vezes.
- **Forma de pagamento explícita**: o "+" agora pede a forma de pagamento (Cartão de Crédito, Débito Automático, Dinheiro, Pix ou Boleto) antes de perguntar qual cartão — só pede o cartão se for "Cartão de Crédito"

## Regras financeiras (versão 1.1)

- **Competência**: compra com fatura conta no mês da fatura (`fatura.mesFatura`), nunca pela data real, que é preservada. Pix, dinheiro, débito, boleto e receitas contam pelo mês da própria data. Parcela prevista conta no mês previsto.
- **Previsto x confirmado**: só `statusDespesa = confirmado` entra em gastos realizados, categorias, saldo e relatórios. Previstas aparecem em "Compromissos futuros" e no comprometimento do cartão.
- **Parcelamentos**: cada série tem `idParcelamento`. Conhecendo a 8/12, o app cria 9/12 a 12/12 como previstas e nunca recria 1/12 a 7/12. Quando a parcela real chega numa fatura, a previsão da mesma série é convertida (sem duplicar). Casos ambíguos ficam marcados para revisão.
- **Categorias**: 11 fixas (Moradia, Alimentação, Transporte, Assinaturas, Saúde, Pet, Vestuário, Compras, Lazer, Taxas e encargos, Outros). A escolha manual nunca é sobrescrita pela automática. Categorias antigas foram desativadas (não apagadas) e a migração fica registrada em `meta.log_migracao_categorias_v6`.
- **Datas**: toda data financeira é um dia `AAAA-MM-DD`, que não muda com o fuso do aparelho. Registros antigos gravados com horário são lidos no fuso em que foram criados (São Paulo), sem serem regravados.
- **Indicadores** (definições completas em `js/analises.js`): bateria = (entradas − gastos confirmados) ÷ entradas; gastos sob controle = gastos ÷ entradas (até 80% sob controle, até 100% atenção); comprometimento = parcelas do próximo mês ÷ renda (limite de 30%, só deste indicador); onde poupar exige pelo menos 3 meses de dados da categoria; reserva com meta 0 = "meta não definida".
- **Backup**: "Exportar meus dados" inclui todas as stores do banco (inclusive aportes, faturas e o log de migrações). "Restaurar" valida tudo antes, pede confirmação se já houver dados e preserva os IDs.
- **Excluir cartão** agora arquiva: faturas e compras continuam no histórico.

## Testes

`npm test` roda a suíte inteira em America/Sao_Paulo, UTC e Asia/Tokyo, com um IndexedDB falso em memória (nenhum dado real).
`node ferramentas/validar-backup.js backup.json 2026-08 2026-09` confere um backup real sem alterá-lo: valida, simula a restauração e as migrações e mostra faturas, parcelamentos, mudanças de categoria e totais por competência.

## Limitações conhecidas / próximos passos possíveis

- Sem recuperação de PIN esquecido além de apagar tudo e recomeçar (é a natureza de um app 100% local, sem servidor para validar identidade)
- Sem criptografia dos dados em repouso no IndexedDB (endurecimento futuro possível via Web Crypto API)
- Sem leitura de fatura em PDF (só CSV por enquanto — PDF exigiria uma lib de OCR, que pesa bastante para rodar 100% no navegador)
- Central de Avisos só aparece quando o app está aberto — não existe notificação de verdade tocando com o app fechado (isso exigiria Web Push + servidor)
- O alerta "crítico" de saldo usa uma aproximação (15% da renda), já que o app ainda não rastreia quais contas fixas já foram pagas dentro do mês — cadastrar isso deixaria o alerta mais preciso

