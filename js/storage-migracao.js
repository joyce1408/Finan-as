// storage-migracao.js — roda antes de qualquer outro script.
// Renomeia as chaves antigas ("financas_*", nome genérico demais e vulnerável
// a colidir com outros projetos hospedados no mesmo domínio do GitHub Pages)
// para um namespace exclusivo do Finanças Fácil.
//
// A foto de perfil NÃO é migrada de propósito: o valor salvo sob a chave
// antiga pode pertencer a outro projeto (foi o que causou a "foto da agenda"
// aparecendo sozinha), então é descartado em vez de copiado.

(function () {
  const PREFIXO_NOVO = 'ffjoyce2026_';

  const MIGRAR = [
    'pin_hash',
    'recovery_hash',
    'webauthn_id',
    'isFirstRun',
    'nome_usuaria'
  ];

  MIGRAR.forEach((sufixo) => {
    const chaveAntiga = 'financas_' + sufixo;
    const chaveNova = PREFIXO_NOVO + sufixo;
    if (localStorage.getItem(chaveNova) === null && localStorage.getItem(chaveAntiga) !== null) {
      localStorage.setItem(chaveNova, localStorage.getItem(chaveAntiga));
    }
  });

  // Remove todas as chaves antigas do namespace genérico, incluindo a foto
  // (que não é migrada — descartada por segurança, veja comentário acima)
  ['pin_hash', 'recovery_hash', 'webauthn_id', 'isFirstRun', 'nome_usuaria', 'foto_perfil'].forEach((sufixo) => {
    localStorage.removeItem('financas_' + sufixo);
  });
})();
