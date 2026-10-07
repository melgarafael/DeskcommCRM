---
impacto: nada_mudou
secao: corrigido
titulo: O restore.sh para antes num banco que já existe e restaura num banco vazio
---

Quem restaurava um backup com o `restore.sh` por cima de um banco que ainda tinha o schema recebia "✓ banco restaurado" sem nada ter voltado: o psql seguia por cima dos milhares de erros "already exists" e saía com zero, e as linhas apagadas de tabela cheia não voltavam. O script agora conta as tabelas de `public` antes de pedir a confirmação e, se o banco já tem o schema, para com a própria mensagem — sem alterar nada e sem nem chamar o `psql`.

Também saíram as flags `-v ON_ERROR_STOP=1 --single-transaction`, porque elas faziam o restore falhar também em banco **vazio**. O dump do `backup.sh` traz os schemas internos (`auth`, `storage`, `realtime`, `vault`) e extensões como `pg_net`, que já existem num Supabase novo: medido em Supabase novo, Postgres 17 puro e database nova, as três deram `rc=3` e 0 tabelas; sem elas, nos dois primeiros, o mesmo dump entrou com `rc=0` e 110 tabelas. Restaurar num banco novo continua funcionando, e quem segura o banco populado é a checagem da contagem. Como não há mais transação única, uma falha fatal do psql deixa o banco incompleto — o script e o README avisam para conferir o estado antes de repetir.

O script e o README agora dizem, em português, que o dump sai sem `--clean` e portanto não restaura por cima de um banco existente. Se a contagem não volta um número, o script também para sem alterar nada. Não é preciso fazer nada na instalação.

Mudou o que o sistema diz quando uma atualização dá errado: a tela de atualização, as mensagens do `update.sh`, os READMEs e os guias deixaram de prometer que o `restore.sh` volta o backup por cima do banco em uso — essa promessa já era falsa antes, porque o restore dizia "✓" sem restaurar. Hoje o backup só volta num banco vazio, como um projeto Supabase novo em que o instalador ainda não rodou; fora disso, peça ajuda. Voltar o backup por cima do banco existente segue em aberto na #2120.

Refs #2120.

Contribuição de @webtecnica (#2142).
