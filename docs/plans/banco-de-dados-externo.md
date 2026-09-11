# Plano — Banco de dados externo como fonte de dados do agente

> Checklist vivo. Este documento é a **única fonte de retomada**: se a implantação for
> interrompida, a próxima sessão lê `Status atual` e continua do primeiro `[ ]`.
> Marque `[x]` ao concluir e **atualize o `Status atual`** junto. Não apague decisões
> tomadas — registre a mudança com data.

---

## Status atual

- **Fase:** 1 — Schema (em andamento) · próxima: Fase 2 — Núcleo `lib/external-db/`
- **Última atualização:** 2026-09-11
- **Próximo passo concreto:** `pnpm test:db` (Docker) para aplicar a migration `0233` em install e update; depois regenerar `lib/database.types.ts` (Fase 3, quando houver código).
- **Bloqueios:** nenhum.
- **Branch:** `feat/banco-externo-do-agente` (criada de `main` em 2026-09-11).

---

## Objetivo

O agente de IA que atende no WhatsApp (e o operador na tela) deve poder **consultar, em
tempo real, dados de um banco PostgreSQL externo**, cujo schema muda com frequência —
tabelas, colunas e linhas mudam, então nada pode ser hard-coded. A introspecção é **ao
vivo**. Esse banco externo é também o **ponto de integração com um segundo CRM** do dono,
construído à parte, que vai **escrever** nesse mesmo banco.

### Decisões tomadas (2026-09-11)

| # | Pergunta | Decisão |
|---|---|---|
| D1 | Para que servem os dados | Alimentar a IA que atende no WhatsApp. A IA consulta os dados como ferramenta. |
| D2 | Quem vê os dados | **Todos os autenticados** veem na tela. **Configurar a conexão:** `admin`. A exposição à IA é por allowlist (ver D6). |
| D3 | IA consulta o banco | **Sim**, já nesta fase, como ferramenta MCP do agente. |
| D4 | Pasta `/root/arquivos` | **Descartada como elo entre CRMs.** O contrato é um PostgreSQL/Supabase. Ver seção "Decisão sobre a pasta". |
| D5 | Cifra em repouso | **Reutilizar `AI_CRED_AES_KEY`** (já obrigatória em produção). Sem env var nova. |
| D6 | O que a IA pode ler | **Qualquer tabela da conexão** (confirmado pelo dono em 2026-09-11). Sem allowlist. As travas que ficam: conexão somente-leitura, timeout, limite de linhas e auditoria sem valores. |

### Decisão sobre a pasta `/root/arquivos`

**Não usar.** O outro CRM vai *escrever* e o DeskcommCRM vai *ler*. Pasta compartilhada
exigiria: volume novo no `docker-compose.prod.yml` (toca doutrina de packaging e o
`update.sh`), polling, trava de arquivo, ausência de schema e de transação. Postgres entrega
tudo isso de graça e o repo já fala `pg`. Se a pasta existir para backup/exportação, é
assunto separado e não bloqueia nada aqui.

---

## Arquitetura proposta

```
Outro CRM  ──escreve──►  PostgreSQL externo  ◄──lê──  DeskcommCRM
(Supabase próprio)       (schema dinâmico)            ├── tela /app/integracao-dados (todos)
                                                      └── tool do agente (admin define o quê)
```

- **Introspecção ao vivo** via `information_schema` + `pg_catalog` (`LIMIT`/cursor). Nunca
  gerar `lib/database.types.ts` do banco externo.
- **Somente leitura:** conexão com `default_transaction_read_only=on`, `statement_timeout`,
  `lock_timeout`, `idle_in_transaction_session_timeout`, `application_name`. Só construímos
  `SELECT` parametrizado; identificadores são quotados no servidor a partir do allowlist.
- **Pool por conexão**, memoizado por processo, com `max` baixo e invalidação ao editar/desligar.
- **Segurança:** admin-only na configuração; guard de IP bloqueando link-local/metadata
  (`169.254.0.0/16`) **sempre**; rede privada (RFC1918/loopback) **bloqueada por default**
  com escape explícito para o dono da VPS, se um dia o banco morar na LAN. Não reusar
  `assertDestinoResolvidoSeguro` cru: ele bloqueia toda faixa privada, o que impediria o caso
  "Postgres na mesma VPS".
- **Entrega do schema ao LLM:** pelo resultado da tool `crm_describe_external_data`, **nunca**
  no prefixo estável (`buildStablePrefix`) — o prefixo tem que continuar byte-idêntico para o
  cache (`lib/agent-engine/edge/llm/stable-prefix.ts`). A descrição das tools é prosa estática.

