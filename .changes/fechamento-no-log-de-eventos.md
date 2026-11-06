---
impacto: nada_mudou
secao: alterado
titulo: Encerrar a conversa agora publica um evento no log do sistema
---

Encerrar um atendimento mudava o status e gravava a auditoria, mas nenhum evento
ia para o log do sistema — então nada automático podia reagir ao fim do
atendimento. Agora o encerramento publica o evento `conversation.closed` com a
conversa, o contato, o número e o instante do fechamento, uma única vez por
encerramento.

Encerrar de novo a mesma conversa, ou encerrar uma que já estava encerrada, não
gera evento repetido, e o fechamento em lote gera um evento por conversa. Se a
publicação do evento falhar, o encerramento acontece do mesmo jeito — a falha
fica no log do banco, com o id da conversa.
