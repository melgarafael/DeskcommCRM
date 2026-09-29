---
impacto: adiciona
secao: adicionado
titulo: Passkey (WebAuthn via GoTrue) — a configuração self-host, o gate e o transporte binário
---

Fatia 1 da #1164: passkey como segundo fator ao lado do TOTP. Este PR entrega a
fundação independente de decisão de produto — a configuração da Relying Party
vinda de env (`DESKCOMM_MFA_WEBAUTHN_ENROLL_ENABLED`, `_RP_ID`, `_RP_ORIGINS`)
com o gate que só expõe o provider quando o WebAuthn estiver de fato configurado
("não registrar provider que só sabe falhar"), a pergunta de "MFA cadastrado"
contando TOTP **e** webauthn verificados, e o transporte binário (base64url,
RFC 4648 §5) server action ↔ navegador preservando `challenge`/`user.id`/
`excludeCredentials` em round-trip.

Login sem senha (fase 2) e a decisão de produto (UV no servidor, sign count,
troca de celular) ficam para o PR de continuação. Crédito: @webtecnica (#1930)