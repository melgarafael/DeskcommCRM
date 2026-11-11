# Recusar ligação SIP pela tela — antes e depois

Ambiente: stack local (`ubuntu-local-installer.sh`), banco do `baseline.sql`, **sem WaCalls**
configurado (instalação só com telefonia SIP). Onboarding marcado como concluído direto no banco.

Roteiro (`prova-recusa-sip.mjs`): insere uma linha SIP recebida `ringing`, entra como dono,
abre `/app/inbox`, clica em **Recusar chamada** no banner, lê o banco e recarrega a página.

Medido em 2026-11-04, a mesma prova contra as duas imagens do app:

```
[antes]  resposta do /reject: 503,503,503
[antes]  banco: ringing -
[antes]  depois de recarregar, banner visível = true

[depois] resposta do /reject: 200
[depois] banco: ended declined
[depois] depois de recarregar, banner visível = false
```

Imagem da `main` anterior:

- `antes-1-tocando.png`: o banner da ligação SIP tocando.
- `antes-2-depois-do-clique.png`: depois de **Recusar chamada** (503); o banner some só da memória.
- `antes-3-recarregada.png`: a página recarregada; o banner voltou.

Imagem desta branch:

- `depois-1-tocando.png`: o mesmo banner.
- `depois-2-depois-do-clique.png`: depois de **Recusar chamada** (200).
- `depois-3-recarregada.png`: a página recarregada; o banner não volta.

Não medido aqui: a metade do worker de voz (o AudioSocket que encontra a linha encerrada e
desliga sem abrir a IA). O ambiente local não tem Asterisk; essa metade está provada no
teste de fio `workers/voice-agent/fio-recusada-pela-tela.test.ts`.
