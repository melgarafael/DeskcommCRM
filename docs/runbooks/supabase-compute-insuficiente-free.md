# Compute insuficiente no plano free do Supabase — projeto cai com PGRST002/522

> Este runbook cobre **outra causa** da mesma aparência. Se você chegou aqui
> procurando o caso do gateway do Supabase **reexecutando** requisições antigas
> (rollbacks por segundo, `fn_followup_patch` em loop, `sb-request-id` repetido),
> **este NÃO é o seu caso** — use
> [`docs/runbooks/postgrest-replay-do-gateway.md`](./postgrest-replay-do-gateway.md).
> Aquele tem o banco saudável (responde em ms a um `select 1`) e a VPS não é a
> origem. Aqui o banco/projeto **está** indisponível por falta de compute.

## Quando usar

- Instalação no plano **free** (compute Nano, 0,5 GB) do Supabase.
- `/api/v1/health` reporta `supabase: down` com `reason: projeto_indisponivel`
  (ou, antes deste conserto, `tempo_esgotado` genérico).
- Chamadas a `/rest/v1/*` retornam **522** (Cloudflare não alcança a origem) ou
  **503 `PGRST002`** ("Could not query the database for the schema cache.
  Retrying.").
- Sem ninguém usando o sistema, por horas.

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

## Sintoma

- 100% das chamadas `/rest/v1` retornam 522 por longos períodos (medido: ~6 h).
- O app responde "Algo deu errado" em todas as telas.
- Só volta com **Restart project** manual no painel do Supabase.
- `psql` pelo pooler pode estar lento ou não responder — diferente do caso de
  replay, em que o banco responde em ms (o teste é o `select 1` do bloco
  [*Antes de rodar*](#antes-de-rodar--a-pasta-e-o-psql)).

## Como confirmar

### 1. Painel — Infrastructure

No painel do projeto: **Project Settings → Infrastructure** (ou
**Reports → Database**). Verifique:

- Compute size atual (Nano / 0,5 GB no free).
- CPU e memória no teto por longos períodos.
- Conexões ativas perto do limite.

Se CPU/memória ficam saturados sem carga de usuário, é compute insuficiente.

### 2. `pg_stat_activity` — quem está consumindo

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

No caso de compute insuficiente, o número de conexões ativas é baixo e não há
replay/loop — o problema é a capacidade, não a tempestade.

### 3. `pg_settings` — limites do plano

```bash
psql_vps -c \
  "select name, setting, unit
     from pg_settings
    where name in ('max_connections', 'shared_buffers', 'work_mem',
                   'effective_cache_size', 'maintenance_work_mem');"
```

Confirme que os valores correspondem ao compute do plano free (Nano). Se o
projeto já cresceu além disso, o compute mínimo suportado não é o do free.

Os valores de referência por compute são os da doc do Supabase
([*Compute and Disk*](https://supabase.com/docs/guides/platform/compute-and-disk),
tabela **Database Max Connections**): é lá que se confere o número, porque ele
muda com o plano — este runbook não os repete de memória.

### 4. Diferença para o replay do gateway

| Sinal | Compute insuficiente (este runbook) | Replay do gateway |
|---|---|---|
| `psql` responde? | lento ou não | sim, em ms |
| Rollbacks/s | normal | milhares |
| Origem do tráfego | o próprio projeto | gateway reexecutando |
| `sb-request-id` repetido? | não | sim |
| Conserto estrutural | aumentar compute / Restart | hook `fn_pgrst_recusar_replay_do_gateway` |

## Recuperação

1. **Restart project** no painel do Supabase (Project Settings → General →
   Restart project). É o destravamento imediato medido em produção.
2. Depois de voltar, monitore CPU/memória. Se saturar de novo sem carga, o
   compute do plano free (Nano, 0,5 GB) é insuficiente para o volume.
3. **Se voltar a cair parado**, subir o compute para **Micro (1 GB)** no painel
   de compute do Supabase é o próximo passo a testar: dá o dobro de memória à
   introspecção do schema cache. **Não está medido que resolva:** na única
   instalação medida (29/10), quem devolveu o serviço foi o *Restart project*.
   Também não está medido que a Nano falhe assim em toda instalação; o plano
   grátis continua sendo o caminho documentado de instalação.

   **Micro só existe em plano pago, e assinar não troca o compute.** O plano
   grátis roda o Nano e o Micro é dos planos pagos, então este passo são dois
   atos: assinar um plano pago e depois trocar o compute do projeto. O projeto
   que veio do grátis pode continuar no Nano (0,5 GB) dentro do plano pago,
   cobrado pelo preço do Micro, até você trocar. O Supabase não troca sozinho
   porque a troca causa uma queda, em geral de menos de 2 minutos segundo a doc
   ([*Compute and Disk*](https://supabase.com/docs/guides/platform/compute-and-disk)).

   O plano e os US$ 10/mês em créditos de compute são da organização, não de
   cada projeto: o crédito cobre um projeto no Micro, e cada projeto a mais soma
   o compute dele. **Exemplo lido na doc oficial em 05/11/2026**, não orçamento:
   Pro US$ 25/mês + Micro ~US$ 10/mês − US$ 10 de crédito ≈ **US$ 25/mês** com
   um projeto; com dois projetos no Micro, ≈ **US$ 35/mês**. Preço e crédito
   mudam; confira os valores e o que o crédito cobre em
   <https://supabase.com/docs/guides/platform/manage-your-usage/compute> antes de
   trocar o compute.
4. Se o projeto estava pausado por inatividade (free pausa após 1 semana), use
   **Restore project** em vez de Restart.

## O que NÃO fazer

- Não confunda com o replay do gateway: instalar o hook de replay não resolve
  falta de compute.
- Não rode `VACUUM FULL` nem migrações pesadas durante a saturação — piora.
- Não aumente o pool de conexões do app: não cria CPU que não existe.

## Referências

- [`docs/runbooks/postgrest-replay-do-gateway.md`](./postgrest-replay-do-gateway.md) —
  o outro caso, com mecanismo diferente.
- [`docs/runbooks/custo-e-cota-do-supabase.md`](./custo-e-cota-do-supabase.md) —
  cotas de egress/espaço no free.