### Tabela nova proposta (rascunho — não aplicada)

`external_db_connections` (tenant-aware, RLS, senha cifrada bytea, padrão de
`ai_provider_credentials`):

```
id                    uuid pk default gen_random_uuid()
organization_id       uuid not null references organizations(id) on delete cascade
label                 text not null
host                  text not null
port                  integer not null default 5432
database_name         text not null
username              text not null
password_encrypted    bytea not null
password_iv           bytea not null
password_tag          bytea not null
ssl_mode              text not null default 'require'
                        check (ssl_mode in ('disable','prefer','require','verify-ca','verify-full'))
enabled               boolean not null default true
last_tested_at        timestamptz
last_test_ok          boolean
last_test_error       text
created_by            uuid references auth.users(id)
created_at            timestamptz not null default now()
updated_at            timestamptz not null default now()
unique (organization_id, label)
```

- RLS `tenant_isolation_external_db_connections_all` via `fn_user_org_ids()`.
- View `external_db_connections_safe` **sem** as colunas cifradas; UI e API leem dela.
- Sem função nova em `public` (se surgir, aplicar a regra 9 da doutrina de migrations).

### Ponto de extensão do agente (CONFIRMADO por código)

Sistema de tools = **catálogo MCP**. Caminho canônico:

- Handler: novo `lib/mcp/tools/dados-externos.ts` (contrato `McpToolDefinition` em
  `lib/mcp/types.ts`; modelo em `lib/mcp/tools/leads.ts`).
- Catálogo estático: novo `lib/mcp/tools/catalogo/dados-externos.ts` (`declararTools`, modelo
  em `lib/mcp/tools/catalogo/comercio.ts`).
- Registrar em `lib/mcp/tools/catalogo/index.ts` e `lib/mcp/tools/index.ts`.
- Marcar como leitura em **dois** lugares hard-coded:
  `lib/agent-engine/agent/tool-breaker.ts` (`READ_ONLY_TOOLS`) e
  `lib/atendimento/fronteira-server.ts` (`guardServiceTools` → conjunto `reads`).
- Org vem de `ctx.organizationId` (fonte confiável), **nunca** do input da tool.
- Auditoria do tool chamado já é automática (`lib/ai/runtime/tools.ts`) — garantir que o
  metadata **não** carregue valores/filtros (PII).

---

## Checklist

### Fase 0 — Decisões ✅ (2026-09-11)

- [x] Escopo: dados para a IA (D1)
- [x] Papel de configuração: `admin` (D2)
- [x] IA consulta: sim (D3)
- [x] Pasta `/root/arquivos` descartada (D4)
- [x] Cifra: reusar `AI_CRED_AES_KEY` (D5)
- [x] D6: IA lê qualquer tabela da conexão (sem allowlist) — confirmado 2026-09-11

### Fase 1 — Schema (tripla)

- [x] `git fetch origin && git merge --ff-only origin/main` + branch `feat/banco-externo-do-agente`
- [x] Migration `supabase/migrations/20260911140000_0233_banco_externo_do_agente.sql`
- [x] Apêndice idempotente no fim de `supabase/baseline.sql`, rotulado `-- ---- ... (migration 0233) ----`
- [x] Linha na tabela "Applied" de `supabase/migrations/MANIFEST.md`
- [x] View `external_db_connections_safe` + `revoke`/`grant` de anon/authenticated
- [x] Invariante RLS 2-org em `tests/invariants/banco-externo-rls.test.ts`
- [ ] Regenerar `lib/database.types.ts` do schema (depende de DB; adiado para a Fase 3, quando houver código que use a tabela)
- [x] `baseline.sql` aplica em install **e** update com `ON_ERROR_STOP=1` (validado via Docker `pgvector/pgvector:pg15`, 2026-09-11)
- [x] Asserções do invariante verificadas à mão contra pg15 (isolamento, view sem cifra, privilégios) — 2026-09-11
- [ ] `pnpm test:db` completo + `typecheck`/`lint` rodados no CI (o host desta sessão não tem Node/pnpm; o app roda em Docker)

### Fase 2 — Núcleo `lib/external-db/`

