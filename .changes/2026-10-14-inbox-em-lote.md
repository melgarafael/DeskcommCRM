---
impacto: capacidade_nova
secao: adicionado
titulo: A Inbox aceita seleção múltipla e executa ações em lote por uma rota só
---

Fechar, arquivar, transferir, marcar como lida e pausar ou devolver o automático eram ações de uma conversa por vez — e o relato da issue #2484 é o custo disso: fechar e abrir toda hora estava complicando. Agora a lista de conversas tem caixa de seleção em cada linha e uma barra de ações que só aparece quando há algo marcado. Todas as ações saem por UMA rota, `POST /api/v1/conversations/bulk`, que recebe `ids[]` e a ação escolhida. O lote não tem permissão própria, organização própria nem auditoria própria: cada id é encaminhado ao MESMO handler da conversa individual — mesma função de permissão, mesma organização lida da sessão (nunca do corpo da requisição) e a mesma auditoria que cada ação já faz individualmente (marcar como lida não audita, nem antes nem agora), com o `request_id` de cada item no relatório. Aceita até 100 conversas por chamada (`bulk_too_large`, 422, com o teto na mensagem); acima disso a chamada recusa inteira antes de qualquer escrita. A resposta traz o resultado de cada item — feito, recusado e o porquê —, e uma recusa não derruba as demais: conversa de outra organização ou inexistente é recusada NO ITEM, com o `not_found` do próprio handler, e as outras seguem. Um `viewer` recebe 403 pela chamada, sem subchamada nenhuma. A barra não aparece para quem só lê, e a caixa de marcar não abre a conversa — marcar e abrir são gestos separados. Nenhuma mudança de banco.

Contribuição de @webtecnica (refs #2484).
