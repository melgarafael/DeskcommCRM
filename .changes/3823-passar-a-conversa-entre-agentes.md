---
impacto: capacidade_nova
secao: adicionado
titulo: O agente de IA passa a conversa para outro agente do roteador do mesmo número
---

Num número com roteador, o agente que está atendendo ganha a ferramenta
`transfer_to_agent`: quando o assunto é de outro agente da lista, ele passa a
conversa, e a partir da próxima mensagem do cliente quem responde é o agente
escolhido. O destino só pode ser um dos membros desse roteador. A mesma passagem
existe como ação para quem opera (`POST /api/v1/conversations/{id}/transferir-agente`,
papel `agent` ou acima).

A passagem só é aceita onde o turno seguinte a respeita: roteador ativo com
"manter o agente da conversa" ligado, fora do modo de regras por remetente, e
conversa que não nasceu de campanha com agente próprio. Fora disso ela é recusada
com o motivo, e nada muda. Destino pausado também é recusado, porque com ele o
cliente ficaria sem resposta. Com o roteador mantendo o agente, o classificador
ainda pode trocar de agente se vier outra intenção com confiança.

Cada passagem fica registrada na trilha do roteador como `transferred`, com quem
pediu (o agente ou a pessoa), de qual agente para qual e por quê. A trilha das
decisões passa a ser escrita só pelo servidor; os membros da organização seguem
lendo. Não é preciso mexer em nada na VPS. Contribuição de @webtecnica.
