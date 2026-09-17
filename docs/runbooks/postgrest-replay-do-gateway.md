# PostgREST em 503 PGRST002 com o banco saudável — replay do gateway do Supabase

Incidente de 2026-09-11 (VPS de produção, projeto Supabase `kkffykiqbjamvopnrhaa`).
Conserto estrutural: migration `0237_guarda_contra_replay_do_gateway`.

## Sintoma

- Toda tela em "Algo deu errado"; o log do app repete em todas as rotas e crons:
  `PGRST002 Could not query the database for the schema cache. Retrying.`
- `psql` pelo pooler responde em milissegundos. O banco não é o problema.
- `curl "$SUPABASE_URL/rest/v1/<qualquer tabela>"` → 503 com o mesmo `PGRST002`.

## Diagnóstico (cada linha é comando, não afirmação)

Rollbacks por segundo — a assinatura do replay é "milhares por segundo com o app ocioso":

```bash
psql "$SUPABASE_DB_URL" -Atc "select xact_rollback, xact_commit from pg_stat_database where datname=current_database()"
sleep 10
psql "$SUPABASE_DB_URL" -Atc "select xact_rollback from pg_stat_database where datname=current_database()"
```

Quem está abortando (medido: só `fn_followup_patch` e `fn_google_appointment`, ambas terminando em `40001`):

```bash
psql "$SUPABASE_DB_URL" -Atc "select state, left(query,120) from pg_stat_activity where usename='authenticator' and state<>'idle'"
```

Prova de que a VPS NÃO é a origem (57 pacotes na porta 443 em 14 s contra 31.839 rollbacks):

```bash
timeout 12 tcpdump -ni any -w /tmp/cap.pcap "port 443"; tcpdump -nr /tmp/cap.pcap "tcp dst port 443" | wc -l
```

Quem é a origem — o `sb-request-id` é UUIDv7 e os 48 bits iniciais são o instante em que o gateway aceitou a requisição.
Para vê-lo sem parar nada, exponha-o em `application_name` por dentro da função reexecutada por alguns segundos
(`perform set_config('application_name', left(current_setting('request.headers',true)::jsonb->>'sb-request-id',63), true)`),
amostre `pg_stat_activity` e RESTAURE o corpo original (`pg_get_functiondef` antes, `diff` depois). Decodifique:

```bash
python3 -c 'import datetime;h="01a08690-28dd";print(datetime.datetime.fromtimestamp(int(h.replace("-",""),16)/1000,datetime.UTC))'
```

Se o instante é de horas ou dias atrás e o mesmo `cf-ray` se repete em todas as amostras, é o gateway reexecutando —
o cliente que originou já não existe.

## Mecanismo

1. `raise exception ... using errcode='40001'` (conflito benigno de revisão) → o PostgREST mapeia a classe 40 para HTTP **500**.
2. O gateway do Supabase (Envoy/worker à frente do PostgREST) reexecuta 5xx sem limite, com o mesmo `sb-request-id`.
3. Oito requisições em loop ocupam o pool inteiro; o carregamento do schema cache não obtém conexão e falha.
4. Em `AppState.hs`, falha no carregamento ⇒ cache `Nothing` ⇒ **toda** requisição responde 503 `PGRST002`.

## Conserto

O hook `pgrst.db_pre_request = public.fn_pgrst_recusar_replay_do_gateway` responde `PT409` (HTTP 409) a requisição
cujo `sb-request-id` tem mais de 5 minutos. 4xx não é reexecutado. Conferir que está registrado:

```bash
psql "$SUPABASE_DB_URL" -Atc "select rolconfig from pg_roles where rolname='authenticator'"   # contém pgrst.db_pre_request=...
psql "$SUPABASE_DB_URL" -Atc "select sum(calls) from pg_stat_statements s join pg_roles r on r.oid=s.userid where r.rolname='authenticator' and query ilike '%fn_pgrst_recusar_replay_do_gateway%'"  # cresce a cada requisição
```

**Instalar o hook NO MEIO da tempestade não basta:** o `NOTIFY pgrst, 'reload config'` também precisa de uma conexão do
pool, e o PostgREST não tenta de novo quando falha. O destravamento de emergência é chamar a guarda por dentro das
funções que estão sendo reexecutadas (uma linha `perform public.fn_pgrst_recusar_replay_do_gateway();` logo após o
`begin`), esperar os rollbacks zerarem, mandar o `NOTIFY` de novo e RESTAURAR os corpos originais com `diff` vazio.

## Follow-up (não feito aqui)

Conflito benigno não deveria sair como 5xx. Trocar `40001` por um código `PTxxx` (409) nas 25 funções / 71 pontos de
`raise` e nos ~20 pontos do cliente que leem `code === "40001"` é a melhoria de classe; o hook é a rede que segura
enquanto isso não acontece — e depois também, porque qualquer 5xx (bug novo, timeout) volta a ser reexecutável.
