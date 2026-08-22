---
epic_id: EPIC-08-lgpd
epic_name: LGPD Compliance
priority: P0
estimated_waves: 8
estimated_total_points: 26
depends_on: [EPIC-01, EPIC-05, EPIC-07]
exposes_contracts:
  - "api.POST /api/v1/lgpd/data-request"
  - "api.POST /api/v1/lgpd/redact"
  - "api.GET /api/v1/lgpd/requests"
  - "api.GET /api/v1/lgpd/requests/[id]/preview"
  - "api.POST /api/v1/webhooks/nuvemshop/customer-redact"
  - "api.POST /api/v1/webhooks/nuvemshop/customer-data-request"
  - "api.POST /api/v1/webhooks/nuvemshop/store-redact"
  - "worker.lgpd-export-worker"
  - "worker.lgpd-redact-worker"
  - "cron.lgpd-sla-watcher"
  - "event.lgpd.data_request_received"
  - "event.lgpd.redact_received"
  - "event.lgpd.export_generated"
  - "event.lgpd.redact_applied"
  - "route./app/lgpd/requests"
  - "route./app/lgpd/requests/[id]"
status: pending
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-08 — LGPD Compliance

> **Para o epic-executor**: leia inteiro antes de qualquer wave. Stories em ordem de dependência. Cada story = 1 wave. `Deps:` é lei. Este epic encerra o ciclo de compliance: 3 webhooks Nuvemshop LGPD → workers (export D+7, redact D+15) → UI de gestão → audit dense + SLA watcher. Sem isso, o produto está em violação ANPD assim que conectar uma loja Nuvemshop com clientes ativos.

## 1. Objetivo

Entregar pipeline LGPD completo e auditável: receber 3 webhooks Nuvemshop (`customer/redact`, `customer/data_request`, `store/redact`), processar via workers reativos (export PAdES em D+7 úteis, anonimização cascade em D+15 úteis), expor UI `/app/lgpd/requests` pra admin acompanhar SLA, alarmar D+5/D+10 via Sentry, e gravar audit dense com cascaded counts em `api_audit_log` append-only.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] 3 webhook receivers Nuvemshop (`customer/redact`, `customer/data_request`, `store/redact`) recebem POST, validam HMAC, gravam em `lgpd_requests` com `due_at` correto (D+7 ou D+15 úteis), emitem `lgpd.data_request_received` ou `lgpd.redact_received`, retornam 200 dentro de 5s.
- [ ] Worker `lgpd-export-worker` consome `lgpd.data_request_received`, coleta JSON estruturado conforme Spec 01 §8.3, gera PDF assinado PAdES, faz upload em `lgpd-exports/{request_id}.pdf`, envia email com signed URL ao titular, marca `status=completed`.
- [ ] Worker `lgpd-redact-worker` consome `lgpd.redact_received`, executa cascade SQL transacional (Spec 01 §8.2), preserva orders por valor histórico, grava audit dense com `cascaded_to` counts, callback Nuvemshop confirmation.
- [ ] `store/redact` cobre TODOS os contacts do tenant com flag `emergency=true` (operação massiva, SLA acelerado).
- [ ] Page `/app/lgpd/requests` lista requests com filtros status/tipo/SLA + banner de alarme em D+5 (data_request) e D+10 (redact).
- [ ] Page `/app/lgpd/requests/[id]` mostra timeline visual SLA (D+0/D+5/D+7 ou D+0/D+10/D+15), preview dos dados a anonimizar/exportar, botões "Aprovar export" e "Aprovar redact".
- [ ] Cron `lgpd-sla-watcher` (1×/dia) alerta no Sentry + email pro admin quando data_request atinge D+5 ou redact atinge D+10 sem `status=completed`.
- [ ] L-01 a L-10 (rules catalog) enforced: anonimização preferida sobre delete, SLA D+7/D+15, irreversibilidade, audit append-only com retenção 5 anos, CPF nunca em logs.
- [ ] `api_audit_log` recebe entries `lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.export_delivered`, `lgpd.redact_received`, `lgpd.redact_executed`, `lgpd.redact_failed` com payload completo.
- [ ] Regression suite cobre: webhook idempotency, SLA computation (dias úteis BR), cascade SQL transactional rollback, PDF signature verification, RLS isolation entre tenants em `/app/lgpd/requests`.

## 3. Pré-requisitos

