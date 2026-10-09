---
impacto: nada_mudou
secao: corrigido
titulo: Conexão com o banco que falha no meio de uma operação deixa de ser reaproveitada
---

Quando uma consulta do motor de atendimento passava do tempo limite no meio de uma operação em várias etapas (pegar um job da fila, concluir um job, enviar uma mensagem, disparar um agendamento, preparar o roteiro padrão ou responder um caso), a conexão com o banco podia voltar para o grupo de conexões com a operação antiga ainda aberta e, se o desfazer também passasse do tempo, a próxima tarefa que recebesse essa conexão podia rodar dentro da operação de quem tinha falhado. Agora a conexão que falha é descartada, e uma nova é aberta para a próxima tarefa. Quem não falhou segue como antes. Nada precisa ser feito ao atualizar.

Contribuição de @webtecnica (#2621, fecha #2506).
