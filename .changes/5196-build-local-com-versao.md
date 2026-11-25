---
impacto: nada_mudou
secao: corrigido
titulo: A imagem construída pelo fallback da atualização passa a levar a versão e a revisão, e o pull é tentado de novo antes de construir
---

Se o `docker compose pull` de uma atualização falhasse por uma queda transitória de rede no meio do download (por exemplo `read: connection reset by peer` na CDN do GHCR), o `update.sh` caía direto na construção local de `worker`, `scheduler` e `voice-agent`. Essa imagem era gravada sob a mesma tag oficial da versão — e saía com `APP_VERSION=dev` e sem a revisão da release, porque o bloco `build:` do parque de produção não passava nenhuma das duas. Com `*_PULL_POLICY=missing` no `.env`, o Docker nunca mais puxava a imagem oficial daquela versão, e a confirmação de versão do parque ficava travada mesmo com a atualização terminando em sucesso.

Agora o pull é tentado uma segunda vez antes de qualquer construção: queda transitória deixa de virar build local, e a mensagem diz que houve retentativa. Se ainda assim a construção acontecer, as três imagens saem com `APP_VERSION` da versão alvo e com o label `org.opencontainers.image.revision` do commit que está no disco, igual ao que o CI carimba no fluxo oficial — mas só quando a pasta é exatamente esse commit. Com mudança local ou arquivo novo na pasta (que a construção copia para dentro da imagem), ou com o commit desconhecido, o label vai vazio — não-medido, como antes, nunca um palpite. O `diagnostico.sh` continua reconhecendo essa imagem como construída na VPS: ele passa a decidir pelo label de versão, que só o CI põe.

A tela de versão não faz parte desta mudança: ela lê o que o host mede, e é o host que passou a ter o que medir. Referente à issue #5196.