- EPIC-01 completo: auth, RLS, `useAuth`, layout `/app/`, `lgpd:execute` permission.
- EPIC-05 completo: `contacts.is_anonymized`, `cpf_encrypted`, RLS de contacts, timeline.
- EPIC-07 completo: `tenant_integrations` Nuvemshop, OAuth, `webhook_events_log`, callback adapter.
- Migrations aplicadas: `0011_lgpd_requests.sql` (Spec 01 §13).
- Variáveis de env: `LGPD_SIGNING_KEY` (PAdES private key), `LGPD_DPO_EMAIL`, `LGPD_EXPORT_EXPIRES_HOURS=72`, `LGPD_STORAGE_BUCKET=lgpd-exports`, `RESEND_API_KEY` (delivery), `SENTRY_DSN`.
- Inngest / pg_boss queue rodando com namespace `lgpd.*`.
- Storage bucket `lgpd-exports` criado com RLS: leitura via signed URL only, write somente service_role.
- Dev server rodando em `localhost:3001`.
- Playwright MCP conectado pra QA.

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `useAuth()` + middleware |
| `auth.permission lgpd:execute` | permission | EPIC-01 | Gate em `/app/lgpd/*` e botão Aprovar |
| `db.contacts` | db_table | EPIC-05 | Cascade SQL update + `is_anonymized=true` (L-04) |
| `db.crm_leads`, `db.crm_lead_activities` | db_table | EPIC-04/05 | Cascade SQL metadata strip |
| `db.conversations`, `db.messages` | db_table | EPIC-03 | Cascade SQL anonimização body/media |
| `db.orders`, `db.nuvemshop_products` | db_table | EPIC-07 | Preservar orders (valor histórico); strip metadata pessoal |
| `db.tenant_integrations` | db_table | EPIC-07 | Resolver integration pra callback Nuvemshop |
| `db.webhook_events_log` | db_table | EPIC-07 (Spec 06 §3.4) | Idempotency dos 3 webhooks LGPD |
| `db.api_audit_log` | db_table | EPIC-01 | Audit dense append-only (L-06, L-10) |
| `adapter.NuvemshopAdapter.redactCustomer` | function | EPIC-07 | Callback de confirmação após cascade |
| `infra.queue` | queue | EPIC-00 | Inngest/pg_boss `lgpd.*` jobs |
| `infra.storage` | storage | EPIC-00 | Bucket `lgpd-exports` |
| `lib.audit` | function | EPIC-01 | `audit({ action, resourceType, resourceId, metadata })` |
| `ui.<DataTable>`, `<Banner>`, `<Timeline>` | react_component | EPIC-00/01 | Reuso em UI de requests |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `api.POST /api/v1/webhooks/nuvemshop/customer-redact` | webhook | S-08.01 | Receiver LGPD; valida HMAC, retorna 200 dentro de 5s |
| `api.POST /api/v1/webhooks/nuvemshop/customer-data-request` | webhook | S-08.02 | Idem, type=data_request |
| `api.POST /api/v1/webhooks/nuvemshop/store-redact` | webhook | S-08.03 | Idem, emergency=true |
| `event.lgpd.data_request_received` | domain_event | S-08.01 | Payload `{ request_id, organization_id, contact_id?, customer_external_id, due_at }` |
| `event.lgpd.redact_received` | domain_event | S-08.01/03 | Payload `{ request_id, organization_id, scope: 'contact'\|'tenant', emergency }` |
| `event.lgpd.export_generated` | domain_event | S-08.04 | Payload `{ request_id, pdf_url, json_url, sha256, generated_at }` |
| `event.lgpd.redact_applied` | domain_event | S-08.05 | Payload `{ request_id, cascaded_to: { conversations, messages, activities, leads }, executed_at }` |
| `worker.lgpd-export-worker` | worker | S-08.04 | Consome `lgpd.data_request_received`; output: PDF+JSON em Storage + email |
| `worker.lgpd-redact-worker` | worker | S-08.05 | Consome `lgpd.redact_received`; output: cascade SQL + callback |
| `cron.lgpd-sla-watcher` | cron | S-08.08 | 1×/dia 09:00 BRT; alarme D+5/D+10 |
| `api.GET /api/v1/lgpd/requests` | api_route | S-08.06 | Lista paginada + filtros |
| `api.GET /api/v1/lgpd/requests/[id]/preview` | api_route | S-08.07 | Preview JSON dry-run dos dados afetados |
| `api.POST /api/v1/lgpd/requests/[id]/approve` | api_route | S-08.07 | Aprova export/redact (idempotency-key) |
| `route./app/lgpd/requests` | route | S-08.06 | Lista com SLA banner |
| `route./app/lgpd/requests/[id]` | route | S-08.07 | Detalhe + timeline + preview |
| `hook.useLgpdRequests`, `useLgpdRequest` | react_hook | S-08.06/07 | TanStack Query bindings |

## 5. Stories (em ordem de dependência)

> Cada story = uma wave. Wave 1 = S-08.01.

---

### S-08.01 — Webhook receiver `customer/redact` + tabela `lgpd_requests`

**Points**: 4 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 06 §5.6, Spec 01 §8.1, BR L-01, L-03, L-06

#### Contexto
Primeira story do epic. Cria a tabela canônica `lgpd_requests` (já prevista na migration 0011 — confirmar aplicação) e o primeiro receiver. Decisão lockada: SLA `due_at` é calculado em **dias úteis brasileiros** (BMF&Bovespa calendar) — não dias corridos. Lib: `date-fns-tz` + `date-fns-business-days` com lista de feriados nacionais. `webhook_events_log` (Spec 06 §3.4) já existe — reusar pra idempotency com partial index `where event_type in ('customer/redact', 'customer/data_request', 'store/redact')`.

Receiver retorna 200 dentro de 5s **antes** do processing — pipeline é totalmente reativo via event. HMAC validado conforme Spec 06 §5.0.

#### Files to create
- `app/api/v1/webhooks/nuvemshop/customer-redact/route.ts` — POST receiver
- `lib/lgpd/sla.ts` — `computeDueAt(receivedAt, slaDays, holidays)` (dias úteis BR)
- `lib/lgpd/holidays-br.ts` — lista de feriados nacionais 2026-2030
- `lib/lgpd/repository.ts` — `createLgpdRequest()`, `findLgpdRequest()`, helpers
- `lib/lgpd/types.ts` — types canônicos (`LgpdRequest`, `LgpdRequestType`, `LgpdRequestStatus`)
- `tests/unit/lgpd-sla.test.ts` — vitest pra SLA computation

#### Files to modify
- `lib/events/registry.ts` — registrar `lgpd.data_request_received`, `lgpd.redact_received`
- `supabase/migrations/0011_lgpd_requests.sql` — confirmar schema (criar se não existir): `id uuid pk`, `organization_id`, `type text check`, `subject jsonb`, `customer_external_id text`, `delivery jsonb`, `status text`, `due_at timestamptz`, `received_at timestamptz`, `completed_at timestamptz`, `emergency boolean default false`, `webhook_event_id uuid fk`, `external_reference text`, `metadata jsonb`. RLS por `organization_id`.

#### Implementation steps
1. Confirmar/aplicar migration 0011_lgpd_requests com schema acima + index `(organization_id, status, due_at)`.
2. Implementar `computeDueAt(now, 15, holidaysBR)` — pula sábado/domingo/feriados.
3. Receiver: validar HMAC (reuse middleware Spec 06 §5.0) → resolver `organization_id` via `tenant_integrations.store_id` → INSERT em `webhook_events_log` (idempotent) → resolver contact local via `customer_external_id` (pode ser `null` — L-03 ainda registra) → INSERT em `lgpd_requests` com `type='customer_redact'`, `due_at = now + 15d úteis`, `status='received'` → emit `lgpd.redact_received` → audit `lgpd.redact_received` → return 200.
4. Se webhook duplicado (`webhook_events_log` colision), retornar 200 sem reprocessar.
5. Testes unitários SLA: D+15 a partir de 2026-04-29 (qua) → 2026-05-21 (qui, pulando Tiradentes 21/04? não, já passou; pulando final de semanas).

#### Acceptance Criteria

```gherkin
Given Nuvemshop envia POST customer/redact com HMAC válido pra tenant T1
When receiver recebe payload com customer { id, email }
Then INSERT em lgpd_requests com type='customer_redact', due_at = now + 15d úteis BR, status='received'
And event lgpd.redact_received emitido com { request_id, organization_id, customer_external_id }
And audit_log contém lgpd.redact_received
And response 200 retorna em <5s
```

```gherkin
Given mesmo webhook reenviado 3× em 1min (Nuvemshop retry)
When receiver processa
Then só 1 row em lgpd_requests (idempotency via webhook_events_log)
And response 200 em todos os 3 calls
```

