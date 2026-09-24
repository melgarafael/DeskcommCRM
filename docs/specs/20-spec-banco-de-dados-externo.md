# Spec 20 — Banco de dados externo

Autoria: **@vgamkt**, escrita para o PR #1130. Chegou à `main` em dois recortes:
o núcleo, a API e a tela primeiro (#1372); as **tools do agente** depois (ver a
seção própria abaixo). Mapa vivo:
`docs/architecture/banco-de-dados-externo.architecture.json`.

Numerada `18` na origem; `18` e `19` já eram de outras specs na `main`.

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

`external_db_connections` (migrations 0372 e 0373): tenant-aware, RLS por organização,
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

O segundo recorte do #1130. O agente que atende no WhatsApp lê o banco externo
por duas tools MCP (`lib/mcp/tools/dados-externos.ts`):

- `crm_describe_external_data` (`read`) — catálogo ao vivo para o modelo
  escolher a tabela e os campos.
- `crm_query_external_data` (`read`) — leitura com filtros, ordem e limite,
  presa aos tetos DA CONEXÃO (`max_rows`, `max_filters`, `max_response_bytes`,
  migration 0373), nunca ao que o modelo pede.

Sem `connection_id`, as duas usam a única conexão ativa; com várias, pedem para o
modelo escolher em vez de adivinhar. Toda resposta leva um aviso fixo dizendo
que o conteúdo é dado de outro sistema, nunca instrução.

**Desligadas por padrão.** As duas entram no pacote "Organizar a operação", mas
um agente só as usa se o dono ligá-las na tela do agente — a lista de
capacidades é gravada por agente, e nenhum agente existente ganha as duas sozinho.
Sem conexão cadastrada, respondem `sem_conexao` sem abrir rede.

**PII fora do audit.** `McpToolDefinition.redigirParaAuditoria` tira os VALORES
de filtro dos args antes de `api_audit_log`, nos dois ingressos (turno do agente
em `lib/ai/runtime/tools.ts` e `/api/mcp` em `lib/mcp/server.ts`). Prova:
`tests/unit/valor-de-filtro-nao-vai-ao-audit.test.ts`, que roda a tool real pelos
dois caminhos.

**Erro não é sucesso (#484).** A tool devolve o erro como texto para o modelo;
`motivoDoVazio` faz o audit gravar `success: false` com o código (`acesso_negado`,
`tabela_nao_encontrada`, `nenhuma_linha`…), para o painel de capacidades não
dizer "nenhuma falha" com o host bloqueado.

**Filtro sem resultado devolve vazio.** A versão do PR reexecutava a consulta sem
o filtro e entregava até 100 linhas para o modelo oferecer "as mais próximas"
(pensado num catálogo de produtos). Numa tabela de clientes, o CPF que não casa
entregaria os registros de outras pessoas. No recorte, o vazio fica vazio e a
resposta ensina o modelo a repetir com um trecho menor do termo.

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
