# Supabase sem memória no plano free — o sistema parado, com zero uso, em 522/PGRST002

> Este runbook cobre **outra causa** da mesma aparência. Se você chegou aqui
> procurando o caso do gateway do Supabase **reexecutando** requisições antigas
> (rollbacks por segundo, `fn_followup_patch` em loop, `sb-request-id` repetido),
> **este NÃO é o seu caso** — use
> [`docs/runbooks/postgrest-replay-do-gateway.md`](./postgrest-replay-do-gateway.md).
> Aquele tem o banco saudável (responde em ms a um `select 1`), o hook
> `fn_pgrst_recusar_replay_do_gateway` **já instalado**, e a VPS não é a origem.
> Aqui o projeto **está** fora do ar por falta de memória, e aquele hook não tem
> o que recusar: não há replay nenhum, há um PostgREST que não consegue carregar
> o schema cache.
>
> O `/api/v1/health` aponta para cá: quando o check do banco reconhece esta
> causa, ele devolve `causa: "postgrest_sem_schema_cache"` (ou
> `"projeto_sem_resposta_na_origem"`, no 522) e
> `runbook: "docs/runbooks/supabase-sem-memoria-no-free.md"`.

## Quando usar

- Instalação no plano **free** (compute Nano, 0,5 GB) do Supabase.
- `/api/v1/health` reporta `supabase: down`. Antes deste conserto o motivo era
  só `tempo_esgotado` — **exatamente o defeito desta issue**; hoje a resposta
  traz `causa` e `runbook` (ver [Sintoma](#sintoma--o-que-foi-medido)).
- Chamadas a `/rest/v1/*` retornam **522** (o Cloudflare não alcança a origem) ou
  **503 `PGRST002`** ("Could not query the database for the schema cache.
  Retrying.").
- Ninguém usando o sistema, por horas — e mesmo assim não volta sozinho.

## Sintoma — o que foi medido

Numa instalação real, no compute Nano (0,5 GB), em 29/10:

| Medida | Valor |
|---|---|
| Tempo fora do ar, sem usuário nenhum | ~6 h |
| Chamadas a `/rest/v1` respondendo **522** | 100% |
| Chamadas com sucesso no período | 0 |
| Tamanho do banco | ~96 MB |
| Compute | Nano, 0,5 GB (plano free) |
| Schema (o que o PostgREST introspecciona) | 213 tabelas, 584 funções, 684 policies, 759 índices, 222 triggers |
| Introspecção do schema cache com o banco saudável | ~722 ms |
| `statement_timeout` do papel `authenticator` | 8 s |
| Como voltou | **Restart project** manual no painel; não voltou sozinho |

O que o `/api/v1/health` respondia:

```
supabase: down, tempo_esgotado
```

Uma frase só para três causas diferentes. Este runbook e o campo `causa` do
health existem para acabar com isso.

## O que o corpo do PostgREST distingue (e o que ele não distingue)

O PostgREST, quando **não** conseguiu carregar o schema cache dentro do
`statement_timeout`, responde **503** com corpo JSON:

```json
{"code":"PGRST002","message":"Could not query the database for the schema cache. Retrying."}
```

Sobrecarga que **não chega a produzir resposta** não deixa corpo nenhum: quem
responde é o Cloudflare, com **522**, sem `code` e sem mensagem. Ou seja, **não
existe uma string de "sobrecarga"** para comparar com a do schema cache — o que
separa os ramos é a **combinação** `status` + `corpo`:

| O que chegou | O que é | `causa` no health |
|---|---|---|
| 503 + `PGRST002` (ou 5xx citando "schema cache") | o PostgREST respondeu; o cache de schema é o problema | `postgrest_sem_schema_cache` |
| 522, corpo vazio | nada respondeu na origem | `projeto_sem_resposta_na_origem` |
| nosso `fetch` estourou o tempo, sem status | não dá para separar | `lentidao_generica` |
| conexão recusada / DNS / TLS | não chegamos ao PostgREST | `banco_inacessivel` |

A última linha é a única que **não** manda para este runbook: ali o projeto pode
estar de pé e o problema é chegar nele. O health aponta para
[`rodar-sql-na-vps.md`](./rodar-sql-na-vps.md) nesse caso.

## Antes de rodar — a pasta e o `psql`

Tudo abaixo roda **na VPS, por SSH**, de dentro da pasta da instalação, e o
`psql` é o do contêiner: a VPS instalada pelo kit não traz cliente de Postgres
no host. Rode este bloco uma vez na sessão e os comandos seguintes funcionam
copiando e colando. O porquê de cada linha está em
[`rodar-sql-na-vps.md`](./rodar-sql-na-vps.md).

```bash
P="$(find /root /opt /home /var/www -maxdepth 4 -name docker-compose.prod.yml 2>/dev/null | head -1)"
if [ -n "$P" ]; then cd "$(dirname "$P")" && pwd; else echo "instalação não encontrada"; fi
psql_vps() { bash -c 'source hostgator-setup-kit/_common.sh && load_env .env && psql_run "$@"' _ "$@"; }
psql_vps -c 'select 1'   # tem de responder 1
```

Se o `select 1` **não** responder, pare aqui: você está no ramo
`banco_inacessivel` (endereço/rede), não no de memória.

## Diagnóstico passo a passo

### 1. O painel — Infrastructure

No painel do projeto: **Project Settings → Infrastructure** (ou
**Reports → Database**). Verifique:

- Compute size atual (Nano / 0,5 GB no free).
- CPU e memória no teto por longos períodos.
- Conexões ativas perto do limite.
- **Disk IO Budget** esgotado (é o sinal medido nesta instalação).

Se CPU/memória ficam saturados **sem carga de usuário**, é falta de memória.

### 2. O health, com a causa e o ponteiro

```bash
curl -s https://SEU-CRM/api/v1/health | python3 -m json.tool
```

O que ler em `data.checks.supabase`:

- `causa: "postgrest_sem_schema_cache"` → este runbook, seção
  [Recuperação](#recuperação).
- `causa: "projeto_sem_resposta_na_origem"` (522) → este runbook também: o
  projeto não está no ar.
- `causa: "banco_inacessivel"` → **não** é memória; confira endereço, DNS e rede
  antes de reiniciar o projeto.
- `causa: "lentidao_generica"` → tentamos e o tempo acabou sem resposta; comece
  pelo painel (passo 1), porque sem corpo não há como separar os dois ramos.

`reason` continua saindo com os valores de antes (`projeto_indisponivel`,
`tempo_esgotado`, …) — quem já monitora não perde nada. `runbook` é o caminho do
documento, relativo à raiz do repositório.

### 3. `pg_stat_activity` — quem está consumindo

```bash
psql_vps -c \
  "select count(*) as total,
          count(*) filter (where state = 'active') as ativos,
          count(*) filter (where state = 'idle in transaction') as idle_em_tx
     from pg_stat_activity
    where datname = current_database();"
```

E quem são:

```bash
psql_vps -c \
  "select usename, state, count(*) as n, left(query, 80) as consulta
     from pg_stat_activity
    where datname = current_database()
    group by usename, state, left(query, 80)
    order by n desc limit 20;"
```

No caso de falta de memória, o número de conexões ativas é **baixo** e não há
replay/loop — o problema é a capacidade, não a tempestade. Se houver milhares de
rollbacks e `sb-request-id` repetido, você está no
[outro runbook](./postgrest-replay-do-gateway.md).

### 4. `pg_settings` — os limites do plano

```bash
psql_vps -c \
  "select name, setting, unit
     from pg_settings
    where name in ('max_connections', 'shared_buffers', 'work_mem',
                   'effective_cache_size', 'maintenance_work_mem');"
```

Valores de referência por compute são os da doc do Supabase
([*Compute and Disk*](https://supabase.com/docs/guides/platform/compute-and-disk),
tabela **Database Max Connections**): é lá que se confere o número, porque ele
muda com o plano — este runbook não os repete de memória.

### 5. Logs — o `PGRST002` com hora

**Logs → Postgres** (ou **Logs Explorer**, filtrando por `PGRST002`) e
**Logs → API Edge**. O que se procura é a sequência: `statement timeout` na
consulta de introspecção do schema cache, seguida de `PGRST002` repetido.

Aviso medido: com o problema presente, a sonda do Logs Explorer pode devolver
**zero linhas** — ausência de log aqui não inocenta o ramo.

## Recuperação

1. **Restart project** no painel do Supabase (**Project Settings → General →
   Restart project**). É o destravamento imediato medido em produção: o
   PostgREST sobe de novo e carrega o schema cache do zero.
2. Se o projeto estava **pausado por inatividade** (o free pausa após uma
   semana), use **Restore project** em vez de Restart.
3. Depois de voltar, monitore CPU/memória e o **Disk IO Budget**. Se saturar de
   novo **sem carga**, o compute do plano free é insuficiente para este schema —
   vá para [Compute mínimo](#compute-mínimo-suportado--a-conta).

## Compute mínimo suportado — a conta

**O que não está medido, dito antes da recomendação:** na única instalação
medida, quem devolveu o serviço foi o *Restart project*. **Nenhum relato mede o
upgrade de compute resolvendo.** A recomendação abaixo é a menor unidade que
existe acima do Nano, e o porquê está na conta — não é promessa de conserto.

**O que precisa caber.** A RAM da instância é dividida entre o Postgres (com
`shared_buffers`), o PostgREST, o Kong/GoTrue/Realtime/Storage — e o **schema
cache em memória do PostgREST**, que é montado por introspecção a cada início ou
recarga. Quando a introspecção passa do `statement_timeout` do `authenticator`
(8 s), o cache se perde e o PostgREST entra em `PGRST002` até alguém reiniciar.

**A conta, com os números medidos:**

- Nano = **0,5 GB** de RAM. Medido: a instância entrou em **swap**, esgotou o
  **Disk IO Budget**, e a introspecção — que leva **~722 ms** com o banco
  saudável — passou dos **8 s** de teto durante o swap.
- O banco tinha **~96 MB**: **0,19×** a RAM do Nano. Não é volume de dados que
  estoura; é a memória da instância contra o tamanho do catálogo (213 tabelas,
  584 funções, 684 policies, 759 índices, 222 triggers).
- **Micro = 1 GB**: o **dobro** da RAM do Nano, e a **menor** unidade acima dele
  no painel. É por isso que é o mínimo recomendado — não porque 1 GB tenha sido
  medido como suficiente para este schema.

**Custo (lido na doc oficial em 05/11/2026, não é orçamento):** Micro só existe
em plano pago, e **assinar não troca o compute**. O projeto que veio do grátis
pode continuar no Nano dentro do plano pago, cobrado pelo preço do Micro, até
você trocar. O plano e os US$ 10/mês de crédito de compute são da **organização**,
não de cada projeto: Pro US$ 25 + Micro ~US$ 10 − US$ 10 de crédito ≈
**US$ 25/mês** com um projeto; com dois projetos no Micro, ≈ **US$ 35/mês**.
Confira antes de trocar: <https://supabase.com/docs/guides/platform/manage-your-usage/compute>.
A troca de compute causa uma queda, em geral de menos de 2 minutos segundo a doc
([*Compute and Disk*](https://supabase.com/docs/guides/platform/compute-and-disk)).

## Diferença de mecanismo para o replay do gateway

Mesma aparência (`/rest/v1` falhando, app fora), **mecanismo oposto**:

| Sinal | Sem memória no free (este runbook) | Replay do gateway |
|---|---|---|
| `psql ... select 1` | lento ou não responde | responde em ms |
| Rollbacks/s | normal | milhares |
| Origem do tráfego | o próprio projeto | gateway reexecutando requisições |
| `sb-request-id` repetido? | não | sim |
| Hook `fn_pgrst_recusar_replay_do_gateway` | irrelevante (não há replay) | é a proteção |
| Corpo do erro | 503 `PGRST002` ou 522 sem corpo | 5xx de conflito/rollback, sem `PGRST002` |
| Conserto | **Restart project** (e compute, se repetir) | hook + conserto da função |

O hook de replay **não** resolve este caso: ele recusa requisição reexecutada;
aqui não há requisição reexecutada, há um PostgREST sem cache de schema. Foi por
isso que a instalação medida continuou 6 h fora mesmo com a proteção instalada.

## O que NÃO fazer

- Não instale o hook de replay esperando resolver falta de memória — ele já está
  instalado nas instalações que o têm, e este caso continuou acontecendo.
- Não rode `VACUUM FULL` nem migrações pesadas durante a saturação — piora.
- Não aumente o pool de conexões do app: não cria CPU nem memória que não existem.
- Não reinicie a VPS nem os contêineres do CRM: o problema é do projeto
  Supabase, e o restart que resolve é o do painel.

## Referências

- [`docs/runbooks/postgrest-replay-do-gateway.md`](./postgrest-replay-do-gateway.md) —
  o outro caso, com mecanismo diferente (e o caminho de volta).
- [`docs/runbooks/custo-e-cota-do-supabase.md`](./custo-e-cota-do-supabase.md) —
  cotas de egress/espaço no free e a mesma medição em contexto.
- [`docs/runbooks/rodar-sql-na-vps.md`](./rodar-sql-na-vps.md) — como rodar as
  consultas acima (pasta, `psql`, connection string).