```gherkin
Given HMAC inválido
When receiver processa
Then response 401
And nenhum INSERT em lgpd_requests
And audit_log contém webhook.hmac_invalid
```

```gherkin
Given customer_external_id não tem contact local correspondente
When receiver processa
Then INSERT em lgpd_requests com subject={ customer_external_id, contact_id: null }
And audit_log contém lgpd.redact_no_local_footprint
And event lgpd.redact_received ainda é emitido (worker decide o que fazer)
```

```gherkin
Given hoje é sexta 2026-05-01 (feriado dia trabalho)
When computeDueAt(now, 15, holidaysBR)
Then due_at é 2026-05-25 (segunda) — pulando 02/05 sab, 03/05 dom, 01/05 feriado
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | POST com HMAC válido retorna 200 | curl com signature correta |
| t2 | api | POST com HMAC inválido retorna 401 | curl signature errada |
| t3 | db | `lgpd_requests` row criada com due_at correto | SQL: `select due_at from lgpd_requests where id=$1` |
| t4 | db | Idempotency: 3× mesmo webhook → 1 row | webhook_events_log conflict |
| t5 | rls | Tenant T2 não vê requests do T1 | session T2 query → empty |
| t6 | unit | SLA pula feriados BR + final de semana | vitest com 10 cases edge |
| t7 | event | event.lgpd.redact_received presente em event_log | SQL select |
| t8 | audit | Audit dense gravado | `select metadata from api_audit_log where action='lgpd.redact_received'` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: db_table
    id: "lgpd_requests"
    schema: "id, organization_id, type, subject jsonb, customer_external_id, delivery jsonb, status, due_at, received_at, completed_at, emergency, webhook_event_id, external_reference, metadata jsonb"
    rls: "organization_id via fn_user_org_ids()"
  - type: webhook
    id: "POST /api/v1/webhooks/nuvemshop/customer-redact"
    auth: "HMAC SHA256 header x-linkedstore-hmac-sha256"
    response_p99: "<5s"
  - type: domain_event
    id: "lgpd.redact_received"
    payload: "{ request_id, organization_id, scope: 'contact', emergency: false, customer_external_id, contact_id?: string|null }"
  - type: lib
    id: "lib/lgpd/sla.ts:computeDueAt"
    signature: "(receivedAt: Date, slaDays: number, holidays: Date[]) => Date"
```

#### Decisões a registrar
- SLA é em **dias úteis BR**, não corridos. Lista de feriados em `lib/lgpd/holidays-br.ts` revisada anualmente.
- Receiver retorna 200 antes do processing — pipeline reativo via event obrigatório.
- `subject.contact_id` pode ser null se sem footprint local (L-03 mesmo assim cria request pra audit).

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Typecheck/lint zero erros
- [ ] Migration 0011 aplicada e RLS verificada
- [ ] Vitest SLA: 10/10 cases ok
- [ ] Commit `feat(EPIC-08): customer-redact webhook receiver [wave 1]`

---

### S-08.02 — Webhook receiver `customer/data_request`

**Points**: 3 | **Priority**: P0 | **Deps**: S-08.01 | **FR refs**: Spec 06 §5.7, Spec 01 §8.1, BR L-02

#### Contexto
Mesmo padrão do S-08.01, mas SLA D+7 úteis e emite `lgpd.data_request_received`. Reaproveita 100% da infra (sla.ts, repository, holidays). Decisão: o receiver **não** dispara o worker direto — apenas emite o event. O worker `lgpd-export-worker` (S-08.04) escuta o event.

#### Files to create
- `app/api/v1/webhooks/nuvemshop/customer-data-request/route.ts`

#### Files to modify
- `lib/lgpd/repository.ts` — adicionar branch `type='customer_data_request'` (slaDays=7)
- `lib/events/registry.ts` — `lgpd.data_request_received`

#### Implementation steps
1. Receiver basicamente clone do S-08.01: HMAC → idempotency → INSERT lgpd_requests (`type='customer_data_request'`, `due_at = now + 7d úteis`, `delivery` extraído do payload Nuvemshop) → emit `lgpd.data_request_received` → audit.
2. Delivery: Nuvemshop manda `customer.email` — usar como default `delivery.address`, `delivery.method='email'`.

#### Acceptance Criteria

```gherkin
Given Nuvemshop envia customer/data_request com customer.email="cliente@x.com"
When receiver processa
Then lgpd_requests row criada com type='customer_data_request', due_at = now + 7d úteis, delivery={method:'email', address:'cliente@x.com'}
And event lgpd.data_request_received emitido
And response 200 em <5s
```

```gherkin
Given hoje é seg 2026-04-27
When computeDueAt(now, 7, holidaysBR)
Then due_at é 2026-05-06 (qua) — pula 1° de Maio (feriado) + 02/05 sab + 03/05 dom
```

```gherkin
Given duplicado por retry Nuvemshop
When receiver processa
Then idempotent (1 row apenas)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | POST customer/data_request → 200 + row criada | curl + SQL check |
| t2 | db | due_at = now + 7d úteis | SQL diff |
| t3 | event | lgpd.data_request_received em event_log | SQL |
| t4 | audit | Audit registra | SQL |
| t5 | rls | Cross-tenant isolado | session swap |

#### Architecture contracts emitted

```yaml
exposes:
  - type: webhook
    id: "POST /api/v1/webhooks/nuvemshop/customer-data-request"
  - type: domain_event
    id: "lgpd.data_request_received"
    payload: "{ request_id, organization_id, customer_external_id, contact_id?, delivery: { method, address }, due_at }"
