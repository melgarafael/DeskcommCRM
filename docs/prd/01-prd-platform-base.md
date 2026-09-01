---
title: Sub-PRD 01 — Plataforma Base
parent: 00-prd-master.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
---

# Sub-PRD 01 — Plataforma Base

> Foundation do SonghaiCRM. Todo subsistema posterior (Customer 360, WhatsApp, Pipeline, IA, Nuvemshop) depende das capacidades aqui definidas. Profundidade técnica (schema, RLS policies, payloads de API) vai pra `docs/specs/` na próxima fase.

---

## 1. Contexto & Posicionamento

A Plataforma Base resolve o **problema fundacional**: todo dado tocado pelo SonghaiCRM precisa estar autenticado, isolado por tenant, autorizado por role, auditado por mutação, e respeitar LGPD desde o primeiro request. Sem isso, qualquer feature em cima vira risco regulatório e operacional.

No modo BPO atual, a Plataforma Base também sustenta a **operação cross-tenant** da empresa operadora (super-admin que cruza tenants). No modo SaaS futuro, é o que permite cada lojista operar seu próprio tenant sem reescrita.

Esta camada **é invisível pro cliente final** mas governa todas as garantias de segurança, conformidade e operação multi-tenant do produto.

---

## 2. Escopo

### Dentro do escopo deste sub-PRD

1. Autenticação de usuários (humanos via UI, server-to-server via API)
2. Modelo de tenancy (organizations, user_organizations, super-admin)
3. RBAC com 4 roles canônicas + super-admin de plataforma
4. Audit trail de toda mutação relevante
5. Framework LGPD (consentimento, redact, data_request)
6. Onboarding de tenant (mesmo que ainda não exposto publicamente)
7. Convenções da API REST `/api/v1/` (auth, idempotência, paginação, formato de erro, rate limit)

### Fora do escopo deste sub-PRD (vão pra outros sub-PRDs)

- Modelagem de cliente final / contatos / pedidos → Sub-PRD 02
- Captura/envio de mensagens WhatsApp → Sub-PRD 03
- Pipeline e tickets → Sub-PRD 04
- IA, RAG, sentiment → Sub-PRD 05
- Webhooks Nuvemshop → Sub-PRD 06

---

## 3. Capacidades Funcionais

### 3.1 Autenticação

**O que provê.** Login humano via Supabase Auth (email + senha + opcionalmente magic link); auth server-to-server via Bearer token (`Authorization: Bearer tok_...`); MFA TOTP forçado pra role `admin` e super-admin.

**Princípios.**
- Sempre `getUser()` (valida JWT no backend), nunca `getSession()` (confia no cookie local)
- API key NUNCA aceita em query string (vaza em logs de Vercel/CloudFlare)
- Plaintext de Bearer token mostrado **uma vez** na criação; depois apenas hash SHA256 no DB
- Session timeout de 1h com refresh rotation habilitado
- Cookie SameSite=Strict, HttpOnly, Secure em produção

**ACs principais.**
- Login com email/senha bem-sucedido devolve JWT com claim `tenant_id`
- Tentativa de uso de token revogado retorna 401 com `error.code='token_revoked'`
- Admin sem MFA é forçado a configurar TOTP no primeiro login
- API key passada em query string retorna 400 com `error.code='auth_in_query_forbidden'`

### 3.2 Tenancy multi-tenant

**O que provê.** Isolamento de dados forte por tenant via Postgres Row-Level Security em **toda tabela tenant-aware**. Helper canônico `fn_user_org_ids()` retorna lista de orgs do usuário; policies usam essa função pra filtrar.

**Princípios.**
- `organization_id uuid not null references organizations(id) on delete cascade` em toda tabela tenant-aware
- Policy padrão `tenant_isolation_<tabela>_all` aplicada a todas
- Service role bypassa RLS apenas em handlers de webhook e cron, e **deve filtrar manualmente** `organization_id` resolvido de fonte confiável (cookie, JWT, webhook secret, path token) — nunca do body
- Roteamento de API pode usar header `X-Tenant-ID` ou subdomain (`<tenant>.api.deskcomm.com`); decisão final na Spec

