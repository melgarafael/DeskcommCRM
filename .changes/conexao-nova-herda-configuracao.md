---
impacto: nada_mudou
secao: corrigido
titulo: Número que volta por outra conexão continua com o mesmo agente, a mesma distribuição e o mesmo pré-go-live
---

Quando o mesmo telefone voltava a falar por **outra conexão** de WhatsApp (a
empresa trocou a API oficial pelo QR, ou abriu uma conexão nova para o mesmo
aparelho), o cliente ganhava uma conversa nova numa conexão que nunca tinha sido
configurada: **sem agente de IA** (a IA ficava muda justamente para quem já era
atendido), **sem regra de distribuição** e **em pré-go-live** — ou seja, o
mesmo cliente aparecia três vezes com o mesmo vendedor, e a IA respondia
diferente conforme a conexão por onde ele escrevia.

Agora a conversa que **nasce** herda, da conversa mais recente do mesmo contato
na mesma organização, o agente de IA publicado, a regra de distribuição
(modo, destino padrão e responsáveis) e o estado de pré-go-live. Nada é
fundido e nada é migrado: as conversas antigas continuam onde estão, com o
histórico e o dono que tinham, e a conversa nova nasce sem dono — o que se herda
é a configuração da conexão, não a atribuição de ninguém. Conexão que já tem
configuração própria não é tocada, contato sem conversa anterior continua
exatamente como antes, e agente arquivado não é herdado (a conversa abre normal,
sem agente, em vez de apontar para um agente fora do ar).
