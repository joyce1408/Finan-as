// ler-documento.js — unifica a leitura de PDF e imagem, aplicando um filtro
// de escala de cinza + binarização (preto e branco) antes do OCR, o que
// melhora bastante a precisão do Tesseract.js em fotos com sombra, papel
// amarelado ou contraste ruim. Tudo roda no navegador, nada sai do aparelho.

function binarizarCanvas(canvas, limiar = 150) {
  const ctx = canvas.getContext('2d');
  const imagem = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const dados = imagem.data;

  for (let i = 0; i < dados.length; i += 4) {
    const cinza = 0.299 * dados[i] + 0.587 * dados[i + 1] + 0.114 * dados[i + 2];
    const valor = cinza >= limiar ? 255 : 0;
    dados[i] = dados[i + 1] = dados[i + 2] = valor;
  }

  ctx.putImageData(imagem, 0, 0);
  return canvas;
}

function calcularEscalaSegura(largura, altura, fatorDesejado, limiteMaximo = 4096) {
  const maiorLadoAlvo = Math.max(largura, altura) * fatorDesejado;
  if (maiorLadoAlvo <= limiteMaximo) return fatorDesejado;
  return limiteMaximo / Math.max(largura, altura);
}

function carregarImagemEmCanvas(arquivoOuUrl, fatorEscalaDesejado = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Limita o tamanho final do canvas — fotos/prints muito altos (ex.: print
      // de tela emendando duas páginas) poderiam gerar um canvas gigante e
      // travar o navegador. Prints normais de fatura continuam sendo ampliados
      // em 2x normalmente.
      const fatorEscala = calcularEscalaSegura(img.naturalWidth, img.naturalHeight, fatorEscalaDesejado);

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * fatorEscala;
      canvas.height = img.naturalHeight * fatorEscala;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = typeof arquivoOuUrl === 'string' ? arquivoOuUrl : URL.createObjectURL(arquivoOuUrl);
  });
}

async function tentarCarregarPdf(bufferArquivo, semWorker) {
  const opcoes = semWorker ? { data: bufferArquivo, disableWorker: true } : { data: bufferArquivo };
  const tarefaCarregamento = pdfjsLib.getDocument(opcoes);

  // Muitos PDFs de banco/fatura são "protegidos" só contra edição (senha de
  // dono), mas abrem normalmente com senha vazia. O PDF.js pergunta a senha
  // via esse callback — tentamos vazio primeiro antes de desistir de vez.
  let jaTentouSenhaVazia = false;
  tarefaCarregamento.onPassword = (atualizarSenha, motivo) => {
    if (!jaTentouSenhaVazia) {
      jaTentouSenhaVazia = true;
      atualizarSenha('');
    } else {
      throw new Error('SENHA_REAL');
    }
  };

  return tarefaCarregamento.promise;
}

async function renderizarPaginasPdf(arquivo, aoRenderizarPagina) {
  let bufferArquivo;
  try {
    bufferArquivo = await arquivo.arrayBuffer();
  } catch (erro) {
    throw new Error('Não consegui ler os dados desse arquivo. Tente selecionar o PDF de novo.');
  }

  let pdf;
  try {
    // Primeira tentativa: caminho normal, com o worker em segundo plano
    pdf = await tentarCarregarPdf(bufferArquivo, false);
  } catch (primeiroErro) {
    if (primeiroErro && primeiroErro.message === 'SENHA_REAL') {
      throw new Error('Esse PDF tem senha de verdade. Abra ele primeiro no seu iPhone, tire um print da tela e importe como foto.');
    }
    if (primeiroErro && primeiroErro.name === 'PasswordException') {
      throw new Error('Esse PDF tem senha de verdade. Abra ele primeiro no seu iPhone, tire um print da tela e importe como foto.');
    }

    console.warn('PDF.js falhou com worker, tentando sem worker:', primeiroErro);

    try {
      // Segunda tentativa: sem worker (roda tudo na thread principal) —
      // resolve casos comuns de falha ao carregar o worker no Safari/iOS
      pdf = await tentarCarregarPdf(bufferArquivo, true);
    } catch (segundoErro) {
      console.error('PDF.js falhou também sem worker:', segundoErro);
      const detalheTecnico = (segundoErro && segundoErro.message) || (primeiroErro && primeiroErro.message) || 'erro desconhecido';
      throw new Error(`Não consegui abrir esse PDF. Detalhe técnico: "${detalheTecnico}". Tente reexportar a fatura ou importar como foto/CSV.`);
    }
  }

  const canvasPorPagina = [];

  for (let numeroPagina = 1; numeroPagina <= pdf.numPages; numeroPagina++) {
    const pagina = await pdf.getPage(numeroPagina);
    const viewport = pagina.getViewport({ scale: 2 }); // escala 2x ajuda a precisão do OCR

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await pagina.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    canvasPorPagina.push(canvas);

    if (aoRenderizarPagina) aoRenderizarPagina(numeroPagina, pdf.numPages);
  }

  return canvasPorPagina;
}

