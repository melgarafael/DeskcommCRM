---
impacto: nada_mudou
secao: corrigido
titulo: Conexão que falha no meio de uma transação deixa de voltar para o grupo de conexões
---

Quando uma consulta estourava o tempo limite no meio de uma transação aberta à mão em rotinas do prospecção (o cadeado de sessão, a sessão do agente, o bate-papo de montagem e a montagem em si), na resposta de um caso obsoleto, na avaliação de saúde de um número, na troca de membros de um roteador ou na leitura de um banco externo, a conexão voltava para o grupo de conexões sem erro — com a operação antiga possivelmente ainda aberta ou, no cadeado de sessão, com o `pg_advisory_unlock` pendente — e a próxima tarefa que recebesse essa conexão rodava dentro da operação de quem falhou. Agora a conexão que falhou é descartada (o pg-pool a encerra ao receber o erro) e uma nova é aberta para a próxima tarefa. Quem não falhou segue como antes, com o mesmo `release()` sem argumento. Nada precisa ser feito ao atualizar.

Contribuição de @webtecnica (fecha #2624).