**ACs principais.**
- Cliente A não consegue ler nenhum recurso do cliente B em nenhum endpoint
- Tentativa de inserir registro com `organization_id` diferente do JWT do usuário retorna 403
- Teste automatizado de isolamento (cria 2 tenants + verifica não-vazamento) passa no CI antes de qualquer merge
- Query do admin client com `bypassed_rls=true` é logada no audit trail

### 3.3 RBAC

**O que provê.** 4 roles canônicas hierarquicas dentro de cada tenant.

| Role | Hierarchy | Permissões |
|---|---|---|
| `viewer` | 1 | GET em todos os recursos do tenant |
| `agent` | 2 | + POST/PATCH em leads e activities atribuídos a si; sem DELETE |
| `manager` | 3 | + DELETE leads; CRUD em pipelines e stages |
| `admin` | 4 | Tudo, incluindo gestão de api_tokens, webhooks e visualização de audit log |

**Princípios.**
- Roles vivem em `user_organizations` (junção user × org × role)
- 1 usuário pode ter roles diferentes em orgs diferentes
- Permissão por pipeline (`user_pipeline_access`) **NÃO entra no MVP** — adicionar quando cliente real pedir
- Role mudança é evento auditado

**ACs principais.**
- Viewer não consegue criar lead (403 `forbidden_role`)
- Agent só consegue editar leads atribuídos a si (`owner_user_id = self`)
- Audit trail registra mudança de role com `who/from/to/when`

### 3.4 Super-admin de plataforma

**O que provê.** Role especial que atravessa tenants, exclusiva da empresa operadora (modo BPO). No modo SaaS futuro, continua existindo mas restrita à equipe SonghaiCRM como suporte.

**Princípios.**
- Marcação via coluna `is_platform_admin boolean not null default false` em `auth.users` ou tabela auxiliar `platform_admins` (decisão na Spec)
- Helper RLS retorna TRUE pra essa role em qualquer policy de qualquer tabela
- UI separada (subdomain `admin.deskcomm.com`) com listagem de tenants + busca + caixa de entrada unificada cross-tenant
- Toda ação de super-admin é logada com flag `as_platform_admin=true`
- MFA TOTP **obrigatório** sem exceção
- Super-admin **NÃO pode** se adicionar ou remover via API; mudanças de status passam por processo manual de DBA + audit

**ACs principais.**
- Super-admin loga e vê dropdown com lista de todos os tenants
- Super-admin abre conversa do tenant X e a interação é registrada com `acting_as_platform_admin=true`
- Tentativa de criar/remover platform_admin via API retorna 403
- Super-admin sem MFA não consegue completar login

### 3.5 Audit trail

**O que provê.** Log denso de toda mutação relevante (CRUD em leads, pipelines, contacts, mensagens, configurações, tokens, webhooks). Imutável após inserção. Visível pra `admin` do tenant e super-admin de plataforma.

**Princípios.**
- Tabela `api_audit_log` registra: `who` (user_id, api_token_id, ip, user_agent), `what` (action canônica `lead.created`, `token.revoked`, etc.), `which` (resource_type, resource_id), `when` (created_at), `metadata` (diff, params relevantes)
- Logging é fire-and-forget (nunca bloqueia request)
- GET não-batch não é logado por padrão (volume); GET de export massivo SIM
- Retenção 5 anos (boas práticas ANPD)
- Audit log NÃO recebe RLS policy de UPDATE/DELETE — é append-only

**ACs principais.**
- Toda mutação POST/PATCH/DELETE bem-sucedida gera 1 entrada de audit em ≤500ms p99
- Audit log não pode ser editado nem deletado via API (só via DBA manual com double-confirmation)
- Admin do tenant consulta audit log filtrável por `actor`, `action`, `resource_type`, `date_range` em endpoint dedicado
- Falha em escrever audit log gera alerta operacional (Sentry/PagerDuty), mas não impede a mutação principal