```

#### Decisões a registrar
- Delivery default é email do customer no payload Nuvemshop. Se ausente, request entra com `delivery=null` e operador resolve via UI.

#### Definition of Done
- [ ] ACs ok, typecheck/lint ok, regression S-08.01 mantida
- [ ] Commit `feat(EPIC-08): customer-data-request webhook [wave 2]`

---

### S-08.03 — Webhook receiver `store/redact` (massivo + emergency)

**Points**: 3 | **Priority**: P0 | **Deps**: S-08.01 | **FR refs**: Spec 06 §5.8, BR L-01, L-03

#### Contexto
`store/redact` é o webhook nuclear: Nuvemshop avisa que o tenant **inteiro** desinstalou o app — temos 30 dias pra apagar tudo. Cria request com `emergency=true`, `scope='tenant'`, e o worker S-08.05 vai iterar sobre **todos** os contacts do tenant. SLA continua D+15 úteis mas com flag de prioridade pra alarme cedo. Importante: também atualiza `organizations.status='redacted'` ao final (Spec 01 §59 comment).

#### Files to create
- `app/api/v1/webhooks/nuvemshop/store-redact/route.ts`

#### Files to modify
- `lib/lgpd/types.ts` — adicionar `scope: 'contact' | 'tenant'`
- `lib/lgpd/repository.ts` — branch `type='store_redact'`

#### Implementation steps
1. Receiver: HMAC → resolver org via `store_id` → INSERT lgpd_requests (`type='store_redact'`, `emergency=true`, `due_at=now+15d úteis`, `subject={scope:'tenant'}`).
2. Emit `lgpd.redact_received` com `scope='tenant', emergency=true`.
3. Audit `lgpd.store_redact_received` com `expected_contacts_count` (count de contacts do tenant).

#### Acceptance Criteria

```gherkin
Given Nuvemshop envia store/redact pro tenant T1 com 1500 contacts ativos
When receiver processa
Then lgpd_requests row criada com type='store_redact', emergency=true, scope='tenant'
And event lgpd.redact_received com payload { scope:'tenant', emergency:true }
And audit lgpd.store_redact_received com metadata { expected_contacts_count: 1500 }
```

```gherkin
Given retry Nuvemshop
When duplicado
Then idempotent (1 row apenas)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Receiver 200 + row criada | curl |
| t2 | db | emergency=true, scope='tenant' | SQL |
| t3 | audit | expected_contacts_count populado | SQL count |
| t4 | event | event emitido com flag emergency | event_log |

#### Architecture contracts emitted

```yaml
exposes:
  - type: webhook
    id: "POST /api/v1/webhooks/nuvemshop/store-redact"
  - type: domain_event
    id: "lgpd.redact_received (scope=tenant)"
    payload: "{ request_id, organization_id, scope: 'tenant', emergency: true }"
```

#### Decisões a registrar
- `store/redact` força `organizations.status='redacted'` somente DEPOIS do worker S-08.05 confirmar cascade — não no receiver.

#### Definition of Done
- [ ] ACs ok, typecheck/lint, regression S-08.01/02
- [ ] Commit `feat(EPIC-08): store-redact webhook [wave 3]`

---

### S-08.04 — Worker `lgpd-export-worker` (PDF PAdES + email)

**Points**: 5 | **Priority**: P0 | **Deps**: S-08.02 | **FR refs**: Spec 01 §8.1, §8.3, Spec 06 §7.2, BR L-02, L-06, L-07, L-08

#### Contexto
Coração do export: dado um `lgpd.data_request_received`, coleta **todos** os dados do contact em todas as tabelas tenant-aware (contacts, leads, activities, conversations, messages, orders, consents, audit_log_extract), gera JSON estruturado conforme Spec 01 §8.3, gera PDF via `@react-pdf/renderer`, **assina PAdES** (PDF Advanced Electronic Signature) com `LGPD_SIGNING_KEY`, faz upload em Storage `lgpd-exports/{request_id}.pdf` + `data.json`, gera signed URL com expiração 72h, envia email pro titular via Resend.

Decisão lockada: PAdES via lib `node-signpdf` + `@signpdf/signer-p12` (P12 cert). Hash SHA256 do PDF final inserido no rodapé do próprio PDF (verificável). CPF e dados sensíveis aparecem no PDF (é o ponto do export!) — mas **nunca** em logs (L-08).

#### Files to create
- `workers/lgpd-export-worker.ts` — Inngest function
- `lib/lgpd/export-collector.ts` — agrega dados do contact (8 tabelas)
- `lib/lgpd/pdf-renderer.tsx` — `@react-pdf/renderer` template
- `lib/lgpd/pades-signer.ts` — wrapper `signPdfPades(buffer, p12Path, passphrase)`
- `lib/lgpd/email-delivery.ts` — Resend wrapper com template PT-BR
- `tests/integration/lgpd-export.test.ts` — happy path completo

#### Files to modify
- `lib/events/registry.ts` — `lgpd.export_generated`, `lgpd.export_delivered`

#### Implementation steps
1. Worker subscribe em `lgpd.data_request_received`.
2. `collectExportData(request_id)` → resolve contact, faz 8 SELECTs (filter por org_id+contact_id), retorna shape canônico Spec 01 §8.3.
3. `JSON.stringify(data, null, 2)` → upload `lgpd-exports/{request_id}/data.json`.
4. `renderLgpdPdf(data)` → buffer → `signPdfPades(buffer)` → upload `lgpd-exports/{request_id}/report.pdf`.
5. Gera signed URLs (expira em 72h via `LGPD_EXPORT_EXPIRES_HOURS`).
6. Resend email pro `req.delivery.address` com template PT-BR (assunto: "Sua solicitação LGPD #{short_id}").
7. UPDATE lgpd_requests SET status='completed', completed_at=now(), metadata=metadata || {pdf_url, json_url, sha256}.
8. Emit `lgpd.export_generated` + `lgpd.export_delivered`.
9. Audit dense em ambos.
10. Error handling: 3 retries com backoff exp; após 3, marca status='failed' e alarme Sentry; **nunca** loga CPF/email/phone no Sentry (sanitize).

#### Acceptance Criteria

```gherkin
Given lgpd_requests row com type='customer_data_request', status='received'
When worker consome lgpd.data_request_received
Then JSON estruturado com 8 categorias (contact, consents, conversations, messages, leads, orders, activities, audit_log_extract) é gerado
And PDF assinado PAdES é uploaded em lgpd-exports/{id}/report.pdf
And signed URL expira em 72h
And email enviado pra delivery.address com link
And status='completed', completed_at preenchido
And event lgpd.export_delivered emitido
And audit lgpd.export_generated + lgpd.export_delivered registrados
```

```gherkin
Given PDF gerado
When abro o PDF e verifico assinatura
Then assinatura PAdES é válida (verifyPdfSignature retorna true)
And SHA256 no rodapé bate com hash do arquivo
```

```gherkin
Given worker falha 3× (ex: Resend down)
When 3 retries esgotados
Then status='failed', metadata.error_reason populado
And Sentry capture com tags { request_id, organization_id }
And NENHUM email/cpf/phone aparece no Sentry payload (L-08)
```

```gherkin
Given contact tem 50k mensagens
When worker processa
Then PDF gerado em <60s (resumo + 100 mensagens mais recentes; JSON tem todas)
```

