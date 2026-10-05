---
impacto: nada_mudou
secao: corrigido
titulo: A tela de agendas não diz mais "Ainda não sincronizada" para agenda que só bloqueia horário
---

Quem conectou o Google e marcou várias agendas para bloquear horário via só UMA delas com "Última sincronização" na tela de agendas conectadas. As outras apareciam como "Ainda não sincronizada", e a única forma de conferir se estavam paradas era olhar o banco — enquanto isso a agenda seguia trazendo eventos normalmente (uma delas trouxe 39).

A rodada de sincronização agora grava a marca em cada agenda que ela leu, e não só na que recebe os compromissos novos: quem só bloqueia horário é lida na mesma passada que a de destino e sai com a própria hora gravada. A marca continua sendo verdadeira — agenda que a rodada não leu não ganha carimbo, e a que não terminou de ler continua mostrando o erro na própria linha, como já mostrava.

Nada a fazer na atualização: a próxima rodada de sincronização grava as marcas que faltarem.

Contribuição de @webtecnica (#2332).
