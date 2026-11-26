---
impacto: nada_mudou
secao: corrigido
titulo: No painel Atividade da conversa, o que um token de API fez aparece como "Integração · <nome do token>"
---

No Inbox, a seção Atividade do painel da conversa mostrava "Sistema" quando a ação vinha de um token de API (uma integração mexendo no negócio), o mesmo rótulo de quando a plataforma age sozinha. Agora a linha diz "Integração · <nome do token>", ou só "Integração" quando o nome não pode ser lido. Vale para as atividades registradas depois da atualização; as antigas continuam como "Sistema", porque não guardaram qual token agiu.

Contribuição de @yunshu0909, a partir da issue #5160.
