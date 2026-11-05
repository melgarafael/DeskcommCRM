---
impacto: capacidade_nova
secao: adicionado
titulo: Tarefas ganham a visão em quadro, com o cartão arrastado entre as situações
---

Ao lado de **Lista** e **Calendário**, a tela de Tarefas ganha o **Quadro**: uma
coluna por situação (Pendente, Em andamento, Concluída, Cancelada) e o cartão
arrastado de uma para a outra. Soltar o cartão grava a situação nova pelo mesmo
caminho de escrita do formulário, e a movimentação fica registrada no log de
auditoria com **quem moveu e de qual situação para qual**.

A busca do quadro é limitada (200 tarefas, contra as 500 da lista) e, quando
bate no teto, a tela **diz** que está mostrando só as primeiras — em vez de
esconder que há mais. Tarefa com situação que a tela não conhece não
desaparece: cai numa coluna própria, "Sem situação". Quem só tem leitura vê o
quadro e não arrasta; a rota recusa com o mesmo `forbidden_role` de sempre.

Lista e Calendário continuam exatamente como estavam.
