---
impacto: nada_mudou
secao: corrigido
titulo: O diagnóstico de saúde para de ficar parado no passo do app quando o app está saudável
---

Numa instalação em que o app estava saudável, o `healthcheck.sh` ficava parado em "Saúde interna do app (/api/v1/health)" e não terminava — nem para dizer que estava tudo bem, nem para dizer que o app não respondeu. A rota respondia HTTP 200 `healthy` no mesmo instante; o que não voltava era o comando que a consultava por dentro do container.

Agora o passo termina. O comando que roda sob prazo não lê mais o terminal — era essa leitura que parava o processo e prendia o diagnóstico — e, se o prazo estourar, ele é encerrado à força cinco segundos depois, em vez de esperar por tempo indeterminado. O passo dá o veredito em até 30 segundos: o corpo do `/api/v1/health`, ou o aviso de que o app não respondeu. O resto do diagnóstico não muda.
