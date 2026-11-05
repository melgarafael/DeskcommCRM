---
impacto: nada_mudou
secao: corrigido
titulo: O ID que a tela mostra volta a ser o ID que está no log
---

O `X-Request-Id` da resposta e o id gravado na auditoria eram dois: o `proxy.ts`
cunhava um e a rota cunhava outro, e o cabeçalho do middleware vencia o da rota.
Quem copiava o ID da tela para procurar no log encontrava a linha de OUTRA
requisição — ou nenhuma.

Agora o id nasce uma vez, no cabeçalho da requisição, e é ele que a rota grava e
que a resposta devolve. Resposta montada à mão também leva o cabeçalho: arquivo,
imagem, QR, stream, redirecionamento de login e webhook de entrada, sem mudar um
byte do corpo nem o `Location`. E um id inventado pelo cliente, fora do formato
de UUID, não entra no log.
