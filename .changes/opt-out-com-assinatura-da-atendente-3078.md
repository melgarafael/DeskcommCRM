---
impacto: nada_mudou
secao: corrigido
titulo: O PARAR que vem depois da assinatura da atendente passa a bloquear o contato
---
No WhatsApp Business com vários atendentes, a mensagem chega com a assinatura em negrito na primeira linha (`*Amanda Nobre:*`) e o pedido na segunda (`PARAR`). Esse pedido não era reconhecido: o contato não era bloqueado e a IA seguia respondendo. Agora a assinatura em negrito terminada em dois pontos é ignorada antes de procurar o pedido de saída. O texto original continua sendo julgado também, e rótulos sem negrito (`Pedido 123:`) seguem sem virar assinatura. Já um rótulo em negrito terminado em dois pontos (`*Pedido 123:*` seguido de `cancelar`) é lido como assinatura, e o contato é bloqueado — limite conhecido, porque ele é indistinguível de um nome. Nada a fazer na atualização.

Corrigido por @webtecnica (#3158).
