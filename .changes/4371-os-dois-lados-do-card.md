---
impacto: nada_mudou
secao: corrigido
titulo: Inbox › Transferir: a troca de dono do negócio agora tem os dois lados provados
---

Fechamos a prova que faltava no complemento do #3177: ao transferir a conversa entre atendentes, o negócio do contato acompanha o novo responsável — e o card **não** troca de dono por fora da transferência.

O conserto de comportamento já está na instalação; o que faltava era a medida do lado negativo. O teste de banco agora prova, no mesmo arquivo, que o atendente dono do card transfere e a colega passa a ver o negócio no filtro "Responsável", e que uma troca de responsável feita direto na tabela (fora da transferência) continua sendo recusada pelo banco — inclusive ao tentar tomar o card de um colega, ao "Assumir" uma conversa cujo negócio já tem dono e quando quem transfere não é o dono do card.

Nenhuma regra de visibilidade foi afrouxada: a lista de permissões de escrita do negócio fica fixada no teste, então qualquer abertura futura aparece como falha em vez de virar card trocado em silêncio. Ajuste a partir da issue #4371.
