---
impacto: nada_mudou
secao: alterado
titulo: O banco ganha índices para as consultas que o agente e a limpeza diária repetem
---
Cinco consultas que rodam o tempo todo procuravam linha por linha em tabelas que crescem com o uso: a que confere se é a primeira mensagem do agente para um contato, a que impede o agente de responder duas vezes à mesma mensagem, a soma do custo de cada atendimento, a limpeza diária da fila de trabalhos e a busca por eventos travados. Agora cada uma tem o seu índice. Nada muda na tela nem no comportamento; numa instalação com muito histórico, essas consultas deixam de ficar mais lentas conforme o banco cresce.

Na atualização, o banco cria os cinco índices. Enquanto isso acontece, gravar nas tabelas de envios, de chamadas de IA, de memória do agente, de etapas do funil e de eventos fica travado. Numa instalação pequena isso dura instantes; quanto mais histórico, mais demora. Não é preciso fazer nada na instalação.
