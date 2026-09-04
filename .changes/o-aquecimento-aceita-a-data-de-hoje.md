---
impacto: nada_mudou
secao: corrigido
titulo: A proteção de envio volta a aceitar a data de hoje
---

Em **Conexões › Proteção de envio**, informar hoje em "este número é usado
desde" era recusado durante a manhã inteira: até as 9h no relógio de quem
opera no Brasil, salvar devolvia *"Campos inválidos."* e não gravava nada — nem
a janela de horário, nem o intervalo entre envios, nem o teto diário que você
tinha acabado de mudar na mesma tela.

O motivo: o campo pergunta um DIA, mas a verificação o comparava com a hora
exata em Londres. Um dia não tem hora — ele começa em horários diferentes em
cada parte do mundo —, e por isso "hoje" só era aceito depois do meio-dia
londrino. Agora a verificação compara dias com dias, e só recusa a data que
ainda não chegou em canto nenhum do planeta.

O calendário do campo também parou de oferecer o dia errado: depois das 21h ele
mostrava amanhã como escolha possível.

Data futura continua recusada, e data antiga continua sendo o caso normal — é
informando a data antiga que um número usado há meses deixa de ser tratado como
recém-criado e sai do teto de 20 envios por dia.
