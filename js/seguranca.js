// seguranca.js — trava de acesso ao app por PIN, com:
// - Face ID/Touch ID via WebAuthn disparado AUTOMATICAMENTE ao abrir (se configurado),
//   caindo pro teclado de PIN sozinho se falhar, sem nunca travar a Joyce pra fora do app.
// - Chave de recuperação de 4 palavras, gerada na criação do PIN, que permite trocar
//   o PIN sem apagar nenhum dado — "Esqueci meu PIN" NUNCA apaga o banco diretamente.
//
// Ameaça que isso resolve: alguém pega seu iPhone destravado e abre o app. Isso NÃO
// criptografa os dados dentro do IndexedDB (ficam legíveis se alguém extrair o
// armazenamento do Safari via jailbreak/forense) — é uma trava de acesso à interface,
// que é a proteção prática para o dia a dia.

(function () {
  let pinDigitado = '';
  let modo = 'desbloquear'; // 'desbloquear' | 'criar' | 'confirmar' | 'novo-pos-recuperacao' | 'confirmar-pos-recuperacao'
  let pinTemporario = '';
  let fraseGeradaTemporaria = null;

  const PALAVRAS = [
    'casa', 'carro', 'sol', 'chuva', 'mesa', 'porta', 'gato', 'flor', 'praia', 'monte',
    'rio', 'lua', 'estrela', 'livro', 'chave', 'ponte', 'nuvem', 'vento', 'fogo', 'agua',
    'pedra', 'arvore', 'peixe', 'passaro', 'janela', 'jardim', 'cidade', 'estrada', 'montanha', 'floresta'
  ];

  function pinHashSalvo() {
    return localStorage.getItem('ffjoyce2026_pin_hash');
  }

  function recoveryHashSalvo() {
    return localStorage.getItem('ffjoyce2026_recovery_hash');
  }

  function jaDesbloqueadoNestaSessao() {
    return sessionStorage.getItem('ffjoyce2026_desbloqueado') === '1';
  }

  async function gerarHash(texto, salt) {
    const encoder = new TextEncoder();
    const dados = encoder.encode(salt + '::' + texto);
    const buffer = await crypto.subtle.digest('SHA-256', dados);
    return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function gerarHashPin(pin) {
    return gerarHash(pin, 'financas-salt');
  }

  function gerarHashFrase(frase) {
    return gerarHash(frase.trim().toLowerCase(), 'financas-recovery-salt');
  }

  function gerarFraseRecuperacao() {
    const disponiveis = [...PALAVRAS];
    const escolhidas = [];
    for (let i = 0; i < 4; i++) {
      const idx = Math.floor(Math.random() * disponiveis.length);
      escolhidas.push(disponiveis.splice(idx, 1)[0]);
    }
    return escolhidas.join('-');
  }

  // ---------- Construção do overlay ----------

  function injetarOverlay() {
    const div = document.createElement('div');
    div.id = 'lockOverlay';
    div.className = 'lock-overlay hidden';
    div.innerHTML = `
      <div id="telaPin">
        <div class="lock-title" id="lockTitle">Digite seu PIN</div>
        <div class="lock-sub" id="lockSub">Seus dados financeiros ficam protegidos localmente</div>
        <div class="lock-dots" id="lockDots"></div>
        <div class="lock-error" id="lockError"></div>
        <div class="lock-status" id="lockStatus"></div>
        <div class="lock-pad" id="lockPad"></div>
        <button class="lock-faceid" id="lockFaceId" style="display:none">🔓 Desbloquear com Face ID</button>
        <button class="lock-footer-link" id="lockReset" style="display:none">Esqueci meu PIN</button>
      </div>

      <div id="telaFrase" style="display:none; width:100%; max-width:320px">
        <button class="lock-back-btn" id="fraseVoltarTopo" style="visibility:hidden">← Voltar</button>
        <div class="lock-title">Guarde sua Chave de Recuperação</div>
        <div class="lock-sub">Anote esses 4 códigos em um lugar seguro ou tire um print. Você vai precisar deles se esquecer o PIN — sem eles, não tem como recuperar o acesso sem apagar os dados.</div>
        <div class="lock-frase-box" id="fraseTexto">palavra-palavra-palavra-palavra</div>
        <button class="lock-key" style="width:100%; border-radius:16px; background:#fff; color:var(--blue,#1B2A4A); font-weight:700; font-size:14px; margin-top:22px" id="fraseContinuar">Já anotei, continuar</button>
      </div>

      <div id="telaRecuperar" style="display:none; width:100%; max-width:320px">
        <button class="lock-back-btn" id="recuperarVoltarTopo">← Voltar para a tela de senha</button>
        <div class="lock-title">Recuperar acesso</div>
        <div class="lock-sub">Aviso: seus dados financeiros são privados e ficam apenas neste celular. Para alterar o seu PIN sem perder suas informações, digite abaixo sua Chave de Recuperação de 4 palavras.</div>
        <input type="text" id="inputFraseRecuperacao" class="lock-input" placeholder="palavra-palavra-palavra-palavra" autocapitalize="none" autocorrect="off">
        <div class="lock-error" id="recuperarError"></div>
        <button class="lock-key" style="width:100%; border-radius:16px; background:#fff; color:var(--blue,#1B2A4A); font-weight:700; font-size:14px; margin-top:14px" id="recuperarValidar">Validar chave</button>
        <button class="lock-footer-link" id="semChaveLink">Não tenho a chave de recuperação</button>
      </div>

      <div id="telaWipe" style="display:none; width:100%; max-width:320px">
        <button class="lock-back-btn" id="wipeVoltarTopo">← Voltar para a tela de senha</button>
        <div class="lock-title">Apagar tudo e recomeçar</div>
        <div class="lock-sub">Isso vai apagar PERMANENTEMENTE todos os seus dados financeiros deste iPhone (despesas, receitas, cartões, tudo). Não há como desfazer. Só use isso se realmente não tiver a chave de recuperação.</div>
        <input type="text" id="inputConfirmaWipe" class="lock-input" placeholder='Digite: APAGAR TUDO'>
        <div class="lock-error" id="wipeError"></div>
        <button class="lock-key" style="width:100%; border-radius:16px; background:#F1A69C; color:#5c1a12; font-weight:700; font-size:14px; margin-top:14px" id="wipeConfirmar">Apagar tudo</button>
      </div>
    `;
    document.body.prepend(div);
    renderPad();
    renderDots();

    document.getElementById('lockFaceId').addEventListener('click', () => tentarFaceId(false));
    document.getElementById('lockReset').addEventListener('click', abrirTelaRecuperar);
    document.getElementById('recuperarVoltarTopo').addEventListener('click', voltarParaPin);
    document.getElementById('recuperarValidar').addEventListener('click', validarFraseRecuperacao);
    document.getElementById('semChaveLink').addEventListener('click', abrirTelaWipe);
    document.getElementById('wipeVoltarTopo').addEventListener('click', abrirTelaRecuperar);
    document.getElementById('wipeConfirmar').addEventListener('click', confirmarWipe);
    document.getElementById('fraseContinuar').addEventListener('click', continuarAposFrase);
  }

  function mostrarTela(id) {
    ['telaPin', 'telaFrase', 'telaRecuperar', 'telaWipe'].forEach((t) => {
      document.getElementById(t).style.display = t === id ? 'flex' : 'none';
      if (t === id) document.getElementById(t).style.flexDirection = 'column';
      if (t === id) document.getElementById(t).style.alignItems = 'center';
    });
  }

  // ---------- Teclado numérico ----------

  function renderPad() {
    const pad = document.getElementById('lockPad');
    const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    pad.innerHTML = teclas.map((t) => {
      if (t === '') return `<div class="lock-key ghost"></div>`;
      return `<button class="lock-key" data-tecla="${t}">${t}</button>`;
    }).join('');
    pad.querySelectorAll('.lock-key[data-tecla]').forEach((btn) => {
      btn.addEventListener('click', () => onTecla(btn.dataset.tecla));
    });
  }

  function renderDots(erro = false) {
    const dots = document.getElementById('lockDots');
    dots.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const preenchido = i < pinDigitado.length;
      dots.insertAdjacentHTML('beforeend', `<div class="lock-dot ${preenchido ? 'filled' : ''} ${erro ? 'error' : ''}"></div>`);
    }
  }

  async function onTecla(tecla) {
    document.getElementById('lockError').textContent = '';

    if (tecla === '⌫') {
      pinDigitado = pinDigitado.slice(0, -1);
      renderDots();
      return;
    }
    if (pinDigitado.length >= 4) return;

    pinDigitado += tecla;
    renderDots();

    if (pinDigitado.length === 4) {
      await processarPinCompleto();
    }
  }

  async function processarPinCompleto() {
    if (modo === 'criar' || modo === 'novo-pos-recuperacao') {
      pinTemporario = pinDigitado;
      pinDigitado = '';
      modo = modo === 'criar' ? 'confirmar' : 'confirmar-pos-recuperacao';
      document.getElementById('lockTitle').textContent = 'Confirme seu PIN';
      renderDots();
      return;
    }

    if (modo === 'confirmar' || modo === 'confirmar-pos-recuperacao') {
      if (pinDigitado !== pinTemporario) {
        document.getElementById('lockError').textContent = 'Os PINs não coincidem. Tente de novo.';
        pinDigitado = '';
        pinTemporario = '';
        modo = modo === 'confirmar' ? 'criar' : 'novo-pos-recuperacao';
        document.getElementById('lockTitle').textContent = 'Crie um PIN de 4 dígitos';
        renderDots();
        return;
      }

      const hash = await gerarHashPin(pinDigitado);
      localStorage.setItem('ffjoyce2026_pin_hash', hash);

      // Gera (ou renova) a chave de recuperação sempre que um PIN novo é definido
      fraseGeradaTemporaria = gerarFraseRecuperacao();
      const hashFrase = await gerarHashFrase(fraseGeradaTemporaria);
      localStorage.setItem('ffjoyce2026_recovery_hash', hashFrase);

      mostrarFraseRecuperacao();
      return;
    }

    // modo 'desbloquear'
    const hash = await gerarHashPin(pinDigitado);
    if (hash === pinHashSalvo()) {
      desbloquear();
    } else {
      document.getElementById('lockError').textContent = 'PIN incorreto.';
      renderDots(true);
      setTimeout(() => { pinDigitado = ''; renderDots(); }, 400);
    }
  }

  function mostrarFraseRecuperacao() {
    document.getElementById('fraseTexto').textContent = fraseGeradaTemporaria;
    mostrarTela('telaFrase');
  }

  function continuarAposFrase() {
    fraseGeradaTemporaria = null;
    desbloquear();
  }

  function desbloquear() {
    sessionStorage.setItem('ffjoyce2026_desbloqueado', '1');
    document.getElementById('lockOverlay').classList.add('hidden');
  }

  // ---------- Tela principal de PIN ----------

  function mostrarOverlay() {
    pinDigitado = '';
    const jaTemPin = !!pinHashSalvo();
    modo = jaTemPin ? 'desbloquear' : 'criar';

    document.getElementById('lockTitle').textContent = jaTemPin ? 'Digite seu PIN' : 'Crie um PIN de 4 dígitos';
    document.getElementById('lockSub').textContent = jaTemPin
      ? 'Seus dados financeiros ficam protegidos localmente'
      : 'Você vai usar esse PIN para abrir o app a partir de agora';
    document.getElementById('lockReset').style.display = jaTemPin ? 'block' : 'none';
    document.getElementById('lockStatus').textContent = '';
    renderDots();
    mostrarTela('telaPin');
    document.getElementById('lockOverlay').classList.remove('hidden');

    configurarFaceIdNaTela();
  }

  // ---------- Face ID / Touch ID (WebAuthn) — automático, com fallback pro PIN ----------

  async function configurarFaceIdNaTela() {
    const btn = document.getElementById('lockFaceId');
    const credId = localStorage.getItem('ffjoyce2026_webauthn_id');
    const disponivel = modo === 'desbloquear' && credId && window.PublicKeyCredential;

    if (!disponivel) {
      btn.style.display = 'none';
      return;
    }

    btn.style.display = 'flex';
    // Dispara automaticamente assim que a tela de bloqueio aparece — a Joyce
    // não precisa tocar em nada. Se falhar (rosto coberto, sem luz, cancelou,
    // etc.), o teclado numérico já está visível embaixo, pronto pra usar.
    await tentarFaceId(true);
  }

  async function tentarFaceId(automatico) {
    const credId = localStorage.getItem('ffjoyce2026_webauthn_id');
    if (!credId || !window.PublicKeyCredential) return;

    const status = document.getElementById('lockStatus');
    if (automatico) status.textContent = 'Tentando Face ID / Touch ID...';

    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: base64ParaBuffer(credId), type: 'public-key' }],
          userVerification: 'required',
          timeout: 20000
        }
      });
      status.textContent = '';
      desbloquear();
    } catch (e) {
      // Falhou ou foi cancelado — cai pro PIN sem travar a Joyce fora do app.
      status.textContent = '';
      if (!automatico) {
        document.getElementById('lockError').textContent = 'Não foi possível validar Face ID. Use o PIN.';
      }
    }
  }

  function base64ParaBuffer(base64) {
    const binario = atob(base64);
    const buffer = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) buffer[i] = binario.charCodeAt(i);
    return buffer.buffer;
  }

  function bufferParaBase64(buffer) {
    let binario = '';
    const bytes = new Uint8Array(buffer);
    bytes.forEach((b) => { binario += String.fromCharCode(b); });
    return btoa(binario);
  }

  // Chamado a partir da tela "Mais" para registrar Face ID/Touch ID
  async function registrarFaceId() {
    if (!window.PublicKeyCredential) {
      alert('Face ID/Touch ID não está disponível neste navegador.');
      return false;
    }
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userId = crypto.getRandomValues(new Uint8Array(16));
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'Finanças Fácil' },
          user: { id: userId, name: 'usuario-local', displayName: 'Usuário' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
          timeout: 30000
        }
      });
      localStorage.setItem('ffjoyce2026_webauthn_id', bufferParaBase64(credential.rawId));
      return true;
    } catch (e) {
      alert('Não foi possível configurar o Face ID agora.');
      return false;
    }
  }

  function removerFaceId() {
    localStorage.removeItem('ffjoyce2026_webauthn_id');
  }

  function faceIdConfigurado() {
    return !!localStorage.getItem('ffjoyce2026_webauthn_id');
  }

  // ---------- Alterar PIN (a partir da tela Mais, com PIN atual em mãos) ----------

  async function alterarPin() {
    if (!pinHashSalvo()) {
      alert('Nenhum PIN configurado ainda.');
      return false;
    }

    const atual = prompt('Digite seu PIN atual:');
    if (atual === null) return false;
    const hashAtual = await gerarHashPin(atual);
    if (hashAtual !== pinHashSalvo()) {
      alert('PIN atual incorreto.');
      return false;
    }

    const novo = prompt('Digite o novo PIN (4 dígitos numéricos):');
    if (novo === null) return false;
    if (!/^\d{4}$/.test(novo)) {
      alert('O PIN precisa ter exatamente 4 dígitos numéricos.');
      return false;
    }

    const confirmacao = prompt('Confirme o novo PIN:');
    if (confirmacao !== novo) {
      alert('Os PINs digitados não coincidem. Nada foi alterado.');
      return false;
    }

    const novoHash = await gerarHashPin(novo);
    localStorage.setItem('ffjoyce2026_pin_hash', novoHash);

    const novaFrase = gerarFraseRecuperacao();
    const hashFrase = await gerarHashFrase(novaFrase);
    localStorage.setItem('ffjoyce2026_recovery_hash', hashFrase);

    alert(`PIN alterado com sucesso!\n\nSua nova Chave de Recuperação é:\n${novaFrase}\n\nAnote em um lugar seguro — a chave antiga não vale mais.`);
    return true;
  }

  // ---------- Fluxo "Esqueci meu PIN" — recuperação sem apagar dados ----------

  function abrirTelaRecuperar() {
    document.getElementById('inputFraseRecuperacao').value = '';
    document.getElementById('recuperarError').textContent = '';
    mostrarTela('telaRecuperar');
  }

  function voltarParaPin() {
    pinDigitado = '';
    modo = 'desbloquear';
    document.getElementById('lockTitle').textContent = 'Digite seu PIN';
    document.getElementById('lockError').textContent = '';
    renderDots();
    mostrarTela('telaPin');
  }

  async function validarFraseRecuperacao() {
    const digitada = document.getElementById('inputFraseRecuperacao').value.trim();
    if (!digitada) return;

    if (!recoveryHashSalvo()) {
      document.getElementById('recuperarError').textContent = 'Nenhuma chave de recuperação foi configurada para este app ainda.';
      return;
    }

    const hash = await gerarHashFrase(digitada);
    if (hash !== recoveryHashSalvo()) {
      document.getElementById('recuperarError').textContent = 'Chave incorreta. Confira as 4 palavras e tente de novo.';
      return;
    }

    // Chave correta: deixa criar um PIN novo, sem apagar nenhum dado
    pinDigitado = '';
    pinTemporario = '';
    modo = 'novo-pos-recuperacao';
    document.getElementById('lockTitle').textContent = 'Crie um novo PIN';
    document.getElementById('lockSub').textContent = 'Chave validada! Seus dados continuam intactos. Escolha um novo PIN de 4 dígitos.';
    document.getElementById('lockError').textContent = '';
    renderDots();
    mostrarTela('telaPin');
  }

  // ---------- Último recurso: apagar tudo (fora do fluxo principal) ----------

  function abrirTelaWipe() {
    document.getElementById('inputConfirmaWipe').value = '';
    document.getElementById('wipeError').textContent = '';
    mostrarTela('telaWipe');
  }

  async function confirmarWipe() {
    const digitado = document.getElementById('inputConfirmaWipe').value.trim();
    if (digitado !== 'APAGAR TUDO') {
      document.getElementById('wipeError').textContent = 'Digite exatamente "APAGAR TUDO" (sem aspas) para confirmar.';
      return;
    }

    document.getElementById('wipeConfirmar').textContent = 'Apagando...';
    document.getElementById('wipeConfirmar').disabled = true;

    if (window.DB && DB.apagarBancoCompleto) {
      await DB.apagarBancoCompleto();
    } else {
      indexedDB.deleteDatabase('financas_db');
    }

    localStorage.removeItem('ffjoyce2026_pin_hash');
    localStorage.removeItem('ffjoyce2026_recovery_hash');
    localStorage.removeItem('ffjoyce2026_webauthn_id');
    sessionStorage.removeItem('ffjoyce2026_desbloqueado');
    location.reload();
  }

  // ---------- Inicialização ----------
  injetarOverlay();
  if (!jaDesbloqueadoNestaSessao()) {
    mostrarOverlay();
  }

  window.Seguranca = {
    registrarFaceId, removerFaceId, faceIdConfigurado,
    pinConfigurado: () => !!pinHashSalvo(),
    alterarPin
  };
})();
