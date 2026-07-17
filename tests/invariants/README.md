# tests/invariants — harness de invariantes de banco

Automatiza o gate manual da doutrina de migrations (CLAUDE.md §"Migrations & Banco",
item 7): o baseline tem que aplicar limpo num Postgres cru e o isolamento RLS entre
tenants tem que valer de verdade.

## Como rodar

```bash
pnpm test:db
```

Requisitos: Docker rodando. Nada mais — o harness não toca no seu banco nem nos
seus containers existentes.

## O contrato do harness (`scripts/test-db.sh`)

1. Sobe um container **efêmero** `pgvector/pgvector:pg17` (nome único
   `deskcomm-test-db-<pid>`, porta local `54329`, override via `TEST_DB_PORT`).
2. Aplica um **prelude** com os stubs mínimos do Supabase que um Postgres cru não
   tem: roles `anon`/`authenticated`/`service_role`, schemas `auth`/`extensions`,
   `auth.users`, `auth.uid()` (lê o claim `sub` de `request.jwt.claims`),
   `storage.buckets`/`storage.objects` e as extensões `uuid-ossp`, `pgcrypto`,
   `vector`, `citext`, `pg_trgm`.
3. **Modo install**: aplica `supabase/baseline.sql` com `ON_ERROR_STOP=1` —
   qualquer statement falhando derruba o run com exit ≠ 0 (é o que o
   `install.sh` do kit self-host faz num banco novo).
4. **Modo update**: re-aplica o baseline **sem** `ON_ERROR_STOP` — prova a
   idempotência do apêndice (é o que o `update.sh` faz num banco existente).
5. Roda a suíte vitest desta pasta (`vitest.db.config.ts`) com
   `TEST_DB_CONTAINER` apontando pro container; os testes falam com o banco via
   `docker exec psql` (sem driver novo no repo).
6. `trap` no `EXIT` remove o container **sempre** — sucesso ou falha.

## O que a suíte prova hoje

- `rls-isolation.test.ts` — cria 2 orgs + 1 usuário em cada e prova que o usuário
  da org A lê **0 rows** da org B em `conversations`, `messages`, `contacts` e
  `crm_leads`, sob RLS com claims simulados
  (`set role authenticated` + `set_config('request.jwt.claims', ...)` — o mesmo
  caminho `auth.uid()` → `fn_user_org_ids()` das policies de produção), mais o
  controle positivo (a própria org continua legível).

## Regras pra adicionar invariante novo

- Arquivo novo `*.test.ts` nesta pasta; ele entra automaticamente no `test:db`
  (config `vitest.db.config.ts`) e fica FORA do `test:unit`.
- Invariantes existentes são **congelados**: adicione, não edite/delete.
- Zero PII em seeds e asserts (LGPD) — dados sintéticos sempre.
- Se o invariante exigir schema novo, isso é migration (tripla completa), não
  mudança no harness. O harness só consome `baseline.sql`.
