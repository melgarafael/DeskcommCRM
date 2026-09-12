---
impacto: nada_mudou
secao: corrigido
titulo: O log de eventos para de encher de pendências que ninguém ia atender
---

O registro de eventos alimenta o painel de diagnóstico. Só que **parte dos eventos nasce só para ficar registrada** — mensagem enviada, lead alterado, sessão de canal mudou de estado — e nenhum consumidor de fila foi feito para eles: ninguém ia atendê-los mesmo.

Esses eventos nasciam marcados como **pendentes** igual a um pedido que ainda não foi processado, e assim ficavam para sempre. Numa instalação real havia **626 linhas assim, em 8 tipos de evento**, todas com cara de trabalho parado na fila — e nenhuma delas ia sair dali, porque não existia quem as pegasse.

Agora o evento que é só registro nasce já fechado, e o que era acúmulo antigo foi fechado de uma vez. O que continua aparecendo como pendente é o que realmente **precisa** ser atendido: pedido de envio, pedido de disparo, e qualquer evento de um tipo que espere um consumidor que não exista. A fila volta a significar fila.

Não há nada a fazer na sua VPS: a correção entra junto com a atualização e o acúmulo antigo é limpo por ela.
