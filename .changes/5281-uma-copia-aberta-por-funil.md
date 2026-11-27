---
impacto: nada_mudou
secao: corrigido
titulo: Um negócio tem uma só cópia aberta em cada funil de destino
---

As automações e o encaminhamento do assistente para outro funil não criam mais um segundo card aberto do mesmo negócio no mesmo funil: quando o card já existe, eles usam esse card. O banco passa a recusar a segunda cópia aberta, venha ela de onde vier. Reabrir ou mover um card que viraria a segunda cópia aberta mostra o aviso "Este negócio já tem uma cópia aberta neste funil", em vez de um erro do sistema.

Se a sua instalação já tinha cópias abertas repetidas, a atualização mantém a mais antiga e encerra as outras como perda, com o motivo "levado para outro funil", que não entra nas métricas de perda comercial. O histórico, as tarefas e os vínculos dessas cópias passam para o card que ficou. Nenhum card é apagado, e essa limpeza não dispara automações.

Achado de @webtecnica na revisão do #5268.
