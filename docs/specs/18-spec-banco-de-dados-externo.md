# Spec 18 — Banco de dados externo do agente

Status: **entregue** (2026-09-11). Branch `feat/banco-externo-do-agente`.
Plano de execução e diário: `docs/plans/banco-de-dados-externo.md` e
`/root/arquivos/deskcomm-banco-externo.md`. Mapa vivo:
`docs/architecture/banco-de-dados-externo.architecture.json`.

## Objetivo

O agente que atende no WhatsApp (e o operador na tela) consulta, em tempo real,
dados de um **PostgreSQL externo** — o segundo CRM/ERP do dono, que outro sistema
escreve. O schema muda com frequência, então a introspecção é **ao vivo**: nada
hard-coded, nada de espelhar schema.

## Decisões (CONFIRMADO por código)

| # | Tema | Decisão |
|---|---|---|
| D1 | Uso dos dados | Alimentar a IA que atende; a IA consulta como ferramenta. |
| D2 | Quem vê | TODO autenticado vê a lista e lê dados. Configurar (criar/editar/apagar) é `admin`. |
| D3 | IA consulta | Sim, via tools MCP. |
| D4 | Pasta `/root/arquivos` | Só registro. O elo é um PostgreSQL, não a pasta. |
| D5 | Cifra | Reusa `AI_CRED_AES_KEY` (AES-256-GCM). Sem env var nova. |
| D6 | Escopo da IA | **Qualquer tabela da conexão, sem allowlist.** Travas: somente-leitura, timeout, teto de linhas, auditoria sem valores. |

## Superfície

### Schema

`external_db_connections` (migration 0233): tenant-aware, RLS por organização,
senha em três colunas `bytea` cifradas com AES-GCM. View
`external_db_connections_safe` sem as colunas cifradas (é o que a tela lê).
Tripla completa: migration + apêndice idempotente no `baseline.sql` + `MANIFEST.md`.

### Núcleo `lib/external-db/`

- `guardas.ts` — decisão de destino. **Deliberadamente diferente** do guard de
  webhook: RFC1918 é permitido (Postgres na LAN é caso real); link-local/metadata
  (`169.254.0.0/16`), loopback, CGNAT, multicast e reservadas sempre bloqueados.
  IPv6 é normalizado para 16 bytes antes de classificar (as grafias equivalentes
  de loopback não escapam).
- `conexao.ts` — pool por conexão, invalidado pelo `updated_at`; teto de pools;
  `BEGIN READ ONLY` + `statement_timeout`/`lock_timeout` por transação.
- `introspeccao.ts` — catálogo ao vivo (`information_schema` + `pg_catalog`),
  incluindo chave primária (simples e composta) e estimativa de linhas.
- `leitura.ts` — SELECT montado no servidor: identificadores quotados e validados
  contra o catálogo, valores parametrizados, vocabulário fechado de operadores,
  teto de linhas.
- `credenciais.ts` — leitura **sempre** com `organization_id`; cifra just-in-time.
- `acesso.ts` — carrega a conexão e **revalida o destino antes de abrir o pool**.

### API `/api/v1/external-db/`

| Método | Rota | Papel | Nota |
|---|---|---|---|
| GET | `connections` | autenticado | lê a `_safe` view |
| POST | `connections` | admin | valida o host antes de gravar |
| GET | `connections/[id]` | autenticado | |
| PATCH | `connections/[id]` | admin | `password` ausente preserva a guardada |
| DELETE | `connections/[id]` | admin | fecha o pool em memória |
| POST | `connections/[id]/test` | admin | grava `last_test_*`; 200 mesmo em falha |
| GET | `connections/[id]/schemas` | autenticado | catálogo |
| GET | `connections/[id]/tables/[schema]/[tabela]` | autenticado | paginado; sem filtro na querystring |

Zod num só lugar (`lib/external-db/schemas.ts`); `ok()`/`fail()`; rate limit por
organização; `audit()` em mutação **e** em leitura (metadata sem PII).

### Tela `/app/integracao-dados`

Lista (todos) + cadastro/edição (admin) + explorador (árvore por schema e grade
paginada). A senha nunca é exibida após salva. Entrada de navegação em
Organização › Dados e acesso.

### Tools do agente

- `crm_describe_external_data` (`read`) — catálogo para o modelo escolher a tabela.
- `crm_query_external_data` (`read`) — leitura com filtros, ordem e limite.

O `McpToolDefinition.redigirParaAuditoria` remove os valores de filtro do
`api_audit_log` nos dois ingressos. O resultado carrega aviso fixo
anti prompt-injection e teto de bytes.

## Segurança

1. **SSRF/TCP:** o `pg` não passa pelo egress HTTP; a guarda de `guardas.ts` é a
   barreira, reavaliada a cada abertura de pool. A janela de DNS-rebinding entre a
   checagem e o connect permanece declarada (a mesma dívida de `outbound-ip.ts`).
2. **Somente leitura de verdade:** imposta pelo Postgres (`BEGIN READ ONLY`), não
   por análise de string.
3. **LGPD:** o dado externo pode ter PII. PII não vai para log de auditoria; a
   querystring de leitura não carrega valores de filtro.
4. **Prompt injection:** o conteúdo externo é entrada não confiável e o modelo é
   instruído a tratá-lo como dado.

## Fora de escopo (backlog)

- Sincronizar/importar tabelas externas para entidades do CRM.
- Console SQL livre pelo operador.
- Escrita no banco externo pelo DeskcommCRM.
