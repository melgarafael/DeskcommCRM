---
impacto: capacidade_nova
secao: adicionado
titulo: Pré-voo das imagens antes de instalar ou atualizar em ARM64
---

Numa VPS ARM64, o kit confere antes da instalação ou atualização se as imagens
do CRM, a WAHA escolhida e, no modo single-server, o Supabase fixado têm variante
ARM64. Isso evita começar uma atualização que não poderá subir. Há também uma
sonda somente-leitura para a primeira transição de kit antigo. Em AMD64 nada muda.
Uma instalação existente continua exigindo atualização deliberada e backup, e
quem pede construção local (`DESKCOMM_BUILD_LOCAL=1`) não passa por esta conferência.

Crédito: @Tanderakkkj.