### 3.6 LGPD framework

**O que provê.** Mecanismos pro tenant (e pra ANPD em última instância) exercerem direitos LGPD: consentimento granular, exportação de dados pessoais, anonimização ou exclusão.

**Princípios.**
- **Consentimento granular**: `contacts.consent` jsonb com chaves `marketing`, `transactional`, `profiling`, cada uma com `{granted_at, source, version}`
- **Anonimização preferida sobre delete**: vendas históricas precisam permanecer pro faturamento; nome/telefone/email do contato vira hash + token "Cliente Anonimizado #N"
- **Delete físico** apenas quando solicitado e sem dependências (raro: pré-venda sem nenhum pedido)
- **Audit completo** de toda operação em dados sensíveis (`lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.redact_executed`, `lgpd.consent_changed`)
- **SLA**: data_request entregue em D+7 dias úteis; redact executado em D+15
- **Imutabilidade**: dados anonimizados não podem ser revertidos (decisão definitiva)

**Endpoints (detalhe vai na Spec):**
- `POST /api/v1/lgpd/data-request` — recebe `{contact_id | email | phone | cpf}`, dispara job assíncrono que gera export estruturado (JSON + PDF assinado) e o entrega via email ou link assinado
- `POST /api/v1/lgpd/redact` — recebe `{contact_id, mode: 'anonymize' | 'delete'}`, valida pré-condições, executa cascade
- `GET /api/v1/contacts/:id/consent` — lê estado de consentimento
- `PATCH /api/v1/contacts/:id/consent` — atualiza com audit

**ACs principais.**
- Tenant admin solicita export de cliente X via UI → recebe PDF/JSON em D+7 com 100% dos dados pessoais armazenados
- Anonimização cascade afeta: contact, conversations (preserva histórico), messages (mídia removida do storage), activities (mantém timestamps e tipos)
- Tentativa de reverter anonimização retorna 403 `lgpd_anonymization_irreversible`
- Audit do redact registra `who`, `which contact`, `mode`, `cascaded_to=[conversations:N, messages:M, activities:K]`

### 3.7 Onboarding de tenant

**O que provê.** Fluxo de criação de novo tenant. **No MVP**, é executado manualmente pela equipe operadora (super-admin via UI ou CLI). **No SaaS futuro**, fica self-service.

**Princípios.**
- 1 organização criada → seed automático de pipeline default ("Pedidos") com stages canônicas e-commerce ("Carrinho abandonado / Aguardando pagamento / Pago / Em separação / Enviado / Entregue / Pós-venda")
- 1 admin do tenant criado por convite (link assinado de 24h)
- Credenciais de plataforma e-commerce (Nuvemshop) configuradas na onboarding via OAuth (detalhes no Sub-PRD 06)
- Conexão WhatsApp via QR fica num passo separado (pode ser feita pelo admin do tenant após login) (detalhes no Sub-PRD 03)
- 1 webhook secret é gerado por organização pra eventos LGPD da Nuvemshop

**ACs principais.**
- Super-admin cria tenant via UI/CLI em ≤5 cliques/comandos
- Tenant criado vem com pipeline default já populado
- Convite de admin expira em 24h e não pode ser reutilizado
- Tentativa de criar tenant duplicado (mesmo CNPJ) retorna 409 `tenant_already_exists`

### 3.8 API base & convenções

**O que provê.** Convenções universais que **toda rota `/api/v1/`** seguirá, em todo subsistema.

