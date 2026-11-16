# Rodar SQL na instalação — a pasta, a connection string e o `psql` que a VPS não tem

Os runbooks de banco ([`supabase-compute-insuficiente-free.md`](./supabase-compute-insuficiente-free.md),
[`custo-e-cota-do-supabase.md`](./custo-e-cota-do-supabase.md),
[`postgrest-replay-do-gateway.md`](./postgrest-replay-do-gateway.md)) pedem
consultas a `pg_stat_activity`, `pg_settings` e `pg_stat_statements`. Este guia é
o passo anterior a qualquer uma delas: **de que pasta** rodar, **com que cliente**
e **de onde tirar a connection string**.

## Por que o copia-e-cola não funciona de primeira

- **`docker compose` só encontra o arquivo de dentro da pasta da instalação.**
  `-f docker-compose.prod.yml` é caminho **relativo**: rodado em `/root`, devolve
  `no such file or directory` mesmo com o arquivo existindo na pasta onde o
  instalador clonou (`/root/deskcommcrm` no caminho padrão).
- **A VPS instalada pelo kit não tem `psql`.** O kit não instala cliente de
  Postgres no host — quem aplica o schema é um contêiner efêmero (`pg_container`,
  em `hostgator-setup-kit/_common.sh`). Por isso o comando responde
  `psql: command not found`.
- **`$SUPABASE_DB_URL` não está no seu shell.** Ela existe no `.env` da
  instalação, e o shell do SSH não lê esse arquivo sozinho.

## Passo 1 — entre na pasta da instalação

O critério abaixo é o mesmo que o `achar_projeto` do
`hostgator-setup-kit/diagnostico.sh` usa quando a instalação não está num dos
caminhos padrão:

```bash
P="$(find /root /opt /home /var/www -maxdepth 4 -name docker-compose.prod.yml 2>/dev/null | head -1)"
if [ -n "$P" ]; then cd "$(dirname "$P")" && pwd; else echo "instalação não encontrada"; fi
```

A linha imprime a pasta em que você ficou. Se imprimir `instalação não
encontrada`, ela não está nesses lugares: rode `bash hostgator-setup-kit/diagnostico.sh`
de dentro do clone, que procura também nos caminhos padrão e diz o que encontrou.

**Todos os comandos dos runbooks rodam desta pasta:** é ela que tem o `.env` e o
`docker-compose.prod.yml`.

## Passo 2 — o `psql` do kit, numa função

```bash
psql_vps() { bash -c 'source hostgator-setup-kit/_common.sh && load_env .env && psql_run "$@"' _ "$@"; }
psql_vps -c 'select 1'
```

`select 1` respondendo `1` é a prova de que os dois passos estão certos. A função
dura até você sair do SSH; numa sessão nova, repita os dois passos. Daí em diante,
`psql_vps` aceita o que o `psql` aceita (`-c "…"`, `-Atc "…"`).

Por que não montar o comando à mão: a função só chama o que o kit já usa para
aplicar o schema e fazer backup, e cada peça resolve um tropeço real.

- **`load_env`** lê o `.env` do jeito certo. Um `grep | cut` devolve a senha
  adulterada quando ela tem `$`, aspas, barra invertida ou crase, porque o
  instalador grava o valor com escape, e o `psql` recusa a autenticação.
- **`psql_run`** roda o `postgres:17-alpine` na rede certa: a `PSQL_DOCKER_NETWORK`
  que o instalador single-server grava no `.env` ou, sem ela, a
  `SUPABASE_DOCKER_NETWORK` de um Supabase próprio. Na nuvem não precisa de rede
  nenhuma. Se o `.env` declara `SUPABASE_SSL_ROOT_CERT`, ele monta a CA.
- **A conta** é a de manutenção do kit: `SUPABASE_DB_ADMIN_URL` quando existe,
  senão `SUPABASE_DB_URL`.
- **O `bash -c`** existe porque o `_common.sh` liga `set -e`. Carregado direto no
  seu shell, o primeiro comando que falhasse derrubaria a sessão SSH.

A connection string não entra no histórico do shell nem fica exportada nele. Ela
é segredo: não cole a saída de `env` nem do `.env` em chat, issue ou print.

## Sem cliente nenhum: o SQL Editor do painel

As mesmas consultas rodam no painel, sem `psql` e sem SSH:

- **Supabase na nuvem:** abra o projeto no painel → **SQL Editor** → **New
  query** e cole só o SQL (sem `psql "…" -c`, sem as aspas que envolvem a
  consulta).
- **Supabase próprio (single-server):** o Studio do kit, na mesma VPS.

A saída é a mesma; o que muda é onde ela aparece.

## Se você tem `psql` na máquina

`psql "<connection string>" -c '…'` continua valendo — no seu computador, ou numa
VPS que já tinha o cliente instalado, o contêiner é dispensável. O que não
existe é o `psql` **na VPS instalada pelo kit**.
