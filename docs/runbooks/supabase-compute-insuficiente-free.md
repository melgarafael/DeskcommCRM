# Compute insuficiente no plano free do Supabase — projeto cai com PGRST002/522

> Este runbook cobre **outra causa** da mesma aparência. Se você chegou aqui
> procurando o caso do gateway do Supabase **reexecutando** requisições antigas
> (rollbacks por segundo, `fn_followup_patch` em loop, `sb-request-id` repetido),
> **este NÃO é o seu caso** — use
> [`docs/runbooks/postgrest-replay-do-gateway.md`](./postgrest-replay-do-gateway.md).
> Aquele tem o banco saudável (`psql` responde em ms) e a VPS não é a origem.
> Aqui o banco/projeto **está** indisponível por falta de compute.

## Quando usar

- Instalação no plano **free** (compute Nano, 0,5 GB) do Supabase.
- `/api/v1/health` reporta `supabase: down` com `reason: projeto_indisponivel`
  (ou, antes deste conserto, `tempo_esgotado` genérico).
- Chamadas a `/rest/v1/*` retornam **522** (Cloudflare não alcança a origem) ou
  **503 `PGRST002`** ("Could not query the database for the schema cache.
  Retrying.").
- Sem ninguém usando o sistema, por horas.

## Sintoma

- 100% das chamadas `/rest/v1` retornam 522 por longos períodos (medido: ~6 h).
- O app responde "Algo deu errado" em todas as telas.
- Só volta com **Restart project** manual no painel do Supabase.
- `psql` pelo pooler pode estar lento ou não responder — diferente do caso de
  replay, em que o banco responde em ms.

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
psql "$SUPABASE_DB_URL" -c \
  "select count(*) as total,
          count(*) filter (where state = 'active') as ativos,
          count(*) filter (where state = 'idle in transaction') as idle_em_tx
     from pg_stat_activity
    where datname = current_database();"
```

E quem são:

```bash
psql "$SUPABASE_DB_URL" -c \
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
psql "$SUPABASE_DB_URL" -c \
  "select name, setting, unit
     from pg_settings
    where name in ('max_connections', 'shared_buffers', 'work_mem',
                   'effective_cache_size', 'maintenance_work_mem');"
```

Confirme que os valores correspondem ao compute do plano free (Nano). Se o
projeto já cresceu além disso, o compute mínimo suportado não é o do free.

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