| Aspecto | Convenção |
|---|---|
| Versionamento | Por path: `/api/v1/`, depois `/api/v2/` |
| Formato | JSON `snake_case` em request e response |
| IDs | UUID v4 |
| Datas | ISO-8601 UTC |
| Dinheiro | `_cents` (bigint) + `currency` ISO-4217 |
| Wrapper de sucesso | `{ data: T, meta?: { cursor, has_more, total } }` |
| Wrapper de erro | `{ error: { code, message, details? } }` |
| Paginação | Cursor por default (cursor opaco base64 com HMAC) |
| Idempotência | Header `Idempotency-Key: <uuid>` em POST de criação; TTL 24h |
| Rate limit | Upstash Redis sliding window; headers `X-RateLimit-*` + `Retry-After` |
| Auth | Cookie session (frontend) OU `Authorization: Bearer tok_...` (server-to-server) |
| Status codes | 200 / 201 / 204 / 400 / 401 / 403 / 404 / 409 / 422 / 429 / 500 |
| CORS | Allowlist explícita por tenant; nunca `*` |
| Request ID | Header `X-Request-Id` correlaciona com audit log |

**ACs principais.**
- Toda response de erro segue o wrapper `{ error: { code, message, ...} }`
- Idempotency-Key recebida 2x com mesmo body retorna mesma response sem duplicar efeito; com body diferente retorna 409 `idempotency_conflict`
- Rate limit excedido retorna 429 com `Retry-After` e `error.code='rate_limited'`
- Cliente recebe `X-Request-Id` em todo response e pode usá-lo pra suporte (audit log linka via esse ID)

---

## 4. Requisitos Não-Funcionais

### 4.1 Segurança
- Toda comunicação HTTPS (TLS 1.3 mínimo)
- Postgres com `pgcrypto` ativo pra encrypt at-rest de campos sensíveis quando aplicável
- Sentry com `beforeSend` removendo headers/body sensíveis antes de enviar evento
- Logs sanitizados: `x-api-key`, `authorization`, `cookie`, `password`, `webhook_secret` filtrados antes de gravar
- `INTERNAL_SECRET` (cron) **diferente** do `SUPABASE_SERVICE_ROLE_KEY`
- DNS rebinding protection ativa em endpoints sensíveis

### 4.2 Performance
- p95 de auth check: <50ms
- p95 de tenant resolution + RLS query simples: <100ms
- p95 de mutação simples (POST/PATCH lead): <300ms
- p95 de audit log write: <500ms (fire-and-forget)
- Suporte concorrente: 100 RPS por tenant no MVP, escalável horizontalmente via Vercel

### 4.3 Compliance
- LGPD desde o dia 1 (vide §3.6)
- Audit log retenção 5 anos
- Backup diário do Postgres (Supabase) + retenção 30 dias
- Documentação operacional (runbook LGPD) entregue antes do primeiro tenant em produção

### 4.4 Observabilidade
- Sentry pra erros (com sanitização)
- Métricas custom (latência, taxa de erro, audit log lag) em painel a definir na Spec
- Health check endpoint público `/api/v1/health` (sem auth, retorna 200 + status de dependências)

---

## 5. Acceptance Criteria do sub-PRD

A Plataforma Base é considerada **MVP-completa** quando:

1. ✅ 2 tenants podem ser criados, cada um com pipeline default seedado, e isolamento de dados é verificado por teste automatizado no CI
2. ✅ Login com MFA TOTP funciona pra admin; usuário sem MFA é forçado a configurar
3. ✅ Bearer token criado pelo admin permite chamada server-to-server, e tem audit log de criação/uso
4. ✅ Endpoint LGPD `data-request` gera export JSON + PDF em ≤7 dias úteis pra um contato real
5. ✅ Endpoint LGPD `redact` anonimiza um contato com cascade pra conversations/messages/activities, sem perda de histórico de pedidos
6. ✅ Audit log captura todas as mutações listadas e não pode ser editado via API
7. ✅ Super-admin de plataforma loga, troca de tenant pela UI, e ações são auditadas com `as_platform_admin=true`
8. ✅ Rate limit funciona em endpoint crítico (login + criação de lead)
9. ✅ Health check endpoint retorna 200 com status de Supabase, Redis e WAHA
10. ✅ Documentação operacional (runbook LGPD + matriz RBAC + lista de eventos auditados) entregue

---

## 6. Dependências

### Internas (outros sub-PRDs)
- Nenhuma. Plataforma Base é foundation de todos os outros.