- [ ] `credenciais.ts` — cifra via `lib/crypto/aes_gcm.ts`; leitura **sempre** com `organization_id`
- [ ] `guardas.ts` — resolve DNS/IP; bloqueia `169.254.0.0/16` e faixas especiais; política p/ privado (default fecha)
- [ ] `conexao.ts` — pool read-only com timeouts; teto de pools; invalidação por `updated_at`; `end()` ao remover
- [ ] `introspeccao.ts` — schemas/tabelas/colunas/PK/estimativa de linhas via `information_schema`+`pg_catalog`
- [ ] `leitura.ts` — `SELECT` montado no servidor: identificadores quotados do allowlist, valores parametrizados, cursor + `LIMIT`
- [ ] Testes unit: guarda de IP, builder de query (injeção por nome de tabela/coluna), cifra, introspecção

### Fase 3 — API `/api/v1/external-db/`

- [ ] `GET/POST  connections` (lista: manager+; criação: admin)
- [ ] `GET/PATCH/DELETE connections/[id]` (admin)
- [ ] `POST connections/[id]/test` (admin) — testa conexão e grava `last_test_*`
- [ ] `GET  connections/[id]/schemas` — tabelas/colunas (autenticado)
- [ ] `GET  connections/[id]/tables/[schema]/[tabela]` — dados paginados (autenticado)
- [ ] Zod em todo input; `ok()`/`fail()`; `audit()` em toda mutação; rate limit
- [ ] Confirmar D6 e implementar a allowlist de exposição à IA

### Fase 4 — Tela

- [ ] Entrada em `lib/navigation/catalogo.ts` (grupo + `section` + `minRole` + `sidebar`)
- [ ] `app/app/integracao-dados/page.tsx` — lista de conexões + formulário (admin)
- [ ] `app/app/integracao-dados/[id]/page.tsx` — árvore de tabelas + schema + grade de dados
- [ ] Estados vazio/erro/loading; senha **nunca** exibida após salva
- [ ] Rodar `tests/e2e/navegacao.spec.ts` — item novo pode estourar a dobra do sidebar

### Fase 5 — Tool do agente (D3)

- [ ] `lib/mcp/tools/dados-externos.ts` — `crm_describe_external_data` (read)
- [ ] `lib/mcp/tools/dados-externos.ts` — `crm_query_external_data` (read, parametrizada, limite)
- [ ] `lib/mcp/tools/catalogo/dados-externos.ts` + registro nos dois índices
- [ ] Adicionar os nomes a `READ_ONLY_TOOLS` e ao `reads` de `guardServiceTools`
- [ ] Limite de linhas/bytes devolvidos ao modelo (orçamento de token) + tratamento de dado não confiável (anti prompt-injection)
- [ ] Auditoria sem PII (sem valores de filtro); `organizationId` sempre de `ctx`
- [ ] E2E/unit provando que a tool recusa tabela fora do allowlist e que a query é read-only

### Fase 6 — Verificação e distribuição

- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm test:unit`
- [ ] `pnpm test:db` (RLS) · `pnpm test:e2e` (tela + navegação)
- [ ] `pnpm gov:verify`
- [ ] Fragmento em `.changes/` (`capacidade_nova` ou `exige_acao`), conferido com `pnpm release:conferir`
- [ ] Doc em `docs/specs/` + atualizar `AGENTS.md`/`CLAUDE.md` se criar env var ou padrão novo
- [ ] Registrar na memória viva (`docs/architecture/`) com ≥2 arestas (Living System Checklist)

### Fora de escopo (backlog)

- [ ] Sincronizar/importar tabelas externas para entidades do CRM (épico separado)
- [ ] Console SQL livre pelo operador (risco alto; só com read-only + allowlist + timeout)
- [ ] Escrita no banco externo pelo DeskcommCRM
- [ ] Uso da pasta `/root/arquivos` para exportação/backup

---

## Riscos e cuidados (não esquecer)

1. **SSRF/TCP:** `pg` não passa pelo `lib/agent-engine/edge/egress.ts` (só HTTP). Precisa guard próprio.
2. **Read-only de verdade:** `default_transaction_read_only=on` + só `SELECT`; usuário de banco recomendado como read-only no lado externo.
3. **Pool:** fechar ao editar/remover; teto global; `idleTimeout`. Processos `app` e `worker` são separados — o cache de pool existe em cada um.
4. **Rede do container:** Supabase/Postgres público sai por egress normal. Banco na mesma VPS exige host alcançável pelo container (IP público, `host.docker.internal` ou a própria rede).
5. **LGPD:** dado externo pode ter PII; allowlist, limite de linhas e auditoria sem valores são a barreira.
6. **Prompt cache:** schema dinâmico nunca no prefixo estável.
7. **Tripla:** sem apêndice no `baseline.sql`, a feature não chega em quem instalou.
