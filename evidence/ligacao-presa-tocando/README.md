# Ligação presa em toque — prova pela tela

Ambiente: stack local (`ubuntu-local-installer.sh`), banco do `baseline.sql`, sem envs opcionais.
`organizations.onboarded_at` foi marcado direto no banco para pular o onboarding,
que não é o que está em prova.

Roteiro (`prova-ligacao-presa.mjs`): insere em `voice_calls` uma linha SIP recebida
`ringing` criada há 10 min (o estado em que a VPS ficava), entra como dono e abre
`/app/inbox`, chama `POST /api/v1/cron/recover-stuck-calls` e confere a tela.

Saída medida em 2026-11-04:

```
ANTES: banner visível = true
cron: 200 {"data":{"scanned":4,"ended":4,"organizations":1}}
banco: ended timeout
DEPOIS (mesma aba): banner visível = false
DEPOIS (recarregada): banner visível = false
```

`scanned: 4`: as três linhas a mais foram deixadas pelas tentativas anteriores do
mesmo roteiro (antes de o onboarding ser pulado).

- `1-antes-banner-fantasma.png`: o banner "Chamada de voz recebida" sem ninguém ligar.
- `2-depois-cron-sem-banner.png`: a mesma tela depois do cron, recarregada.