function detectarTipoArquivo(arquivo) {
  const nome = arquivo.name.toLowerCase();
  if (arquivo.type === 'application/pdf' || nome.endsWith('.pdf')) return 'pdf';
  if (arquivo.type.startsWith('image/')) return 'imagem';
  if (arquivo.type.startsWith('text/') || nome.endsWith('.csv') || nome.endsWith('.txt')) return 'csv';
  return 'desconhecido';
}

// Caracteres permitidos no reconhecimento — inclui acentuação do português
// (sem isso, palavras como "Farmácia" ou "Débito" nunca seriam lidas certo)
const WHITELIST_CARACTERES = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZãáàâéêíóôõúüçÃÁÀÂÉÊÍÓÔÕÚÜÇR$,.-/ ";

async function criarWorkerConfigurado(aoProgredir) {
  const worker = await Tesseract.createWorker('por', 1, {
    logger: (info) => {
      if (aoProgredir && info.status === 'recognizing text') {
        aoProgredir(info.progress);
      }
    }
  });

  // PSM 6: assume um único bloco uniforme de texto, lido estritamente linha
  // por linha — evita que o modo automático tente separar em "colunas" e
  // acabe ignorando a coluna do valor à direita
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: WHITELIST_CARACTERES
  });

  return worker;
}

/**
 * Lê um arquivo (PDF ou imagem), aplica ampliação + binarização e roda o OCR
 * com um worker configurado especificamente pra fatura em lista, devolvendo
 * o texto reconhecido de todas as páginas concatenado.
 * `aoProgredir(mensagem, percentual)` é chamado durante o processo, pra tela
 * mostrar uma barra de progresso.
 */
async function extrairTextoDoDocumento(arquivo, aoProgredir) {
  const tipo = detectarTipoArquivo(arquivo);
  const notificar = (msg, pct) => { if (aoProgredir) aoProgredir(msg, pct); };

  let canvases = [];

  if (tipo === 'pdf') {
    notificar('Abrindo o PDF...', 0);
    canvases = await renderizarPaginasPdf(arquivo, (pagina, total) => {
      notificar(`Preparando página ${pagina} de ${total}...`, (pagina / total) * 30);
    });
  } else if (tipo === 'imagem') {
    notificar('Abrindo a imagem...', 0);
    try {
      canvases = [await carregarImagemEmCanvas(arquivo)];
    } catch (erro) {
      console.error('Falha ao carregar imagem em canvas:', erro);
      const detalhe = (erro && erro.message) ? erro.message : (erro && erro.type) || 'erro desconhecido ao carregar a imagem';
      throw new Error(`Não consegui abrir essa imagem. Detalhe técnico: "${detalhe}". Confira se o arquivo não está corrompido e tente outra foto.`);
    }
  } else {
    throw new Error('Tipo de arquivo não suportado para OCR (use PDF ou imagem).');
  }

  let ultimoProgressoPagina = 0;
  let worker;
  try {
    worker = await criarWorkerConfigurado((progressoPagina) => {
      ultimoProgressoPagina = progressoPagina;
    });
  } catch (erro) {
    console.error('Falha ao criar/configurar o worker do Tesseract:', erro);
    const detalhe = (erro && erro.message) ? erro.message : 'erro desconhecido';
    throw new Error(`Não consegui carregar o motor de leitura de texto (isso baixa um pacote de ~1-2MB na primeira vez). Detalhe técnico: "${detalhe}". Confira sua conexão com a internet — redes de empresa às vezes bloqueiam esse tipo de download — e tente de novo.`);
  }

  let textoCompleto = '';

  try {
    for (let i = 0; i < canvases.length; i++) {
      binarizarCanvas(canvases[i]);
      ultimoProgressoPagina = 0;

      const intervalo = setInterval(() => {
        const baseProgresso = 30 + (i / canvases.length) * 70;
        const pctPagina = (ultimoProgressoPagina * 70) / canvases.length;
        notificar(`Lendo texto (página ${i + 1} de ${canvases.length})...`, baseProgresso + pctPagina);
      }, 200);

      const resultado = await worker.recognize(canvases[i]);
      clearInterval(intervalo);
      textoCompleto += '\n' + resultado.data.text;
    }
  } finally {
    await worker.terminate();
  }

  return textoCompleto;
}

window.LerDocumento = { extrairTextoDoDocumento, detectarTipoArquivo, binarizarCanvas };
