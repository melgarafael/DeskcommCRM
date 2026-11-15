---
type: doctrine
project: DeskcommCRM
---

# Audit log e retenção

> Extraído **literalmente** do `CLAUDE.md` (seção «Audit log») para o arquivo de entrada caber no
> limite de 40k caracteres do Claude Code. O `CLAUDE.md` guarda a regra dura e aponta para cá;
> aqui mora o texto completo, com os motivos e as medições. Em divergência, vale **este** texto (é o original, copiado literalmente), e o resumo do `CLAUDE.md` é que se corrige.

- Toda mutação POST/PATCH/DELETE bem-sucedida → 1 entrada em `api_audit_log` (fire-and-forget, p99 ≤500ms)
- **Rodada de cron que não fez nada NÃO é mutação e não audita** — e a que fez, audita. `routing-worker` (1×/min) e o extinto `attendant-heartbeat` (1×/5min, removido no #720) auditavam incondicionalmente: ~51.840 linhas/mês numa instalação que não atende ninguém, e numa VPS real **95% do audit log** era batida de cron vazia (`docs/testing/user-journey-map.md`, achado 17). A guarda certa é *auditar quando houve efeito*, nunca *parar de auditar* — as duas direções são medidas por `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`, que varre o AST de **toda** rota de `app/api/v1/cron/`
- Audit é append-only para os papéis do PostgREST, e isso é do SCHEMA e não da prosa: `anon`, `authenticated` e `service_role` não têm GRANT de UPDATE, DELETE **nem TRUNCATE** em `api_audit_log` — **nem `service_role`** (migration 0258). O dono (`postgres`) pode tudo, como em qualquer tabela: a garantia é sobre os papéis que o PostgREST assume, nunca absoluta. Para conferir na fonte em vez de acreditar nesta linha:

  ```bash
  psql "$SUPABASE_DB_URL" -c "select grantee, privilege_type from information_schema.role_table_grants
    where table_schema='public' and table_name='api_audit_log'
      and privilege_type in ('DELETE','UPDATE','TRUNCATE')
      and grantee in ('anon','authenticated','service_role','PUBLIC');"
  ```

  O resultado esperado é **vazio**. Sem o filtro de `grantee` aparecem as linhas
  do dono `postgres` — e elas não são defeito.

  **Até a 0258 a primeira frase deste item era falsa no Supabase real, com o
  gate verde.** Todo projeto Supabase nasce com um default ACL de TABELAS em
  `public` que concede tudo aos três papéis — confira com
  `select defaclacl from pg_default_acl where defaclobjtype = 'r' and defaclnamespace = 'public'::regnamespace;`
  —, e o `GRANT` enumerado que o dump emite para esta tabela só ACRESCENTA, não
  retira. Com a service key, que ignora RLS, uma linha escolhida da auditoria
  era apagada ou reescrita pela REST; `anon`/`authenticated` só não o faziam
  porque a RLS não tem policy de UPDATE/DELETE.

  **A lição que sobrevive ao conserto é sobre a régua, não sobre o grant.** A
  sonda de `tests/invariants/retencao-poda-e-expurgo.test.ts` ficou verde duas
  vezes medindo o universo errado: primeiro perguntando só por DELETE/UPDATE com
  TRUNCATE concedido ao lado; depois perguntando pelos três num Postgres onde o
  prelude de `scripts/test-db.sh` reproduzia o default ACL do Supabase só para
  FUNÇÕES — um banco onde o defeito não podia existir. Desde a issue #887 o
  prelude reproduz também o de TABELAS, e aquela sonda passou a medir o Supabase.
  A prova com controle próprio segue sendo
  `tests/invariants/audit-log-sob-o-default-acl-do-supabase.test.ts`: concede o
  default ACL à tabela, reaplica o bloco da 0258 extraído do baseline e só então
  sonda. **Enumerar privilégios no dump não protege tabela nenhuma no Supabase
  real**; o que protege é `revoke` explícito no apêndice. Quais tabelas o dump
  enumera em vez de `GRANT ALL`:

  ```bash
  grep -nE '^GRANT [A-Z,]+ ON TABLE' supabase/baseline.sql | grep -v 'GRANT ALL'
  ```
- **Retenção default de 5 anos, configurável, e agora EXECUTADA.** O expurgo é `public.fn_expurgar_auditoria_vencida` (`security definer`, **piso de 90 dias dentro do corpo**, revogada de anon/authenticated), chamada em lotes pelo cron `app/api/v1/cron/data-retention` (diário). O knob é `AUDIT_LOG_RETENTION_DAYS`. **Não há camada cold/S3** — o "hot 90 dias, cold (S3) o resto" que este arquivo afirmava por meses nunca existiu em código (auditoria de 2026-08-14: zero ocorrência de arquivamento), e um self-host não tem para onde arquivar: o Storage do cliente é a MESMA cota de 1 GB, já dividida com `whatsapp-media`. Para ver o que está em vigor: `grep -n "RETENCAO_AUDITORIA_DIAS" lib/retencao/politica.ts`
- Por que uma `security definer` de expurgo não é porta de adulteração (o argumento inteiro está no cabeçalho da migration 0167): ela **não tem seletor de linha** — nenhum parâmetro de org, ator, ação ou id, e o único predicado é `created_at < now() - N dias`; o piso mora **no corpo**, não em quem chama; não é alcançável pela REST; é, desde a 0258, o **único** apagamento de auditoria ao alcance da service key — e não escolhe linha, só alcança a ponta mais velha que o piso; e **registra a própria erosão** (`retention.sweep_run`, com a contagem, numa linha nova demais para a chamada seguinte alcançar)
- Falha de write em audit gera alerta Sentry, não bloqueia mutação principal