```gherkin
Given titular abre signed URL após 72h
When acessa
Then 403 expirado
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | integration | E2E happy path completo | seed contact + 5 conversations + run worker + verify storage + email |
| t2 | unit | PDF signature verifiable | `verifyPdfSignature(buffer)` |
| t3 | unit | JSON shape matches Spec 01 §8.3 | snapshot test |
| t4 | observability | Sentry payload sem PII | mock Sentry, force fail, inspect calls |
| t5 | api | Signed URL expira em 72h | parse URL exp param |
| t6 | db | status='completed' + completed_at | SQL |
| t7 | event | lgpd.export_delivered | event_log |
| t8 | perf | PDF gen <60s pra 50k msgs | bench |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "lgpd-export-worker"
    consumes: "lgpd.data_request_received"
    output: "PDF PAdES + JSON em Storage; email; status=completed"
    p99_runtime: "<60s"
  - type: domain_event
    id: "lgpd.export_generated"
    payload: "{ request_id, pdf_url, json_url, sha256, generated_at }"
  - type: domain_event
    id: "lgpd.export_delivered"
    payload: "{ request_id, delivery_method, delivery_address_hash, delivered_at }"
  - type: lib
    id: "lib/lgpd/pades-signer.ts:signPdfPades"
```

#### Decisões a registrar
- PAdES via `node-signpdf` + P12 cert. Cert renovação anual responsabilidade Ops.
- Signed URL expira em `LGPD_EXPORT_EXPIRES_HOURS=72` — após isso, titular precisa pedir re-export.
- Sanitize Sentry payload: `delivery.address` virá como `sha256(email)` em logs (L-08).

#### Definition of Done
- [ ] ACs ok, integration test verde
- [ ] PDF abre + assinatura válida em Adobe Reader manualmente
- [ ] Sentry test confirma zero PII
- [ ] Commit `feat(EPIC-08): lgpd-export-worker [wave 4]`

---

### S-08.05 — Worker `lgpd-redact-worker` (cascade SQL + callback Nuvemshop)

**Points**: 5 | **Priority**: P0 | **Deps**: S-08.01, S-08.03 | **FR refs**: Spec 01 §8.2, Spec 06 §7.1, §7.3, BR L-01, L-04, L-06

#### Contexto
Worker que executa o cascade SQL transacional Spec 01 §8.2: anonimiza `contacts` (irreversível, L-04), strip metadata em `conversations`/`messages`/`activities`/`leads`, **preserva orders** por valor histórico fiscal (Spec 06 §7.1: "preserva orders, valor histórico"), enfileira deleção de mídia em Storage, grava audit dense com `cascaded_to` counts, e por fim chama `NuvemshopAdapter.redactCustomer` pra confirmar receipt à Nuvemshop.

Branch crítica: `scope='tenant'` (S-08.03) → itera sobre todos os contacts em batches de 100, com checkpoint em `lgpd_requests.metadata.progress`. Se interromper, resume de onde parou.

Decisão lockada: cascade roda como `service_role` com flag `bypassed_rls=true` no audit (Spec 01 §1235). Transação BEGIN/COMMIT por contact — falha de 1 contact não derruba o batch inteiro no scope=tenant.

#### Files to create
- `workers/lgpd-redact-worker.ts` — Inngest function
- `lib/lgpd/redact-cascade.ts` — função `cascadeRedactContact(orgId, contactId, requestId, tx)` retornando counts
- `lib/lgpd/storage-redaction-queue.ts` — enfileira media URLs pra deleção async
- `tests/integration/lgpd-redact.test.ts` — cascade + idempotency

#### Files to modify
- `lib/events/registry.ts` — `lgpd.redact_applied`, `lgpd.redact_failed`
- `workers/storage-cleanup-worker.ts` (se já existir; senão criar) — consome queue
- `lib/nuvemshop/adapter.ts` — confirmar `redactCustomer` callback funciona

#### Implementation steps
1. Worker subscribe em `lgpd.redact_received`.
2. Branch por scope:
   - `scope='contact'`: 1 contact_id → cascade single transaction.
   - `scope='tenant'` (`emergency=true`): SELECT contacts WHERE org_id batch 100 → loop cascade per contact com progress checkpoint.
3. `cascadeRedactContact()`:
   - BEGIN
   - UPDATE contacts SET full_name='Cliente Anonimizado #...', email=null, phone_number=null, cpf_encrypted=null, is_anonymized=true, anonymized_at=now(), consent='{}'::jsonb (L-04)
   - UPDATE conversations metadata strip (count)
   - UPDATE messages SET body_text='[mensagem anonimizada]' WHERE type='text', media_url=null, media_thumb=null (count)
   - UPDATE crm_lead_activities metadata strip (count)
   - UPDATE crm_leads SET title=anonymized title (preserve linkage; count)
   - **NÃO toca orders** (preserva valor histórico; só strip metadata pessoal)
   - INSERT api_audit_log action='lgpd.redact_executed' com cascaded_to counts + bypassed_rls=true
   - INSERT em storage_redaction_queue com media_urls pra worker async deletar
   - COMMIT
4. Após cascade: chamar `NuvemshopAdapter.redactCustomer(ctx, { customerExternalId })` pra callback de confirmação.
5. UPDATE lgpd_requests SET status='completed', completed_at=now(), metadata=metadata || { cascaded_to, callback_status }.
6. Emit `lgpd.redact_applied`.
7. Branch tenant: ao final do loop, UPDATE organizations SET status='redacted'.
8. Erro: status='failed', emit `lgpd.redact_failed`, alarme Sentry (sem PII).

#### Acceptance Criteria

```gherkin
Given lgpd_requests row scope='contact' com contact C1 que tem 3 conversations, 50 messages, 5 activities, 2 leads, 4 orders
When worker processa
Then contacts.is_anonymized=true, full_name='Cliente Anonimizado #...', cpf_encrypted=null
And conversations metadata sem contact_full_name/contact_phone (3 rows updated)
And messages com type='text' tem body_text='[mensagem anonimizada]', media_url=null (50 rows)
And crm_lead_activities metadata strip (5 rows)
And crm_leads metadata strip (2 rows)
And orders permanecem com order_total, items, status (preserva valor histórico) — apenas metadata pessoal stripped (4 rows)
And api_audit_log tem entry lgpd.redact_executed com cascaded_to={conversations:3, messages:50, activities:5, leads:2, orders:4}
And NuvemshopAdapter.redactCustomer chamado
And lgpd_requests.status='completed'
And event lgpd.redact_applied emitido
```

```gherkin
Given contact já anonimizado (is_anonymized=true)
When worker tenta cascade novamente
Then idempotent: detecta e marca request status='completed' sem reaplicar
And audit lgpd.redact_skipped_already_anonymized
```

