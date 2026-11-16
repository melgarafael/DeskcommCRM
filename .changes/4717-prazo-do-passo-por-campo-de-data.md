---
impacto: recurso_novo
secao: adicionado
titulo: O prazo de um passo do plano pode contar de um campo de data do card, e as tarefas abertas acompanham a mudança da data
---

O plano de tarefas só sabia contar prazo de um jeito: N dias a partir do dia em que o
plano era aplicado. Isso serve para "ligar em 2 dias" e não serve para o processo que
tem data na frente — "cobrar 7 dias antes da viagem", "pedir o depoimento 3 dias depois
do evento". Nesses, o prazo das tarefas não é medido do dia da aplicação: é medido do dia
do EVENTO, que cada negócio tem no seu próprio campo de data.

Agora cada passo pode declarar que o prazo conta de um campo de data do card, com o
deslocamento em dias — negativo para antes, positivo para depois. Na aplicação do plano,
o prazo é calculado a partir da data daquele negócio, às 09:00 do fuso da organização.
Se o campo estiver vazio, o passo nasce sem prazo em vez de receber uma data inventada, e
o motivo fica gravado na tarefa e na linha do tempo do negócio, nomeando o campo que
falta preencher. Quando a data do card muda depois, as tarefas do plano que ainda estão
abertas são recalculadas; as concluídas ficam como estavam — prazo de tarefa concluída é
histórico.

O plano que já existe continua igual: passo com "vence em N dias" é aplicado exatamente
como antes, e a ação de automação que aplica planos não muda de contrato. A tela de
Planos de tarefa ganhou o seletor de onde o prazo conta, com o campo de data e o
deslocamento. Nenhuma ação é necessária na atualização.
