# Plano — Banco de dados externo como fonte de dados do agente

> Checklist vivo. Este documento é a **única fonte de retomada**: se a implantação for
> interrompida, a próxima sessão lê `Status atual` e continua do primeiro `[ ]`.
> Marque `[x]` ao concluir e **atualize o `Status atual`** junto. Não apague decisões
> tomadas — registre a mudança com data.

---

## Status atual

- **Fase:** **ENTREGUE E EM PRODUÇÃO.** Feature mergeada (`f62d4663`), rebrand de namespace (`f446379`) e release **1.19.0** cortada/tagueada (`baec3923`). A VPS roda `app`/`worker`/`scheduler` em `ghcr.io/vgamkt/…:1.19.0`, **saudáveis**.
- **Última atualização:** 2026-09-12.
- **Próximo passo concreto:** obter um token do Supabase (`sbp_…`) e rodar `bash hostgator-setup-kit/marca-emails.sh --projeto /root/DeskcommCRM` para ajustar **Site URL** = `https://app.vgasistemas.app` e a lista de URLs permitidas (e os moldes de e-mail). Sem token não dá para ler nem ajustar — o Supabase é na nuvem e o endpoint público não devolve `site_url`.
- **Bloqueios:** nenhum de código. Dívida declarada: `lib/database.types.ts` não regenerado (clients untyped; o arquivo já estava desatualizado além desta feature).
- **Histórico:** `feat/banco-externo-do-agente` (10 commits, `73a274ef` → `a46b330c`; merge `f62d4663`); rebrand `chore/namespace-do-fork` (PR #2, `6c46626d`; merge `f446379`); release PR #3 (`a42172af`; merge `baec3923`; tag `v1.19.0`). Diário completo em `/root/arquivos/deskcomm-banco-externo.md`.

### Resolvido (2026-09-11) — pacote das tools

`8f145f18` colocou as duas tools do banco externo em `atender` (e `vender`/`reter`), elevando "Atender" de 18 para 20 e reprovando o `e2e`: a jornada de teto pressupõe 18 (`8 + 18 = 26 > 25` → faltam 1; desligar uma do seed deixa `7 + 18 = 25`, exato). Com 20 vira `28` (faltam 3) e o teste libera só 1 vaga.

**Correção `3864c756`:** as duas tools são de **fonte de dados**, não de conversa, e passam a pertencer **só a `organizar`**. "Atender" volta a 18 e a jornada do teste volta a valer. Arquivos: `lib/mcp/tools/catalogo/dados-externos.ts` e `tests/e2e/capacidades-do-agente.spec.ts`. CI verde.

### Deploy em produção (2026-09-12)

- PRs: #1 (feature) → `f62d4663`; #2 (rebrand do namespace das imagens para o fork) → `f446379`; #3 (release 1.19.0) → `baec3923`; tag **`v1.19.0`**.
- Imagens publicadas e **públicas** em `ghcr.io/vgamkt/{deskcommcrm,deskcomm-worker,deskcomm-scheduler}:{1.19.0,stable}`.
- Deploy pela VPS com `bash hostgator-setup-kit/update.sh` (alvo `v1.19.0`): backup automático, `baseline.sql` reaplicado (migration 0233), o próprio script **reescreveu as três `*_IMAGE`** do `.env` para o fork, `pull` + `up -d` + Caddy recriado. Verificação: os três contêineres em 1.19.0 **healthy**, `/api/v1/health` = 200, `/app/integracao-dados` = 307 (login).
- **Corte manual:** o fork não tem o GitHub App do workflow `release` (`RELEASE_APP_ID`/`RELEASE_APP_PRIVATE_KEY`), então `release:cortar` rodou local → PR #3 → merge → tag criada via API → `publish-image` publicou. Para futuras releases, configurar o App (ou repetir o manual).
- Correção de conteúdo antes do corte: o fragmento citava a seção antiga "Dados e acesso"; ajustado para **"Fontes de dados"**.

### Configuração pela tela (front end)

Não é preciso editar `.env` para conectar o banco. Caminho: **Organização › Fontes de dados › Dados externos** (`/app/integracao-dados`).

- **Quem vê:** todos os autenticados. **Quem cria/edita/testa:** `admin` (D2).
- **Campos** (`app/app/integracao-dados/_components/FormularioDeConexao.tsx`): `label` (Nome da conexão), `host`, `port` (padrão 5432), `database_name` (Banco de dados), `username` (Usuário), `password` (Senha), `ssl_mode` (Segurança — `require` padrão, `verify-full`, `verify-ca`, `prefer`, `disable`) e `enabled` (Conexão ativa).
- A senha é cifrada (AES-GCM) e **nunca** volta à tela; ao editar, deixá-la em branco mantém a guardada.
- **Testar** valida o acesso e grava `last_test_*`; o explorador (`[id]/page.tsx`) mostra a árvore de tabelas e a grade paginada.
- Contrato de entrada em `lib/external-db/schemas.ts` — a tela e a API usam o mesmo vocabulário.

### Pendência ativa — Site URL do Supabase (2026-09-12)

O Supabase é **na nuvem** (`nsvmksypszelwxefgluw.supabase.co`). O endpoint público não devolve `site_url`; para ler/ajustar é preciso um token `sbp_…` (Management API) ou o painel. O app manda o link para `https://app.vgasistemas.app/auth/confirm`, que precisa estar na lista de URLs permitidas — senão o Supabase cai no Site URL (possivelmente `http://localhost:3000`, quebrando "esqueci a senha"). **Ação:** rodar `bash hostgator-setup-kit/marca-emails.sh --projeto /root/DeskcommCRM` com `SUPABASE_ACCESS_TOKEN=sbp_…`.

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
- [ ] Regenerar `lib/database.types.ts` do schema (pendente — ver o item equivalente no fim da Fase 3: dívida declarada, clients untyped)
- [x] `baseline.sql` aplica em install **e** update com `ON_ERROR_STOP=1` (validado via Docker `pgvector/pgvector:pg15`, 2026-09-11)
- [x] Asserções do invariante verificadas à mão contra pg15 (isolamento, view sem cifra, privilégios) — 2026-09-11
- [ ] `pnpm test:db` completo + `typecheck`/`lint` rodados no CI (o host desta sessão não tem Node/pnpm; o app roda em Docker)

### Fase 2 — Núcleo `lib/external-db/`

- [x] `credenciais.ts` — cifra via `lib/crypto/aes_gcm.ts`; leitura **sempre** com `organization_id`
- [x] `guardas.ts` — resolve DNS/IP; bloqueia `169.254.0.0/16` e faixas especiais; política p/ privado (RFC1918 permitido — LAN é caso real)
- [x] `conexao.ts` — pool read-only com timeouts; teto de pools; invalidação por `updated_at`; `end()` ao remover
- [x] `introspeccao.ts` — schemas/tabelas/colunas/estimativa de linhas via `information_schema`+`pg_catalog` (PK ainda não)
- [x] `leitura.ts` — `SELECT` montado no servidor: identificadores quotados do catálogo, valores parametrizados, `LIMIT`/`OFFSET`
- [x] Testes unit: guarda de IP (inclui IPv6 normalizado), builder de query (injeção por identificador), cifra, pool, introspecção — 65 verdes via Docker, `tsc`/`eslint` zerados

### Fase 3 — API `/api/v1/external-db/`

- [x] `GET/POST  connections` (lista: autenticado — D2; criação: admin)
- [x] `GET/PATCH/DELETE connections/[id]` (leitura: autenticado; PATCH/DELETE: admin)
- [x] `POST connections/[id]/test` (admin) — testa conexão e grava `last_test_*` (200 mesmo em falha do teste)
- [x] `GET  connections/[id]/schemas` — tabelas/colunas/PK/estimativa (autenticado)
- [x] `GET  connections/[id]/tables/[schema]/[tabela]` — dados paginados (autenticado; sem filtro na querystring)
- [x] Zod em todo input; `ok()`/`fail()`; `audit()` em mutação E em leitura (metadata sem PII); rate limit por org
- [x] D6 confirmada (2026-09-11): **sem allowlist por tabela**. As travas que ficam: conexão somente-leitura, timeout, teto de linhas e auditoria sem valores
- [ ] `lib/database.types.ts` — regenerar do schema (dívida: o arquivo já está desatualizado além desta feature; os clients em uso são untyped, então nada quebra. Regenerar quando houver caminho tipado)

### Fase 4 — Tela

- [x] Entrada em `lib/navigation/catalogo.ts` — grupo `organizacao`, section **`Fontes de dados`** (corrigido em `8f145f18`: era `Dados e acesso`, seção admin-only que some para `viewer` e não pode reaparecer para quem não administra; a tela é de todos — D2), `icon: PlugsConnected`, sem `minRole`. **SEM `sidebar`**: tarefa de uma vez, fica no hub (mesma decisão de Marca — o menu já estourou a dobra antes)
- [x] `app/app/integracao-dados/page.tsx` — lista de conexões + formulário (admin); leitura pela sessão (RLS), não service role
- [x] `app/app/integracao-dados/[id]/page.tsx` — árvore de tabelas por schema + grade paginada, com ordenação por coluna e marcação de PK
- [x] Estados vazio/erro/loading; senha **nunca** exibida após salva (o formulário nasce vazio no campo de senha)
- [ ] Rodar `tests/e2e/navegacao.spec.ts` — não rodou neste host (sem app/DB); o item NÃO entrou no sidebar, então não muda a dobra. Rodar no CI

### Fase 5 — Tool do agente (D3)

- [x] `lib/mcp/tools/dados-externos.ts` — `crm_describe_external_data` (read)
- [x] `lib/mcp/tools/dados-externos.ts` — `crm_query_external_data` (read, parametrizada, limite)
- [x] `lib/mcp/tools/catalogo/dados-externos.ts` + registro nos dois índices (`catalogo/index.ts` e `tools/index.ts`)
- [x] Adicionar os nomes a `READ_ONLY_TOOLS` e ao `reads` de `guardServiceTools`
- [x] Limite de linhas/bytes devolvidos ao modelo (teto de bytes na página) + aviso anti prompt-injection
- [x] Auditoria sem PII: `McpToolDefinition.redigirParaAuditoria` tira os valores de filtro do `api_audit_log`; `organizationId` sempre de `ctx`
- [x] Unit provando que a tool recusa tabela inexistente e que a leitura passa por `BEGIN READ ONLY` (núcleo `consultar`, coberto em `introspeccao.test.ts`). Sem allowlist (D6)
- [x] Pacote das tools: `8f145f18` as pôs em `atender`/`vender`/`reter`; `3864c756` corrigiu para **só `organizar`** (são capacidades de fonte de dados). "Atender" volta a 18 (17 automáticas + 1 crítica): `8 + 18 = 26 > 25` → faltam 1; `7 + 18 = 25` aplica

### Fase 6 — Verificação e distribuição

- [x] CI do PR #1, head `3864c756`: **todos os checks verdes** — `verify`, `invariants`, `build-and-size`, `imagens-ok` (+ 3 imagens), `e2e` (as 3 partes) e `publish-image` (build-only). Rodadas anteriores (`42e99715`, `7e8e2bbf`) corrigidas por `7e8e2bbf` (typecheck/RLS/RBAC), `8f145f18` (marca/i18n/nav/tailwind/e2e) e `3864c756` (pacote das tools)
- [x] `tsc --noEmit` e `eslint` zerados (via Docker); `lint:channels` e `lint:role-rank` ok
- [x] Subconjunto unitário relevante verde (310 testes: external-db, tools, catálogo, pacotes, navegação, mapas, service-boundary). A suíte `test:unit` INTEIRA não terminou dentro do tempo deste host (sem Node) — vai no CI
- [x] `pnpm test:db` (RLS) e `pnpm test:e2e` (tela + navegação) — não rodam no host (sem app/DB), mas rodaram **verdes no CI** (`invariants` e `e2e`, head `3864c756`)
- [ ] `pnpm gov:verify` completo — não rodou ponta a ponta pela mesma razão; as partes rodadas estão verdes
- [x] Fragmento em `.changes/dados-externos-do-agente.md` (`capacidade_nova`/`adicionado`), conferido com `release:conferir` (exit 0)
- [x] Doc em `docs/specs/18-spec-banco-de-dados-externo.md`. Sem env var nova; o padrão novo (`redigirParaAuditoria`) está documentado no `lib/mcp/types.ts` e na spec
- [x] Memória viva: `docs/architecture/banco-de-dados-externo.architecture.json` (17 peças, 28 arestas) + linha no README; gate `mapas-de-arquitetura` verde
- [x] Rebrand do namespace das imagens para o fork (`chore/namespace-do-fork`, PR #2) e release **1.19.0** publicada (tag `v1.19.0`; imagens `ghcr.io/vgamkt/...` públicas)
- [x] **Deploy em produção:** VPS com `app`/`worker`/`scheduler` em `ghcr.io/vgamkt/...:1.19.0`, healthy (2026-09-12)

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
