---
impacto: nada_mudou
secao: corrigido
titulo: O restore.sh falha alto num banco que já existe, em vez de dizer que restaurou
---

Quem restaurava um backup com o `restore.sh` por cima de um banco que ainda tinha o schema recebia "✓ banco restaurado" sem nada ter voltado: o psql seguia por cima dos milhares de erros "already exists" e saía com zero, e as linhas apagadas de tabela cheia não voltavam. O restore agora roda o psql com `-v ON_ERROR_STOP=1 --single-transaction`, para na primeira instrução, desfaz a transação inteira e termina com erro, deixando o banco exatamente como estava. O próprio script e o README agora avisam, em português, que o dump do `backup.sh` sai sem `--clean` e portanto não restaura por cima de um banco existente. Restaurar num banco novo ou esvaziado continua igual. Não é preciso fazer nada na instalação.

Refs #2120.

Contribuição de @webtecnica (#2142).