### Externas
- **Supabase** (Auth, Postgres, Storage) — projeto provisionado, plano Pro mínimo pra produção
- **Vercel** — projeto + domínio + AI Gateway (pra Sub-PRDs futuros)
- **Upstash Redis** — instância de produção pra rate limit
- **Sentry** — projeto criado, com regras de sanitização aprovadas
- **Domínio + subdomínio** `admin.deskcomm.com` (pra UI super-admin)

### Decisões deferidas pra Spec
- Tabela auxiliar `platform_admins` vs coluna `is_platform_admin` em `auth.users`
- Roteamento por subdomain vs header `X-Tenant-ID`
- Gerador de cursor (HMAC com qual chave?)
- Política exata de retenção de mensagens por tenant (configurável dentro de bounds)

---

## 7. Riscos Específicos do sub-PRD

| # | Risco | Mitigação |
|---|---|---|
| P1 | RLS policy mal escrita vaza dados cross-tenant | Templates de policy + linter SQL no CI + teste de isolamento obrigatório por tabela tenant-aware |
| P2 | Service role key vaza em log/repo | Variável de ambiente apenas; nunca em código; `.gitleaks` no pre-commit; rotação trimestral |
| P3 | MFA TOTP perdido bloqueia admin | Códigos de recuperação gerados na configuração; processo de reset via super-admin com audit duplo |
| P4 | Audit log explode em volume e custa caro | Retenção em hot storage 90 dias; rest em cold storage (S3) com lifecycle policy; sampling em GET-volume baixo |
| P5 | Super-admin abusivo vê dados sem necessidade | Toda ação loggeada com flag; revisão semanal pelo líder operacional; consideração futura de "modo restrito" exigindo justificativa por sessão |
| P6 | LGPD data_request demora além de D+7 | Job assíncrono com fila própria + alarme em D+5; runbook de escalação pra super-admin |
| P7 | Onboarding manual erra config (webhook secret, role inicial) | CLI script ou wizard guiado; validação automática pós-criação (ping em todos os endpoints essenciais) |

---

## 8. Fora de Escopo (deste sub-PRD)

- SSO empresarial (SAML, OIDC, Google Workspace) — entra em fase pós-MVP quando demanda enterprise surgir
- 2FA por SMS — não recomendado (SIM swap); só TOTP/WebAuthn
- Pentest formal externo — entra na Fase 1.5 (Hardening)
- Certificações SOC 2, ISO 27001 — entram na Fase 2+ conforme demanda comercial
- Multi-fator avançado (WebAuthn / passkey) — Fase 1.5 ou 2
- Self-service de criação de tenant (signup público) — Fase SaaS
- Permissão por pipeline (`user_pipeline_access`) — adicionar quando 1º cliente real pedir
- Localização (multi-language) — produto começa só em PT-BR

---

## 9. Decisões deferidas pra Spec (Fase 3)

A serem decididas no spec correspondente (`docs/specs/01-spec-platform-base.md`):

1. Schema SQL completo de `organizations`, `user_organizations`, `auth.users` extensions, `api_tokens`, `api_audit_log`, `platform_admins` (se virar tabela)
2. Templates exatos de RLS policy por tabela
3. Estrutura completa do payload de Bearer token (claims, escopos)
4. Formato exato do cursor opaco (algoritmo HMAC, schema interno)
5. Lista canônica de actions auditadas (ex: `lead.created`, `token.revoked`, `consent.changed`, `redact.executed`, etc.) — versão completa
6. Esquema do export LGPD (estrutura JSON, layout do PDF)
7. Fluxo de UI do super-admin (mockups na Spec)
8. CLI ou wizard de onboarding de tenant
9. Estratégia de cold storage de audit log (S3 + lifecycle policies)

---

## Anexos

- `docs/research/reference-synthesis.md` — pontos herdados (especialmente §4 Multi-tenancy, §6 API REST, §7 RBAC)
- `docs/prd/00-prd-master.md` — visão geral
- `tasks/todo.md` — fluxo de construção
