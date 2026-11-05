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
  Postgres no host — quem aplica o schema é um contêiner efêmero
  (`hostgator-setup-kit/install.sh:2100`). Por isso o comando responde
  `psql: command not found`.
- **`$SUPABASE_DB_URL` não está no seu shell.** Ela existe no `.env` da
  instalação (`.env.example:520`), e o shell do SSH não lê esse arquivo sozinho.

## Passo 1 — entre na pasta da instalação

O critério abaixo é o mesmo que o `hostgator-setup-kit/diagnostico.sh:49` usa
para achar a instalação:

```bash
cd "$(dirname "$(find /root /opt /home /var/www -maxdepth 4 -name docker-compose.prod.yml 2>/dev/null | head -1)")" && pwd
```

A linha imprime a pasta em que você ficou. Se imprimir vazio, a instalação não
está nesta máquina — rode `bash hostgator-setup-kit/diagnostico.sh` de dentro do
clone, que procura do mesmo jeito e diz o que encontrou.

**Todos os comandos dos runbooks rodam desta pasta:** é ela que tem o `.env` e o
`docker-compose.prod.yml`.

## Passo 2 — traga a connection string para o shell

```bash
export SUPABASE_DB_URL="$(grep -m1 '^SUPABASE_DB_URL=' .env | cut -d= -f2- | tr -d "\"'" )"
test -n "$SUPABASE_DB_URL" && echo "connection string carregada"
```

Ela é segredo: não cole a saída em chat, issue nem print.

## Passo 3 — `psql` pelo contêiner

```bash
docker run --rm -i postgres:17-alpine psql "$SUPABASE_DB_URL" -c 'select 1'
```

`select 1` respondendo `1` é a prova de que os três passos estão certos. A imagem
`postgres:17-alpine` é a mesma que o kit usa e não precisa de instalação.

### Instalação single-server (Supabase próprio na mesma VPS)

O Postgres não é alcançável pela rede padrão do Docker: acrescente a rede que o
`.env` já declara (`.env.example:856`).

```bash
docker run --rm -i --network "$(grep -m1 '^SUPABASE_DOCKER_NETWORK=' .env | cut -d= -f2- | tr -d "\"'")" \
  postgres:17-alpine psql "$SUPABASE_DB_URL" -c 'select 1'
```

## Sem cliente nenhum: o SQL Editor do painel

As mesmas consultas rodam no painel, sem `psql` e sem SSH:

- **Supabase na nuvem:** abra o projeto no painel → **SQL Editor** → **New
  query** e cole só o SQL (sem `psql "…" -c`, sem as aspas que envolvem a
  consulta).
- **Supabase próprio (single-server):** o Studio do kit, na mesma VPS.

A saída é a mesma; o que muda é onde ela aparece.

## Se você tem `psql` na máquina

`psql "$SUPABASE_DB_URL" -c '…'` continua valendo — no seu computador, ou numa
VPS que já tinha o cliente instalado, o contêiner é dispensável. O que não
existe é o `psql` **na VPS instalada pelo kit**.