```gherkin
Given scope='tenant' com 1500 contacts
When worker processa em batches 100
Then progress checkpoint em metadata.progress {processed: N, total: 1500} updated a cada batch
And ao final organizations.status='redacted'
And event lgpd.redact_applied uma vez (resumo)
And se interrompido em batch 7, resume processa do contact 700+
```

```gherkin
Given worker falha em 1 contact dentro de batch tenant
When transação rollback nesse contact
Then outros 99 contacts do batch são commitados
And contact falho fica em metadata.failed_contacts[]
And status='partial_failure' se >0 falhas após retries
```

```gherkin
Given titular tenta UPDATE em contact anonimizado
When API recebe
Then 403 lgpd_anonymization_irreversible (L-04, Spec 01 §1203)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | integration | Cascade completo scope=contact | seed + worker + assert all counts |
| t2 | integration | Cascade scope=tenant 1500 contacts | seed bulk + worker + verify all anonymized |
| t3 | db | Orders preservados (valor histórico) | SQL: order_total, items intactos |
| t4 | db | Idempotency: contact já anonimizado | run 2× → 1 audit entry |
| t5 | api | UPDATE em anonymized → 403 | API call |
| t6 | callback | NuvemshopAdapter.redactCustomer chamado | mock adapter, assert call |
| t7 | observability | Sentry sem PII em failure path | force fail, inspect |
| t8 | event | lgpd.redact_applied com cascaded_to | event_log SQL |
| t9 | resume | Interrupt + restart resume from checkpoint | kill worker mid-batch, restart |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "lgpd-redact-worker"
    consumes: "lgpd.redact_received"
    output: "cascade SQL transactional + Nuvemshop callback + status=completed"
  - type: domain_event
    id: "lgpd.redact_applied"
    payload: "{ request_id, scope, cascaded_to: { contacts, conversations, messages, activities, leads, orders }, executed_at, callback_status }"
  - type: domain_event
    id: "lgpd.redact_failed"
    payload: "{ request_id, error_code, retry_count, partial: bool }"
  - type: lib
    id: "lib/lgpd/redact-cascade.ts:cascadeRedactContact"
```

#### Decisões a registrar
- Orders são **preservadas** (valor histórico fiscal) — apenas metadata pessoal é stripped. Backed by Spec 06 §7.1.
- Cascade tenant é resumível via `metadata.progress`. Falha em 1 contact não derruba batch.
- `organizations.status='redacted'` somente ao final do scope=tenant.
- Storage redaction de mídia é async via `storage_redaction_queue` (não bloquear cascade).

#### Definition of Done
- [ ] ACs ok, integration tests verdes
- [ ] Tenant scope tested com seed 1500 contacts
- [ ] Sentry sem PII confirmed
- [ ] Commit `feat(EPIC-08): lgpd-redact-worker [wave 5]`

---

### S-08.06 — Page `/app/lgpd/requests` (lista + filtros + SLA banner)

**Points**: 3 | **Priority**: P0 | **Deps**: S-08.01..05 | **FR refs**: Spec 01 §8, BR L-02, L-03, L-06

#### Contexto
UI pra admin/super-admin acompanhar todas as requests do tenant. Lista paginada com filtros (status, type, SLA bucket: ok/warning/critical), banner top quando há request em D+5 (data_request) ou D+10 (redact) sem completion. Apenas roles com permission `lgpd:execute` (Spec 01 §807) acessam — admin + super-admin. Reusa `<DataTable>` (EPIC-00) e `<Banner>` (EPIC-01).

#### Files to create
- `app/(app)/lgpd/requests/page.tsx`
- `app/(app)/lgpd/requests/RequestsTable.tsx`
- `app/(app)/lgpd/requests/SlaBanner.tsx`
- `app/api/v1/lgpd/requests/route.ts` — GET list
- `hooks/useLgpdRequests.ts` — TanStack Query

#### Files to modify
- `app/(app)/layout.tsx` — adicionar item "LGPD" no sidebar (gate por permission)

#### Implementation steps
1. API GET `/api/v1/lgpd/requests`: paginação, filtros `?status&type&sla_bucket`, retorna `{ data, meta: { total, page } }`. RLS automático por org.
2. `useLgpdRequests({ filters, page })` — TanStack Query.
3. Page render: Banner (red se qualquer request crítica; yellow se warning) + DataTable colunas: ID curto, Type, Subject (email/cpf parcial), Received At, Due At, SLA bucket (badge), Status, Actions ("Ver").
4. SLA bucket compute client-side via `due_at - now`: <0=overdue (red), <2d=critical (red), <50%=warning (yellow), else ok (green).
5. Permission gate: 403 se `!hasPermission('lgpd:execute')`.

#### Acceptance Criteria

```gherkin
Given user admin acessa /app/lgpd/requests
When há 2 requests data_request em D+5 (warning) e 1 redact em D+11 (overdue)
Then banner mostra "1 request crítica + 2 em warning" em vermelho
And tabela lista 3 rows ordenadas por due_at asc
```

```gherkin
Given user agente (sem permission lgpd:execute)
When acessa /app/lgpd/requests
Then 403 com mensagem "Permissão necessária: lgpd:execute"
```

```gherkin
Given filtro ?status=completed
When aplicado
Then só requests completed aparecem
```

```gherkin
Given user T1 acessa
When query
Then só vê requests de T1 (RLS)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Banner aparece com cor correta | seed + Playwright |
| t2 | ui | Tabela lista com colunas e badges SLA | Playwright |
| t3 | api | GET /api/v1/lgpd/requests paginado | curl |
| t4 | rls | Cross-tenant isolado | session swap |
| t5 | permission | Agente recebe 403 | role swap |
| t6 | filter | Filtros combinam | URL params |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/lgpd/requests"
  - type: api_route
    id: "GET /api/v1/lgpd/requests"
    query: "?status&type&sla_bucket&page&limit"
  - type: react_hook
    id: "useLgpdRequests"
```

#### Definition of Done
- [ ] ACs ok, Playwright suite verde
- [ ] Commit `feat(EPIC-08): /app/lgpd/requests page [wave 6]`

---

### S-08.07 — Page `/app/lgpd/requests/[id]` (timeline + preview + approve)

**Points**: 4 | **Priority**: P0 | **Deps**: S-08.06 | **FR refs**: Spec 01 §8, BR L-01, L-02, L-03

