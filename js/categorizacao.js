// categorizacao.js — taxonomia DEFINITIVA de categorias (finalidade do gasto)
// e o motor de categorização automática por descrição.
//
// Só existem 11 categorias. "Fast Food", "Delivery", "Medicamentos" e
// "Marketplace" NÃO são categorias: são tipos de gasto dentro delas.
// Regra fundamental: categoria escolhida pela pessoa (categoriaManual ou
// editadoManualmente) nunca é sobrescrita pela categorização automática.

(function (raiz) {
  // natureza: usada só como informação nas análises (ex.: "Onde posso
  // poupar" sugere corte percentual apenas em gastos discricionários).
  const CATEGORIAS_DEFINITIVAS = [
    { nome: 'Moradia', icone: '🏠', natureza: 'essencial' },
    { nome: 'Alimentação', icone: '🍴', natureza: 'essencial' },
    { nome: 'Transporte', icone: '🚗', natureza: 'essencial' },
    { nome: 'Assinaturas', icone: '📺', natureza: 'discricionaria' },
    { nome: 'Saúde', icone: '💊', natureza: 'essencial' },
    { nome: 'Pet', icone: '🐾', natureza: 'essencial' },
    { nome: 'Vestuário', icone: '👕', natureza: 'discricionaria' },
    { nome: 'Compras', icone: '🛍️', natureza: 'discricionaria' },
    { nome: 'Lazer', icone: '🍿', natureza: 'discricionaria' },
    { nome: 'Taxas e encargos', icone: '🧾', natureza: 'essencial' },
    { nome: 'Outros', icone: '💬', natureza: 'indefinida' }
  ];

  const NOMES_DEFINITIVOS = CATEGORIAS_DEFINITIVAS.map((c) => c.nome);

  function normalizar(texto) {
    return String(texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  // "Espacolasersp - Parcela 8/12" → "espacolasersp". Usado para comparar
  // estabelecimentos (reconciliação de parcelas e reimportação).
  function chaveEstabelecimento(descricao) {
    return normalizar(descricao)
      .replace(/parc(?:ela)?\.?\s*\d{1,2}\s*\/\s*\d{1,2}/g, ' ')
      .replace(/\(.*?prevista\)/g, ' ')
      .replace(/[^a-z0-9]/g, '');
  }

  function nomeDefinitivoPorNome(nome) {
    const n = normalizar(nome);
    return NOMES_DEFINITIVOS.find((d) => normalizar(d) === n) || null;
  }

  // ---------- Regras por descrição (a ordem importa) ----------
  // Cada regra: [categoria, lista de padrões]. Padrões são testados contra a
  // descrição normalizada (sem acento, minúscula). A PRIMEIRA regra que bater
  // decide. Regras mais específicas vêm antes (ex.: "IOF ... Netflix" é Taxa;
  // "Uber Eats" é Alimentação antes de "Uber" ser Transporte; "Amazon Prime"
  // é Assinatura antes da regra de Amazon).
  const PALAVRAS_ROUPA = /(roupa|camis|camiseta|blusa|vestido|calca|bermuda|short|saia|jaqueta|casaco|moletom|meia|cueca|calcinha|sutia|lingerie|tenis|sapato|sandalia|chinelo|bota|calcado|moda|fashion|vestuario|bone)/;
  const PALAVRAS_ELETRONICO = /(eletron|celular|smartphone|iphone|fone|headset|notebook|laptop|tablet|ipad|monitor|teclado|mouse|carregador|cabo usb|cabo hdmi|\bcabo\b|smartwatch|smart tv|televisao|\btv\b|camera|console|ssd|hd externo|pendrive|roteador|caixa de som|alexa|echo dot|kindle)/;

  const REGRAS = [
    ['Taxas e encargos', [/\biof\b/, /tarifa/, /anuidade/, /juros/, /\bmulta\b/, /encargo/, /enc\.? financ/, /rotativo/, /\btaxa\b/, /seguro (do )?cartao/, /cesta de servicos/]],
    ['Assinaturas', [/netflix/, /spotify/, /disney/, /\bhbo\b/, /hbomax/, /\bmax\.com/, /prime ?video/, /amazon ?prime/, /primevideo/, /youtube ?premium/, /youtubepremium/, /google ?one/, /globoplay/, /deezer/, /apple\.?com\/?bill/, /applecombill/, /icloud/, /paramount/, /crunchyroll/, /openai/, /chatgpt/, /anthropic/, /claude\.ai/, /microsoft ?365/, /office ?365/, /adobe/, /xbox game ?pass/, /playstation plus/, /ps plus/, /\bassinatura/]],
    ['Alimentação', [/uber ?eats/, /ubereats/, /99 ?food/, /ifood/, /\brappi/, /ze ?delivery/, /aiqfome/]],
    ['__marketplace__', [/amazon/, /amzn/, /mercado ?livre/, /mercadolivre/, /\bmeli\b/, /mercadopago/, /mercado ?pago/, /shopee/, /aliexpress/, /shein/]],
    // Pet vem antes de Saúde: "clínica veterinária" é Pet, não Saúde
    ['Pet', [/veterinari/, /\bvet\b/, /pet ?shop/, /\bpetz\b/, /cobasi/, /racao/, /petlove/, /\bpet\b/]],
    ['Saúde', [/farmacia/, /drogaria/, /droga ?raia/, /drogasil/, /\braia\b/, /pague ?menos/, /panvel/, /pacheco/, /hospital/, /clinica/, /laboratorio/, /\blab\b/, /medic/, /dentista/, /odonto/, /unimed/, /\bamil\b/, /hapvida/, /sulamerica saude/, /psicolog/, /fisioterap/, /otica/, /exame/]],
    ['Transporte', [/\buber\b/, /uber ?trip/, /ubertrip/, /\b99\b/, /99 ?app/, /99 ?pop/, /99pop/, /\bposto\b/, /combustivel/, /gasolina/, /etanol/, /\bshell\b/, /ipiranga/, /petrobras/, /estacionamento/, /estapar/, /sem ?parar/, /veloe/, /conectcar/, /pedagio/, /\bmetro\b/, /cptm/, /sptrans/, /bilhete unico/, /onibus/, /cabify/, /indrive/, /\btaxi\b/]],
    ['Alimentação', [/supermercado/, /\bmercado\b/, /padaria/, /padari/, /atacad/, /frutas/, /panificadora/, /restaurante/, /lanchonete/, /lanches/, /burger/, /mcdonald/, /mc ?donalds/, /\bbk\b/, /subway/, /pizza/, /acougue/, /hortifruti/, /sacolao/, /atacadao/, /assai/, /carrefour/, /pao de acucar/, /cafeteria/, /cafe/, /starbucks/, /outback/, /habib/, /\bkfc\b/, /popeyes/, /doceria/, /sorvete/, /emporio/, /quitanda/, /hamburguer/, /churrasc/, /sushi/, /food/]],
    ['Lazer', [/cinema/, /cinemark/, /kinoplex/, /\buci\b/, /ingresso/, /sympla/, /eventim/, /\bsteam\b/, /playstation/, /\bpsn\b/, /\bxbox\b/, /nintendo/, /\bjogo/, /\bgames?\b/, /viagem/, /\bhotel/, /airbnb/, /booking/, /decolar/, /\blatam\b/, /\bgol\b/, /\bazul\b/, /passagem/, /teatro/, /\bshow\b/, /parque/, /\bbar\b/, /balada/, /museu/]],
    ['Vestuário', [/renner/, /riachuelo/, /\bc ?& ?a\b/, /\bcea\b/, /\bzara\b/, /hering/, /netshoes/, /dafiti/, /marisa/, /youcom/, /havaianas/, /centauro/, /decathlon/, PALAVRAS_ROUPA]],
    ['Compras', [/magalu/, /magazine ?luiza/, /americanas/, /casas ?bahia/, /kabum/, /fast ?shop/, /ponto ?frio/, /leroy/, /tok ?& ?stok/, /tokstok/, /\bcamicado/, PALAVRAS_ELETRONICO]],
    ['Moradia', [/aluguel/, /condominio/, /\biptu\b/, /energia/, /eletropaulo/, /\benel\b/, /\blight\b/, /cemig/, /copel/, /celesc/, /sabesp/, /\bagua\b/, /comgas/, /\bgas\b/, /internet/, /fibra/, /net virtua/, /claro net/, /vivo fibra/, /tim live/]]
  ];

  // Devolve { categoria, regra } — categoria é sempre um dos 11 nomes.
  function categorizarDescricao(descricao) {
    const texto = normalizar(descricao);
    if (!texto) return { categoria: 'Outros', regra: 'descricao_vazia' };

    for (const [categoria, padroes] of REGRAS) {
      const bateu = padroes.find((p) => p.test(texto));
      if (!bateu) continue;

      if (categoria === '__marketplace__') {
        // Amazon / Mercado Livre / Shopee...: a finalidade depende do produto.
        if (PALAVRAS_ROUPA.test(texto)) return { categoria: 'Vestuário', regra: 'marketplace_roupa' };
        if (PALAVRAS_ELETRONICO.test(texto)) return { categoria: 'Compras', regra: 'marketplace_eletronico' };
        return { categoria: 'Outros', regra: 'marketplace_produto_desconhecido' };
      }
      return { categoria, regra: String(bateu) };
    }
    return { categoria: 'Outros', regra: 'sem_regra' };
  }

  // ---------- Migração de categorias antigas ----------
  // Nome antigo (normalizado) → destino definitivo. null = decide pela
  // descrição de cada despesa (e, se nada bater, "Outros"). Nomes que já são
  // definitivos não aparecem aqui (continuam como estão).
  const MAPA_LEGADO = {
    'essenciais': null,
    'essencial': null,
    'delivery': 'Alimentação',
    'fast food': 'Alimentação',
    'fastfood': 'Alimentação',
    'fast food / delivery': 'Alimentação',
    'fast food/delivery': 'Alimentação',
    'comida': 'Alimentação',
    'mercado': 'Alimentação',
    'supermercado': 'Alimentação',
    'restaurante': 'Alimentação',
    'restaurantes': 'Alimentação',
    'medicamentos': 'Saúde',
    'farmacia': 'Saúde',
    'saude / medicamentos': 'Saúde',
    'saude/medicamentos': 'Saúde',
    'saude e medicamentos': 'Saúde',
    'marketplace': null,
    'pets': 'Pet',
    'animais': 'Pet',
    'roupas': 'Vestuário',
    'roupa': 'Vestuário',
    'vestuario e calcados': 'Vestuário',
    'casa': 'Moradia',
    'contas': 'Moradia',
    'contas da casa': 'Moradia',
    'streaming': 'Assinaturas',
    'taxas': 'Taxas e encargos',
    'tarifas': 'Taxas e encargos',
    'encargos': 'Taxas e encargos',
    'combustivel': 'Transporte',
    'eletronicos': 'Compras'
  };

  // Destino de UMA despesa cuja categoria antiga está sendo desativada.
  // Determinístico: mesmo nome antigo + mesma descrição → mesmo destino.
  function destinoMigracao(nomeCategoriaAntiga, descricao) {
    const n = normalizar(nomeCategoriaAntiga);
    const definitivo = nomeDefinitivoPorNome(nomeCategoriaAntiga);
    if (definitivo) return { categoria: definitivo, motivo: 'ja_definitiva' };
    if (Object.prototype.hasOwnProperty.call(MAPA_LEGADO, n) && MAPA_LEGADO[n]) {
      return { categoria: MAPA_LEGADO[n], motivo: `mapa_legado:${n}` };
    }
    const porDescricao = categorizarDescricao(descricao);
    return { categoria: porDescricao.categoria, motivo: `descricao:${porDescricao.regra}` };
  }

  function categoriaEhManual(despesa) {
    return !!(despesa && (despesa.categoriaManual === true || despesa.editadoManualmente === true));
  }

  const Categorizacao = {
    CATEGORIAS_DEFINITIVAS, NOMES_DEFINITIVOS, MAPA_LEGADO,
    normalizar, chaveEstabelecimento, nomeDefinitivoPorNome, categorizarDescricao,
    destinoMigracao, categoriaEhManual
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Categorizacao;
  if (raiz) raiz.Categorizacao = Categorizacao;
})(typeof window !== 'undefined' ? window : null);
