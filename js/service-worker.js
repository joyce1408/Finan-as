// service-worker.js
// Faz cache do "app shell" só como uma REDE DE SEGURANÇA pra funcionar offline.
// A estratégia é "rede primeiro": sempre que tiver internet, busca a versão
// mais nova do servidor. Só usa o que está guardado localmente quando não
// consegue conectar. Isso evita o app ficar preso numa versão antiga durante
// o desenvolvimento (dados financeiros nunca passam por aqui — ficam só no
// IndexedDB).

// Regra 20 da revisão: a estratégia já era (e continua sendo) "rede
// primeiro" (ver o listener 'fetch' abaixo) — todo aparelho com internet
// sempre busca a versão mais nova antes de olhar o cache, então Mac e
// iPhone já convergem pro mesmo JS sempre que há conexão; o cache serve só
// de rede de segurança pro modo offline. O número da versão aqui embaixo só
// precisa subir a cada publicação (como agora) pra garantir que o passo
// 'activate' limpe o cache antigo — isso mexe SOMENTE no Cache Storage
// (arquivos estáticos), nunca no IndexedDB (onde ficam os dados financeiros
// reais) — ver o listener 'activate', que só chama caches.delete(), nunca
// indexedDB.deleteDatabase().
const CACHE_NAME = 'financas-app-v15';
const ARQUIVOS_PARA_CACHE = [
  './index.html',
  './onboarding.html',
  './transacoes.html',
  './cartoes.html',
  './cartao-detalhe.html',
  './relatorios.html',
  './mais.html',
  './categorias.html',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './css/style.css',
  './css/transacoes.css',
  './css/cartoes.css',
  './css/relatorios.css',
  './css/mais.css',
  './css/seguranca.css',
  './css/categorias.css',
  './js/db.js',
  './js/motor.js',
  './js/app.js',
  './js/transacoes.js',
  './js/cartoes.js',
  './js/cartao-detalhe.js',
  './js/relatorios.js',
  './js/mais.js',
  './js/seguranca.js',
  './js/avisos.js',
  './js/importar-fatura.js',
  './js/storage-migracao.js',
  './js/categorias.js',
  './js/moeda.js',
  './js/ocr-fatura.js',
  './js/ler-documento.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARQUIVOS_PARA_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(
        nomes
          .filter((nome) => nome !== CACHE_NAME)
          .map((nome) => caches.delete(nome))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((respostaDaRede) => {
        // Deu certo buscar da rede: atualiza o cache com a versão mais nova
        // e devolve essa versão fresca
        const clone = respostaDaRede.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return respostaDaRede;
      })
      .catch(() => {
        // Sem internet: cai pro que estiver guardado localmente
        return caches.match(event.request);
      })
  );
});