#### Contexto
Detalhe da request com timeline visual SLA (D+0/D+5/D+7 pra data_request; D+0/D+10/D+15 pra redact), preview dos dados que serão exportados/anonimizados (dry-run via API), e botões "Aprovar export" / "Aprovar redact" (idempotency-key obrigatório). Aprovar dispara o worker S-08.04 ou S-08.05 mesmo que a request tenha vindo de webhook (operador pode escolher quando — útil pra requests manuais via API ou pra atrasar até validação humana).

Decisão: para requests vindas de webhook Nuvemshop, o worker já dispara automaticamente (S-08.01 emite event imediato). O botão "Aprovar" é redundante mas existe pra requests **manuais** (criadas via API direta ou pela própria UI futura). Aprovação manual também é audit gate L-06.

#### Files to create
- `app/(app)/lgpd/requests/[id]/page.tsx`
- `app/(app)/lgpd/requests/[id]/SlaTimeline.tsx`
- `app/(app)/lgpd/requests/[id]/PreviewPanel.tsx`
- `app/(app)/lgpd/requests/[id]/ApproveButton.tsx`
- `app/api/v1/lgpd/requests/[id]/route.ts` — GET detail
- `app/api/v1/lgpd/requests/[id]/preview/route.ts` — GET dry-run
- `app/api/v1/lgpd/requests/[id]/approve/route.ts` — POST com idempotency-key
- `hooks/useLgpdRequest.ts`, `useLgpdPreview.ts`, `useApproveLgpdRequest.ts`

#### Implementation steps
1. GET detail: retorna lgpd_requests row + audit_log entries relacionadas + storage URLs se completed.
2. GET preview (dry-run): mesma logic do export-collector (S-08.04) mas só retorna **counts** + sample (10 rows por categoria). Não gera PDF, não toca DB.
3. POST approve: valida permission `lgpd:execute` + idempotency-key + status='received' → emite event correspondente → audit `lgpd.manually_approved` → return 202.
4. SlaTimeline component: 3 marcos visuais com cor por proximidade (received_at → warning_at → due_at). Usa lib `date-fns` pra computar progresso linear.
5. PreviewPanel: tabela com counts por categoria + sample expandable.
6. ApproveButton: 2 variants (export | redact) com confirm dialog "Tem certeza?" + textarea pra `approved_reason` (audit metadata).

#### Acceptance Criteria

```gherkin
Given request data_request received_at=2026-04-21, due_at=2026-04-30
When user abre detalhe em 2026-04-26
Then timeline mostra 3 marcos: D+0 (verde, completo), D+5 warning (amarelo, atual), D+7 due (cinza, futuro)
And progresso linear ~70%
```

```gherkin
Given request scope='contact' contact C1
When user clica preview
Then API retorna counts {contacts:1, conversations:5, messages:200, leads:2, orders:3, activities:10}
And sample com 10 rows por categoria (sem CPF; com email parcial)
And dry-run NÃO toca DB
```

```gherkin
Given user admin com permission lgpd:execute
When clica "Aprovar export" + confirma + idempotency-key X
Then 202, audit lgpd.manually_approved gravado, event lgpd.data_request_received emitido
And request.status muda pra 'processing' no realtime
```

```gherkin
Given user clica "Aprovar" 2× (double-click)
When mesma idempotency-key
Then só 1 event emitido, 2° request retorna 200 com mesmo result
```

```gherkin
Given agente sem permission acessa
When tenta approve
Then 403
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Timeline renderiza com 3 marcos + progresso correto | Playwright snapshot |
| t2 | api | Preview retorna counts + sample sem CPF | curl + assert |
| t3 | api | Approve com idempotency-key dedup | 2× curl mesma key |
| t4 | permission | Agente 403 em approve | role swap |
| t5 | event | Approve emite event correto | event_log |
| t6 | audit | manually_approved registrado com approved_reason | SQL |
| t7 | ui | ApproveButton só aparece se status='received' | Playwright |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/lgpd/requests/[id]"
  - type: api_route
    id: "GET /api/v1/lgpd/requests/[id]"
  - type: api_route
    id: "GET /api/v1/lgpd/requests/[id]/preview"
    response: "{ counts: { contacts, conversations, messages, leads, orders, activities }, sample }"
  - type: api_route
    id: "POST /api/v1/lgpd/requests/[id]/approve"
    headers: "idempotency-key required"
    response: "202 + { request_id, status: 'processing' }"
  - type: react_hook
    id: "useLgpdRequest, useLgpdPreview, useApproveLgpdRequest"
```

#### Decisões a registrar
- Approve manual emite o event como se fosse webhook — worker é unificado, não precisa branch.
- Preview NUNCA mostra CPF na resposta (L-08); email/phone parciais (`a***@b.com`).

#### Definition of Done
- [ ] ACs ok, Playwright suite verde
- [ ] Preview não vaza CPF — confirmado em test
- [ ] Commit `feat(EPIC-08): /app/lgpd/requests/[id] detail [wave 7]`

---

### S-08.08 — Cron `lgpd-sla-watcher` (alarme D+5/D+10)

**Points**: 2 | **Priority**: P0 | **Deps**: S-08.01..05 | **FR refs**: BR L-02, L-03, Spec 01 §1718

#### Contexto
Cron diário (09:00 BRT) que escaneia `lgpd_requests` ativas e:
- data_request com `now >= received_at + 5d úteis` AND `status != 'completed'` → alarme.
- redact com `now >= received_at + 10d úteis` AND `status != 'completed'` → alarme.

Alarmes vão pro Sentry com tags `{ request_id, organization_id, sla_bucket }` + email pro admin (DPO email do tenant + `LGPD_DPO_EMAIL` global). Idempotency: usa `lgpd_requests.metadata.last_alarm_at` pra não reenviar dentro de 24h.

#### Files to create
- `workers/cron/lgpd-sla-watcher.ts` — Inngest cron
- `lib/lgpd/sla-alarm.ts` — `triggerAlarm(request, threshold)` (Sentry + email)
- `tests/integration/lgpd-sla-watcher.test.ts`

#### Files to modify
- `vercel.json` ou `inngest.config.ts` — schedule `0 12 * * *` (UTC = 09:00 BRT)

#### Implementation steps
1. Cron 1×/dia 09:00 BRT.
2. SELECT lgpd_requests WHERE status NOT IN ('completed','failed') AND ((type='customer_data_request' AND received_at + 5 business days <= now) OR (type IN ('customer_redact','store_redact') AND received_at + 10 business days <= now)).
3. Pra cada uma: se `metadata.last_alarm_at` < 24h atrás, skip; senão, triggerAlarm + UPDATE metadata.last_alarm_at=now.
4. triggerAlarm: Sentry capture com `level='warning'` + tags + sanitized payload (sem PII) + Resend email pro DPO.
5. Audit `lgpd.sla_alarm_triggered` por request.

