---
impacto: nada_mudou
secao: alterado
titulo: A hora que vem do banco deixa de ser conferida contra um dublê
---

O driver do Postgres entrega data e hora (colunas `timestamptz`) como objeto de data; as leituras que passam pela API do Supabase entregam o mesmo valor como texto. Uma regra escrita para o segundo caso fica **inerte** no primeiro: o teste passa porque o dublê devolve texto, e em produção a regra responde "não vi" sem erro nenhum no log.

A conferência dessa fronteira agora roda contra um Postgres de verdade, com uma coluna `timestamptz` e o valor exatamente como o driver entrega, e cobre as onze regras de data que o sistema declara — a mídia pendente, a hora de cada fala do caso, a presença do atendente, a janela de pausa do canal, o prazo de LGPD, a renovação do token da agenda, a leitura de banco externo, entre outras. Regra nova que leia data do banco tem de entrar nessa mesma lista, senão a conferência reprova.

Nada muda para quem já usa o sistema: todas as regras conferidas já aceitavam as duas formas. O que passa a existir é a prova de que continuam aceitando — e de que não deslocam o horário em três horas ao converter o fuso.