#### Acceptance Criteria

```gherkin
Given lgpd_requests row data_request received_at=hoje-6d_uteis, status='received'
When cron roda
Then Sentry recebe warning com tags { request_id, organization_id, type:'customer_data_request', sla_bucket:'overdue_warning' }
And email enviado pro DPO email do tenant
And metadata.last_alarm_at preenchido
And audit lgpd.sla_alarm_triggered registrado
```

```gherkin
Given mesma request alarmada há 3h
When cron roda novamente
Then skip (dedup 24h)
```

```gherkin
Given request status='completed'
When cron roda
Then ignorado (não alarma)
```

```gherkin
Given redact received_at=hoje-11d_uteis, status='processing'
When cron roda
Then alarme dispara (D+10 atingido)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | integration | Cron alarma D+5 data_request | seed + run cron + assert Sentry mock |
| t2 | integration | Cron alarma D+10 redact | idem |
| t3 | dedup | Skip se last_alarm_at <24h | seed + run 2× |
| t4 | observability | Sentry payload sem PII | inspect mock |
| t5 | email | Resend recebe email pro DPO | mock + assert |
| t6 | audit | sla_alarm_triggered gravado | SQL |

#### Architecture contracts emitted

```yaml
exposes:
  - type: cron
    id: "lgpd-sla-watcher"
    schedule: "0 12 * * * UTC (= 09:00 BRT)"
    consumes: "lgpd_requests table"
    output: "Sentry warning + email DPO + audit + metadata.last_alarm_at"
  - type: lib
    id: "lib/lgpd/sla-alarm.ts:triggerAlarm"
```

#### Decisões a registrar
- Dedup 24h via `metadata.last_alarm_at`. Após 24h re-alarma (escala diariamente).
- DPO email vem de `organizations.dpo_email` (fallback `LGPD_DPO_EMAIL` global).

#### Definition of Done
- [ ] ACs ok, integration test verde
- [ ] Cron registrado no Inngest e visível em /admin/inngest
- [ ] Commit `feat(EPIC-08): lgpd-sla-watcher cron [wave 8]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| Webhook receivers (HMAC, idempotency, SLA) | 12 | S-08.01/02/03 |
| Workers (export, redact, cascade SQL) | 14 | S-08.04/05 |
| UI rendering (lista, detalhe, timeline, banner) | 8 | S-08.06/07 |
| API contracts (GET requests, preview, approve) | 7 | S-08.06/07 |
| RLS isolation cross-tenant | 4 | S-08.01/06/07 |
| Permission gate (lgpd:execute) | 3 | S-08.06/07 |
| Audit dense (todas as 6 actions) | 6 | todas waves |
| Cron SLA watcher | 6 | S-08.08 |
| Sentry sanitization (zero PII) | 3 | S-08.04/05/08 |
| L-04 irreversibility (UPDATE 403) | 1 | S-08.05 |
| **Total** | **64** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| PAdES signing falha em prod (cert expirado) | Alta | Cron `cert-expiry-check` 7d antes; alarme Sentry; runbook renew documentado |
| Cascade SQL em scope=tenant trava DB com 100k contacts | Média | Batch 100 + checkpoint resumível; rate limit 1 batch/30s; staging test com 100k seed |
| Email LGPD vai pro spam | Média | Resend dedicated IP + DKIM/SPF; subject neutro; fallback signed URL no audit pra re-fetch |
| PII vaza no Sentry/logs | Crítica | sanitize wrapper obrigatório; lint rule `no-pii-in-log`; revisar Sentry breadcrumbs |
| Webhook Nuvemshop retry após 5s timeout do Vercel | Média | Receiver retorna 200 ANTES do processing (já no design); idempotency via webhook_events_log |
| Operador aprova redact errado (humano) | Alta | Confirm dialog + textarea reason + audit trail completo; redact é irreversível L-04 — não há undo |
| Orders preservados vazam dados pessoais | Média | Strip metadata pessoal nos orders; orders.contact_id permanece (FK) mas contact está anonymized |
| SLA computation errada por feriados não atualizados | Média | Lista feriados revisada anualmente; teste unit com 20+ cases edge |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-LGPD-01**: SLA é em **dias úteis BR**, não corridos. Lib `lib/lgpd/sla.ts` é fonte única; revisão anual de feriados.
- **ADR-LGPD-02**: PAdES via `node-signpdf` + P12 cert. Renovação anual responsabilidade Ops.
- **ADR-LGPD-03**: Receiver de webhook LGPD retorna 200 **antes** do processing — pipeline reativo via event obrigatório.
- **ADR-LGPD-04**: Orders são **preservadas** em redact (valor histórico fiscal) — apenas metadata pessoal stripped.
- **ADR-LGPD-05**: Cascade tenant é resumível via `lgpd_requests.metadata.progress`; `organizations.status='redacted'` somente ao final.
- **ADR-LGPD-06**: Approve manual emite o mesmo event que webhook — worker unificado.
- **ADR-LGPD-07**: Sanitize wrapper obrigatório em todo log/Sentry — CPF/email/phone hash SHA256 (L-08).
- **ADR-LGPD-08**: Signed URL de export expira em 72h; após isso, titular pede re-export.
- **ADR-LGPD-09**: Cron SLA dedup 24h via `metadata.last_alarm_at`.

## 9. Anexos

- Specs refs: 01 §8 (LGPD endpoints + layout export), 06 §5.6/5.7/5.8 (3 webhooks), 06 §7 (workers cascade), 06 §3.4 (webhook_events_log)
- Business rules: L-01 (anonimização preferida), L-02 (D+7 data_request), L-03 (D+15 redact), L-04 (irreversível), L-05 (consent), L-06 (audit), L-07 (CPF encrypted), L-08 (logs sem CPF), L-09 (token encrypted), L-10 (audit append-only 5y)
- Migration: `supabase/migrations/0011_lgpd_requests.sql`
- Reconciliation log: R-05 (Server Action `connectNuvemshop`)
- Screen flow refs: rotas `/app/lgpd/requests`, `/app/lgpd/requests/[id]`
- Audit actions canônicas: `lgpd.data_request_received`, `lgpd.redact_received`, `lgpd.store_redact_received`, `lgpd.export_generated`, `lgpd.export_delivered`, `lgpd.redact_executed`, `lgpd.redact_failed`, `lgpd.redact_skipped_already_anonymized`, `lgpd.sla_alarm_triggered`, `lgpd.manually_approved`
