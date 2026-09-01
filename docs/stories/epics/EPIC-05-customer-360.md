---
epic_id: EPIC-05-customer-360
epic_name: Customer 360 + Contacts
priority: P0
estimated_waves: 9
estimated_total_points: 28
depends_on: [EPIC-00, EPIC-01]
exposes_contracts:
  - "api.GET /api/v1/contacts"
  - "api.POST /api/v1/contacts"
  - "api.PATCH /api/v1/contacts/[id]"
  - "api.GET /api/v1/contacts/[id]"
  - "api.GET /api/v1/contacts/[id]/timeline"
  - "api.POST /api/v1/lgpd/anonymize"
  - "api.GET /api/v1/merge_queue"
  - "api.POST /api/v1/merge_queue/[id]/resolve"
  - "hook.useContact"
  - "hook.useTimeline"
  - "hook.useUpdateContact"
  - "hook.useAnonymizeContact"
  - "hook.useMergeQueue"
  - "ui.<TimelineView>"
  - "ui.<CustomFieldsEditor>"
  - "ui.<MergeDialog>"
  - "route./app/contacts"
  - "route./app/contacts/[id]"
status: completed
completion: partial
created_at: 2026-04-28
completed_at: 2026-04-28
owner: Songhai, Lda
deferred:
  - "S-05.01: CPF at-rest encryption (encrypt_cpf RPC missing) — deferred from Combo-A"
  - "S-05.01: Cursor HMAC signing — deferred"
  - "S-05.01: resolveContact dedup pipeline on POST — deferred"
  - "S-05.07: merge_queue resolve endpoint + full MergeDialog wiring — read-only scaffold delivered, mutation deferred"
---

## Wave Completion Log

- **2026-04-28** — Combo-A (waves 1, 2, 8): API CRUD `/api/v1/contacts`, timeline endpoint, LGPD anonymize endpoint shipped (commit 8eb5951). Documented deferrals: CPF encryption, cursor HMAC, resolveContact dedup pipeline.
- **2026-04-28** — Combo-B (waves 3, 4, 5, 6, 7, 9): UI layer shipped — hooks (`useContactList`, `useContact`, `useTimeline`, `useUpdateContact`, `useCreateContact`, `useAnonymizeContact`), `/app/contacts` list page with search/tag/source filters + cursor pagination, `/app/contacts/[id]` detail with overview/timeline/LGPD tabs, `<TimelineView>` with 5 source_modules + grouped-by-day rendering, `<NewContactDialog>` and `<EditContactDialog>` with Zod validation, `<AnonymizeDialog>` two-step confirmation, `<CustomFieldsEditor>` scaffolded for 10 field types (not wired yet — EPIC-09/10), `<MergeDialog>` read-only scaffold (resolve endpoint deferred), `<AnonymizedBanner>` integrated into detail page header. 5 contacts seeded for QA.


# EPIC-05 — Customer 360 + Contacts

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. Não pular ordem mesmo que pareça independente — `Deps:` é lei.
>
> Schema canônico (contacts, crm_lead_activities, crm_lead_links, merge_queue) é assumido aplicado pela Spec 02 §13 (migrations 020–035). Triggers `fn_update_last_activity_at`, `fn_emit_event_on_lead_change`, RLS, `decrypt_cpf` já existem. Este epic constrói **API + UI + workers leves** sobre esse schema.

## 1. Objetivo

Entregar Customer 360 funcional: lista e detalhe de contatos com timeline polimórfica unificada (whatsapp / nuvemshop / crm / ai / system), editor de custom fields dirigido por `pipeline.settings.fields`, fila de merge resolúvel por manager+, e endpoint LGPD de anonimização irreversível (regra L-04). Ao final, qualquer atendente acha um cliente em ≤1 search e vê a história completa em uma tela.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Atendente lista contatos em `/app/contacts` com search por name/email/phone/CPF e filtros tag+source, paginação cursor (HMAC, regra Spec 02 §9.3).
- [ ] Detalhe `/app/contacts/[id]` mostra ContactInfo + TimelineView (≥5 tipos polimórficos) + OrdersList + LeadsList em <500ms p95.
- [ ] PATCH em contact valida E.164 (regex `^\+\d{8,15}$`) e CPF (dígito verificador) com erro 422 estruturado.
- [ ] Custom Fields Editor lê `crm_pipelines.settings.fields[]` e renderiza form Zod-validado pros 10 tipos suportados (Spec 02 §6.2).
- [ ] Manager+ resolve item de `merge_queue` via diff side-by-side; merge atômico (transação serializável, Spec 02 §5.1) registra `api_audit_log.action='contact.merged'` e emite `event.contact.merged`.
- [ ] `POST /api/v1/lgpd/anonymize` cascateia em contact + leads (mantém id, nulifica PII) + activities (denorm contact_id preservado, payload mídia removido) + messages (mídia em Storage deletada) e seta `is_anonymized=true` irreversível (L-04).
- [ ] Contact com `is_anonymized=true` exibe banner sticky "Contato anonimizado (LGPD) — edição bloqueada" e todo PATCH retorna 403 `lgpd_anonymization_irreversible`.
- [ ] Agent (role 1) NÃO acessa `/app/contacts/[id]/merge`; manager+ (role ≥3) sim. RLS de `merge_queue` confirmado em test cross-tenant.
- [ ] Regression suite cumulativa passando (≥35 tests entre UI/API/RLS/event).

## 3. Pré-requisitos

- Epics anteriores completos: `EPIC-00`, `EPIC-01`.
- Migrations no Supabase: 0001-0035 aplicadas (Spec 01 + Spec 02 §13).
- Variáveis de env já configuradas: `CPF_ENCRYPTION_KEY`, `CURSOR_HMAC_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET_WHATSAPP_MEDIA`.
- Dev server rodando em `localhost:3001`.
- Playwright MCP conectado pra QA.
- Seeds: ao menos 1 organization com 50+ contacts mistos (com/sem CPF, com/sem phone), 200+ activities cobrindo ≥5 types distintos.

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | Via `useAuth()` hook |
| `hook.usePermission` | react_hook | EPIC-01 | Gate de UI manager+ |
| `hook.useApiClient` | react_hook | EPIC-00 | HTTP wrapper c/ idempotency-key |
| `infra.tanstack-query` | infra | EPIC-00 | Cache layer canônico (ADR-01 Spec 09) |
| `lib.toast` | lib | EPIC-00 | sonner pra success/error |
| `lib.phosphor` | lib | EPIC-00 | Icons da timeline |
| `db.contacts` | db_table | migration 022 | RLS via `fn_user_org_ids()`; `decrypt_cpf()` para read CPF |
| `db.crm_leads` | db_table | migration 025 | FK contact_id |
| `db.crm_lead_activities` | db_table | migration 026 | Timeline polimórfica (append-only) |
| `db.crm_lead_links` | db_table | migration 027 | Lead↔order, lead↔conversation |
| `db.merge_queue` | db_table | migration 028 | Fila de candidatos ambíguos (manager+ only) |
| `service.resolveContact` | server_service | Spec 02 §4.4 | Reusado por `POST /contacts` em conflito |
| `service.mergeContacts` | server_service | Spec 02 §5 | Chamado por endpoint de merge |
| `lib.fn_log_event` | sql_function | EPIC-00 | Insert em event_log |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `api.GET /api/v1/contacts` | api_route | S-05.01 | Query: `search,tag,source,cursor,limit`. Returns `{ data: Contact[], next_cursor }` |
| `api.POST /api/v1/contacts` | api_route | S-05.01 | Body `ContactCreate`, returns `Contact`. Em conflito (E11000-like) chama `resolveContact` e devolve `{ contact, action: 'matched'\|'created'\|'merge_pending' }` |
| `api.PATCH /api/v1/contacts/[id]` | api_route | S-05.01 | 403 se `is_anonymized=true` |
| `api.GET /api/v1/contacts/[id]` | api_route | S-05.01 | Inclui `decrypt_cpf` opcional via header `X-Decrypt-Purpose` |
| `api.GET /api/v1/contacts/[id]/timeline` | api_route | S-05.02 | Query: `cursor,limit,type[]`. Polimórfica via `crm_lead_activities` joined com `contact_id` direto OU via leads do contact |
| `api.GET /api/v1/merge_queue` | api_route | S-05.07 | manager+ only; lista pending |
| `api.POST /api/v1/merge_queue/[id]/resolve` | api_route | S-05.07 | Body `{ primary_id, action: 'merge'\|'discard' }` |
| `api.POST /api/v1/lgpd/anonymize` | api_route | S-05.08 | Body `{ contact_id, justification }`. Idempotente. Emite `event.contact.anonymized` |
| `hook.useContact` | react_hook | S-05.04 | `useContact(id) → { data, isLoading, error }` |
| `hook.useTimeline` | react_hook | S-05.04 | `useTimeline(contactId, { types?, limit? }) → infinite query` |
| `hook.useUpdateContact` | react_hook | S-05.04 | Mutation com optimistic update + invalida `contacts`, `contact:[id]` |
| `hook.useAnonymizeContact` | react_hook | S-05.08 | Mutation; UI exige confirm dupla |
| `hook.useMergeQueue` | react_hook | S-05.07 | `useMergeQueue() → list` + `useResolveMerge()` |
| `ui.<TimelineView>` | react_component | S-05.05 | Props `{ contactId, types?, height? }`. Renderer polimórfico |
| `ui.<CustomFieldsEditor>` | react_component | S-05.06 | Props `{ pipelineId, value, onChange, mode: 'lead'\|'contact' }` |
| `ui.<MergeDialog>` | react_component | S-05.07 | Props `{ queueItemId, onResolved }` |
| `route./app/contacts` | route | S-05.03 | Lista |
| `route./app/contacts/[id]` | route | S-05.04 | Detalhe |
| `event.contact.anonymized` | domain_event | S-05.08 | Payload `{ contact_id, actor_user_id, justification }`. Workers Spec 06/07 invalidam caches |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave do epic-executor. Wave 1 = primeira story; wave N = última.

---

### S-05.01 — API CRUD `/api/v1/contacts` (4 routes + validação E.164/CPF)

**Points**: 4 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 02 §2.1, §4, §9; BR L-04, L-07

#### Contexto
Primeira camada do epic é a API de contacts. **Tudo** que vem depois (lista, detalhe, timeline, merge, anonymize) consome estas 4 rotas. Validação E.164 e CPF acontece no boundary (Zod) antes de tocar DB — DB tem check constraint redundante (defesa em profundidade). PATCH respeita L-04 retornando 403 quando `is_anonymized=true`.

#### Files to create
- `src/app/api/v1/contacts/route.ts` — GET (list+filters), POST (create via `resolveContact`)
- `src/app/api/v1/contacts/[id]/route.ts` — GET (with optional CPF decrypt), PATCH
- `src/server/services/contacts/listContacts.ts` — query builder com cursor HMAC
- `src/server/services/contacts/upsertContact.ts` — wrapper sobre `resolveContact` p/ POST
- `src/server/services/contacts/updateContact.ts` — guard L-04 + audit
- `src/server/services/contacts/schemas.ts` — Zod (`ContactCreate`, `ContactPatch`, `ContactListQuery`)
- `src/server/services/identity/normalize.ts` — `normalizeE164`, `isValidCpf`, `hashCpf`, `encryptCpf` (se ainda não existir)

#### Files to modify
- `src/server/services/identity/resolveContact.ts` — confirma export (já especificado em Spec 02 §4.4)

#### Implementation steps (sequential)
1. Criar `normalize.ts` com `normalizeE164` (libphonenumber-js, region BR default), `isValidCpf` (dígito verificador), `hashCpf` (sha256 hex).
2. Criar `schemas.ts` com Zod canônico: `phone_number: z.string().regex(/^\+\d{8,15}$/)`, `cpf: z.string().refine(isValidCpf)`, `email: z.string().email()`.
3. Implementar `GET /api/v1/contacts` com filters: `search` (ILIKE em name/email/phone, ou cpf_hash se input parece CPF), `tag` (array contains), `source`, `cursor`, `limit ≤ 100`.
4. Implementar `POST /api/v1/contacts` chamando `resolveContact` — devolve 200 com `action` discriminado quando match, 201 quando created, 202 quando merge_pending (com `Location: /app/contacts/merge_queue/[queue_id]`).
5. Implementar `GET /api/v1/contacts/[id]` retornando contact + flag `cpf_available`. Se header `X-Decrypt-Purpose` presente, chama `decrypt_cpf(contact_id)` (audit automático na função SQL).
6. Implementar `PATCH /api/v1/contacts/[id]`: SELECT com `is_anonymized` primeiro; se true → 403 `lgpd_anonymization_irreversible`. Senão valida payload e UPDATE.
7. Adicionar middleware de audit em PATCH (L-06): registra diff de `email/phone_number/cpf/consent` em `api_audit_log`.

#### Acceptance Criteria (testáveis)

```gherkin
Given um tenant com 0 contacts
When POST /api/v1/contacts com { email: "joao@x.com", phone: "+5511999998888", name: "João" }
Then retorna 201 com { contact, action: "created" }
And contact.phone_number == "+5511999998888"
And event_log tem 1 linha "contact.created"
```

```gherkin
Given um contact existente com phone "+5511999998888"
When POST /api/v1/contacts com mesmo phone e email diferente
Then retorna 200 com { action: "matched", confidence: "high", matched_by: "phone_e164" }
```

```gherkin
Given um contact com is_anonymized=true
When PATCH /api/v1/contacts/[id] com { name: "X" }
Then retorna 403 { error: "lgpd_anonymization_irreversible" }
```

```gherkin
Given POST /api/v1/contacts com phone "11999998888" (sem +55)
Then retorna 422 { error: "phone_must_be_e164" }
```

```gherkin
Given POST /api/v1/contacts com cpf "111.111.111-11" (dígito inválido)
Then retorna 422 { error: "invalid_cpf" }
```

```gherkin
Given GET /api/v1/contacts?search=joao&limit=20
Then retorna data ≤ 20, next_cursor presente se houver mais
And cursor é assinado HMAC; corromper a sig retorna 400 cursor_invalid_signature
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | POST cria contact | curl -d '{...}' /api/v1/contacts; espera 201 |
| t2 | api | POST conflito phone vira matched | seed phone; POST mesmo; espera 200 + action=matched |
| t3 | api | PATCH bloqueado em anonymized | seed is_anonymized=true; PATCH; espera 403 |
| t4 | api | E.164 inválido → 422 | POST phone="11999"; espera 422 |
| t5 | api | CPF inválido → 422 | POST cpf="111.111.111-11"; espera 422 |
| t6 | rls | Tenant A não vê contacts B | autenticar como A; GET retorna só os de A |
| t7 | api | Cursor pagination roundtrip | GET com cursor decoda last_seen, retorna próximo lote |
| t8 | db | CPF persistido encrypted | SELECT cpf_encrypted IS NOT NULL AND cpf_hash IS NOT NULL |
| t9 | audit | PATCH gera api_audit_log | UPDATE email; verifica linha em api_audit_log com diff |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "GET /api/v1/contacts"
    request_schema: "?search,tag,source,cursor,limit"
    response_schema: "{ data: Contact[], next_cursor: string|null }"
  - type: api_route
    id: "POST /api/v1/contacts"
    request_schema: "{ email?, phone?, cpf?, name?, source, source_metadata? }"
    response_schema: "{ data: { contact, action, confidence?, matched_by?, queue_id? } }"
    error_codes: [phone_must_be_e164, invalid_cpf, invalid_email, forbidden_org]
  - type: api_route
    id: "GET /api/v1/contacts/[id]"
    response_schema: "{ data: Contact, cpf_available: boolean, cpf?: string }"
  - type: api_route
    id: "PATCH /api/v1/contacts/[id]"
    error_codes: [lgpd_anonymization_irreversible, phone_must_be_e164, invalid_cpf]
```

#### Decisões a registrar
- "POST /contacts é roteado por `resolveContact` SEMPRE — nunca insert direto, mesmo em UI 'criar manualmente'. Garante idempotência cross-source."
- "Header `X-Decrypt-Purpose` é OBRIGATÓRIO pra GET retornar CPF descriptografado; ausente → cpf nunca volta no payload."

#### Definition of Done
- [ ] Todos os ACs passam em Playwright/curl
- [ ] Typecheck zero erros novos
- [ ] Lint zero erros novos
- [ ] Sem warnings no console
- [ ] Commit `feat(EPIC-05): contacts API CRUD + identity validation [wave 1]`
- [ ] Architecture contracts registrados no state file
- [ ] Sem regressão em waves anteriores

---

### S-05.02 — API `GET /api/v1/contacts/[id]/timeline` (polimórfica)

**Points**: 3 | **Priority**: P0 | **Deps**: S-05.01 | **FR refs**: Spec 02 §2.5, §10

#### Contexto
Timeline é a fonte gravitacional do Customer 360. Lê `crm_lead_activities` filtrando por `(organization_id, contact_id)` (denorm já populado). Suporta filtros `type[]` e cursor pagination ordenado por `performed_at DESC`. Append-only no DB (Spec 02 §2.5) — endpoint NÃO expõe POST. Activities são criadas por triggers/workers de outros epics (whatsapp em E03, nuvemshop em E07, ai em E06).

#### Files to create
- `src/app/api/v1/contacts/[id]/timeline/route.ts` — GET only
- `src/server/services/contacts/getTimeline.ts` — query + cursor encoding

#### Files to modify
- (none)

#### Implementation steps (sequential)
1. Validar `contact_id` pertence ao tenant via RLS (SELECT 1 from contacts retorna ou 404).
2. Query base: `select * from crm_lead_activities where organization_id = $1 and contact_id = $2 order by performed_at desc limit $3 + 1`.
3. Filter opcional `type IN (...)` via array param `?type=whatsapp_inbound&type=nuvemshop_order_created`.
4. Cursor encoda `(performed_at_iso, id)` HMAC-signed (mesmo formato S-05.01).
5. Decodificar cursor: `WHERE (performed_at, id) < (cursor.performed_at, cursor.id)` (tuple comparison estável).
6. Limite hard 100, default 30.

#### Acceptance Criteria

```gherkin
Given contact com 50 activities mistas
When GET /api/v1/contacts/[id]/timeline?limit=20
Then retorna 20 ordenadas DESC por performed_at, next_cursor presente
```

```gherkin
Given timeline com types whatsapp_inbound, nuvemshop_order_created, ai_responded
When GET ...?type=whatsapp_inbound&type=ai_responded
Then retorna apenas activities desses 2 types
```

```gherkin
Given contact de tenant A
When user de tenant B chama GET /api/v1/contacts/[id]/timeline
Then retorna 404 (RLS isolation)
```

```gherkin
Given GET timeline page 1 com next_cursor
When chamada page 2 com esse cursor
Then activities não se repetem entre páginas (tuple compare estável)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Retorna timeline DESC | seed 50 activities; GET; verifica ordem |
| t2 | api | Filter por type funciona | GET ?type=X; só X retorna |
| t3 | rls | Cross-tenant 404 | tenant B autenticado; espera 404 |
| t4 | api | Cursor estável (sem duplicate) | page1+page2; intersect=∅ |
| t5 | api | Limit hard cap 100 | ?limit=500; retorna 100 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "GET /api/v1/contacts/[id]/timeline"
    request_schema: "?type[]=...,cursor,limit"
    response_schema: "{ data: Activity[], next_cursor }"
```

#### Decisões a registrar
- "Cursor de timeline usa tuple `(performed_at, id)` pra evitar instabilidade quando há activities com mesmo timestamp."

#### Definition of Done
- [ ] ACs passam
- [ ] Typecheck/lint OK
- [ ] Commit `feat(EPIC-05): contacts timeline API [wave 2]`

---

### S-05.03 — Page `/app/contacts` (lista + search + filtros + infinite scroll)

**Points**: 3 | **Priority**: P0 | **Deps**: S-05.01 | **FR refs**: Spec 02 §9; Spec 09 (TanStack Query)

#### Contexto
Lista de contatos é a porta de entrada da feature. Search debounced detecta automaticamente formato (email/phone/CPF) e roteia query. Filtros por tag (multiselect) e source (select). Infinite scroll via `useInfiniteQuery` consumindo cursor da API.

#### Files to create
- `src/app/(app)/contacts/page.tsx` — server component shell
- `src/app/(app)/contacts/_components/ContactsList.tsx` — client w/ infinite scroll
- `src/app/(app)/contacts/_components/ContactsFilters.tsx` — search + tag + source
- `src/app/(app)/contacts/_components/ContactRow.tsx` — linha (avatar + name + email/phone + last_activity_at + tags)
- `src/client/hooks/useContacts.ts` — `useInfiniteQuery` wrapper

#### Files to modify
- `src/client/components/sidebar/SidebarNav.tsx` — adiciona link "Contatos"

#### Implementation steps (sequential)
1. `useContacts({ search, tags, source })` retorna `useInfiniteQuery` com `getNextPageParam: lp => lp.next_cursor`.
2. Search input debounced 300ms; detecta CPF (regex `\d{3}\.?\d{3}\.?\d{3}-?\d{2}`) e formata antes de mandar; phone (regex `\+?\d{10,}`) também.
3. Tag filter usa `<TagPicker>` consumindo lista distinta de tags (subquery ou settings).
4. Infinite scroll via IntersectionObserver no último row.
5. Empty state ilustrado (regra Spec 09 §empty-state).
6. Loading: skeleton de 6 rows.
7. Cada row: link pra `/app/contacts/[id]`; avatar usa initials se sem photo_url.

#### Acceptance Criteria

```gherkin
Given /app/contacts com 100 contacts seed
When página carrega
Then renderiza 30 primeiros, "Carregando..." infinito ao scroll
And p95 first paint < 400ms
```

```gherkin
Given search "joao"
When digito (debounce 300ms)
Then lista filtrada após 1 request
```

```gherkin
Given filter tag "vip"
When clico tag
Then lista mostra apenas contacts com tag vip
```

```gherkin
Given search "12345678900" (CPF dígitos)
When backend recebe
Then query usa cpf_hash match (não ILIKE em name)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Lista renderiza | Playwright getByRole('row') count > 0 |
| t2 | ui | Infinite scroll dispara | scroll; espera 2ª página carregar |
| t3 | ui | Search debounced | digitar 5 chars; só 1 fetch |
| t4 | ui | Filter tag funciona | click chip; lista filtra |
| t5 | ui | Empty state | tenant 0 contacts; renderiza ilustração |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/contacts"
  - type: react_hook
    id: "useContacts"
    signature: "({ search?, tags?, source? }) => UseInfiniteQueryResult<ContactsPage>"
```

#### Definition of Done
- [ ] ACs Playwright passam
- [ ] Skeleton e empty state implementados
- [ ] Typecheck/lint OK
- [ ] Commit `feat(EPIC-05): contacts list page [wave 3]`

---

### S-05.04 — Page `/app/contacts/[id]` (detalhe + sub-componentes)

**Points**: 4 | **Priority**: P0 | **Deps**: S-05.02, S-05.03 | **FR refs**: Spec 02 §2.6, §5

#### Contexto
Tela "ouro" do Customer 360. Layout: header (avatar, nome, badges status/blocked/anonymized) + 2 colunas: esquerda ContactInfo (phone, email, CPF gated, consent, tags, custom fields), direita TimelineView; abaixo grid OrdersList (de `crm_lead_links` target=order) + LeadsList (de crm_leads contact_id).

#### Files to create
- `src/app/(app)/contacts/[id]/page.tsx` — server component
- `src/app/(app)/contacts/[id]/_components/ContactHeader.tsx`
- `src/app/(app)/contacts/[id]/_components/ContactInfo.tsx`
- `src/app/(app)/contacts/[id]/_components/OrdersList.tsx`
- `src/app/(app)/contacts/[id]/_components/LeadsList.tsx`
- `src/client/hooks/useContact.ts`
- `src/client/hooks/useTimeline.ts`
- `src/client/hooks/useUpdateContact.ts`

#### Files to modify
- (none)

#### Implementation steps (sequential)
1. `useContact(id)` query simples; `staleTime: 30s`.
2. `useTimeline(contactId, { types? })` infinite query baseada em S-05.02.
3. `useUpdateContact` — mutation; `onMutate` aplica optimistic update; `onError` rollback; invalida `['contact', id]` e `['contacts']`.
4. ContactInfo: cada campo inline-editable; botão "Mostrar CPF" dispara request com header `X-Decrypt-Purpose: agent_view` e exibe por 30s antes de re-mascarar.
5. OrdersList: query separada `GET /api/v1/contacts/[id]/orders` (cria endpoint trivial que faz join via crm_lead_links target_kind='order').
6. LeadsList: `GET /api/v1/leads?contact_id=[id]` (consome contract de EPIC-04).
7. Layout responsivo: 2 colunas ≥lg, stack <md.

#### Acceptance Criteria

```gherkin
Given contact com 3 orders e 2 leads
When abro /app/contacts/[id]
Then header + ContactInfo + TimelineView + OrdersList(3) + LeadsList(2) renderizam
And p95 < 500ms (com seed)
```

```gherkin
Given clico "Mostrar CPF"
When backend valida purpose
Then CPF aparece descriptografado por 30s
And api_audit_log tem 'contact.cpf_decrypted'
```

```gherkin
Given edito phone inline com formato inválido
When tento salvar
Then UI mostra erro 422; valor antigo mantido (rollback otimistic)
```

```gherkin
Given outro user (tenant B) tenta /app/contacts/[id_de_A]
Then retorna 404 (server component)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Header renderiza | Playwright getByText(name) |
| t2 | ui | Timeline carrega | Timeline visível + ≥1 item |
| t3 | ui | OrdersList linka pedidos | click order → navega |
| t4 | ui | LeadsList linka leads | click → navega |
| t5 | api | CPF decrypt audita | inspect api_audit_log |
| t6 | ui | Optimistic rollback | falhar PATCH; UI volta valor antigo |
| t7 | rls | Cross-tenant 404 | tenant B GET; 404 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/contacts/[id]"
  - type: react_hook
    id: "useContact"
    signature: "(id) => UseQueryResult<Contact>"
  - type: react_hook
    id: "useTimeline"
    signature: "(contactId, options?) => UseInfiniteQueryResult<TimelinePage>"
  - type: react_hook
    id: "useUpdateContact"
    signature: "() => UseMutationResult<Contact, Error, ContactPatch>"
```

#### Decisões a registrar
- "ContactInfo edita inline com optimistic; toast de sucesso só dispara após server confirm."

#### Definition of Done
- [ ] ACs passam
- [ ] Typecheck/lint OK
- [ ] Commit `feat(EPIC-05): contact detail page + hooks [wave 4]`

---

### S-05.05 — `<TimelineView>` polymorphic renderer

**Points**: 3 | **Priority**: P0 | **Deps**: S-05.04 | **FR refs**: Spec 02 §10 (catálogo de events)

#### Contexto
Componente que renderiza N tipos distintos de activity numa lista vertical com ícone + descrição contextual + timestamp relativo. Tipos canônicos cobertos no MVP: `whatsapp_inbound`, `whatsapp_outbound`, `nuvemshop_order_created`, `nuvemshop_order_paid`, `nuvemshop_order_cancelled`, `ai_responded`, `handoff_triggered`, `system.contact_blocked_by_stop`, `lead.created`, `lead.stage_changed`, `lead.won`, `lead.lost`. Renderer extensível via map `type → Renderer`.

#### Files to create
- `src/client/components/TimelineView/TimelineView.tsx` — orchestrator
- `src/client/components/TimelineView/renderers/index.ts` — registry
- `src/client/components/TimelineView/renderers/WhatsAppRenderer.tsx`
- `src/client/components/TimelineView/renderers/NuvemshopRenderer.tsx`
- `src/client/components/TimelineView/renderers/AiRenderer.tsx`
- `src/client/components/TimelineView/renderers/CrmRenderer.tsx`
- `src/client/components/TimelineView/renderers/SystemRenderer.tsx`
- `src/client/components/TimelineView/TimelineItem.tsx` — wrapper genérico (ícone, time, slot)
- `src/client/components/TimelineView/types.ts`

#### Files to modify
- `src/app/(app)/contacts/[id]/page.tsx` — usa `<TimelineView>`

#### Implementation steps (sequential)
1. Definir union type `Activity` discriminado por `(source_module, type)`.
2. Registry `RENDERERS: Record<string, ComponentType<{ activity }>>` com fallback `<UnknownRenderer>` (renderiza JSON colapsado em modo dev).
3. Cada renderer recebe `activity` e retorna conteúdo dentro de `<TimelineItem>`.
4. WhatsAppRenderer: ícone phosphor `WhatsappLogo`, mostra body truncado (preview 80 chars) + "ver mensagem" → linka conversation Spec 03.
5. NuvemshopRenderer: ícone `ShoppingCart`, mostra `order_number` + valor + status; link pra order.
6. AiRenderer: ícone `Robot`, mostra `intent` + `confidence`; em handoff_triggered usa cor de alerta.
7. CrmRenderer (lead.* events): mostra "Movido de Stage X → Y" usando `usePipelineVocabulary`.
8. Timestamp relativo via `date-fns/formatDistanceToNowStrict` em pt-BR.
9. Group-by-day separator (sticky header "Hoje" / "Ontem" / "DD/MM/YYYY").
10. Filter UI dropdown multi-select de types (passa pra `useTimeline`).

#### Acceptance Criteria

```gherkin
Given timeline com 1 activity de cada um dos 12 types canônicos
When renderiza
Then todos renderizam com ícone + texto correto, sem cair em UnknownRenderer
```

```gherkin
Given activity ai_responded
When renderiza
Then mostra ícone Robot + intent + badge confidence
```

```gherkin
Given activity de tipo "future_unknown_type"
When renderiza
Then UnknownRenderer renderiza placeholder "Atividade desconhecida" sem crashar
```

```gherkin
Given filtro types=[whatsapp_inbound]
When aplico
Then só inbound aparecem; outros somem
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | 12 types renderizam | seed 12; visual snapshot |
| t2 | ui | Unknown não crasha | type fake; sem error boundary trigger |
| t3 | ui | Filter dropdown filtra | click; refetch com types[] |
| t4 | ui | Group-by-day separator | seed dias diferentes; vê header sticky |
| t5 | ui | Timestamp pt-BR | vê "há 2 horas" |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<TimelineView>"
    props: "{ contactId: string, types?: string[], height?: number }"
    file: "src/client/components/TimelineView/TimelineView.tsx"
```

#### Decisões a registrar
- "Renderer registry é fonte única de verdade — adicionar novo type = adicionar entry no map. Workers de outros epics que emitem novo type DEVEM atualizar o registry no mesmo PR."

#### Definition of Done
- [ ] ACs passam
- [ ] Typecheck/lint OK
- [ ] Commit `feat(EPIC-05): polymorphic TimelineView [wave 5]`

---

### S-05.06 — Custom Fields Editor

**Points**: 3 | **Priority**: P0 | **Deps**: S-05.04 | **FR refs**: Spec 02 §6

#### Contexto
Editor lê `crm_pipelines.settings.fields[]` (schema declarativo, Spec 02 §6.1) e gera form Zod-validado dinamicamente. 10 tipos suportados: text, textarea, number, currency, date, boolean, select, multiselect, url, email. Usado em duas superfícies: lead detail (custom fields do lead) e contact detail (em uma pipeline default da org). MVP: lead-only no consumo direto desta wave; mode='contact' fica registrado mas pode ser exposto em E07.

#### Files to create
- `src/client/components/CustomFieldsEditor/CustomFieldsEditor.tsx`
- `src/client/components/CustomFieldsEditor/fieldRenderers/`
  - `TextField.tsx`, `TextareaField.tsx`, `NumberField.tsx`, `CurrencyField.tsx`, `DateField.tsx`, `BooleanField.tsx`, `SelectField.tsx`, `MultiselectField.tsx`, `UrlField.tsx`, `EmailField.tsx`
- `src/shared/customFields/buildSchema.ts` — `buildLeadCustomFieldsSchema(fields)` (Spec 02 §6.3)
- `src/client/hooks/usePipelineFields.ts`

#### Files to modify
- `src/app/api/v1/leads/[id]/route.ts` — PATCH usa `buildLeadCustomFieldsSchema` no save (já especificado §6.4 mas implementação concreta aqui)
- `src/app/api/v1/contacts/[id]/route.ts` — idem opcional (mode contact)

#### Implementation steps (sequential)
1. `buildLeadCustomFieldsSchema(fields)` exatamente como Spec 02 §6.3 (`.strict()` rejeita keys desconhecidas).
2. `usePipelineFields(pipelineId)` busca via `GET /api/v1/pipelines/[id]` e retorna `fields[]` filtrando `deprecated=false`.
3. `<CustomFieldsEditor>` renderiza grid 2-col; cada field via renderer correspondente; valida onSubmit usando schema gerado.
4. react-hook-form + `@hookform/resolvers/zod` integrando schema dinâmico.
5. Erros 422 do server (`field_value_not_in_options`, `field_required`, `field_unknown_key`) mapeados pro form context (setError no campo específico).
6. Mode='lead': onSubmit chama PATCH /leads/:id com `custom_fields` partial. Mode='contact' fica stub TODO.
7. Field deprecated: NÃO renderiza, mas mantém valor existente no payload (não apaga).

#### Acceptance Criteria

```gherkin
Given pipeline com fields [{key:'tamanho',type:'select',options:['P','M','G'],required:true}]
When abro editor
Then renderiza select com 3 options
And submit sem valor → erro inline "field_required"
```

```gherkin
Given field type=currency
When digito 99.50
Then store envia 9950 (cents)
```

```gherkin
Given field type=multiselect com options [A,B,C]
When seleciono [A,B]
Then payload {"key":["A","B"]}
```

```gherkin
Given field deprecated=true com valor "old"
When editor renderiza
Then field não aparece
And submit preserva "old" no payload
```

```gherkin
Given submit com key não declarada
When server valida com .strict()
Then retorna 422 field_unknown_key
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | 10 tipos renderizam | seed pipeline com 1 field de cada; vê todos |
| t2 | ui | Required dispara erro | submit vazio; vê erro inline |
| t3 | api | strict() rejeita key extra | PATCH com campo fantasma; 422 |
| t4 | ui | Currency converte cents | input 10.00; payload 1000 |
| t5 | ui | Deprecated não renderiza | flag true; field oculto; valor preservado |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<CustomFieldsEditor>"
    props: "{ pipelineId, value, onChange, mode: 'lead'|'contact' }"
    file: "src/client/components/CustomFieldsEditor/CustomFieldsEditor.tsx"
  - type: lib
    id: "buildLeadCustomFieldsSchema"
    signature: "(fields: PipelineFieldDefinition[]) => z.ZodObject"
```

#### Decisões a registrar
- "Field deprecated nunca renderiza, mas valor é preservado no payload — não apaga histórico."

#### Definition of Done
- [ ] ACs passam
- [ ] Typecheck/lint OK
- [ ] Commit `feat(EPIC-05): custom fields editor [wave 6]`

---

### S-05.07 — Merge Queue resolution (manager+ only)

**Points**: 4 | **Priority**: P0 | **Deps**: S-05.04 | **FR refs**: Spec 02 §5; RLS §2.9

#### Contexto
Quando `resolveContact` encontra ambiguidade, enfileira em `merge_queue`. Manager+ resolve via UI: lista pending items, abre dialog com diff side-by-side dos candidatos, escolhe primary (com sugestão automática "primary wins" Spec 02 §5.2), executa merge atômico via `mergeContacts` (já em service, Spec 02 §5.1) ou descarta. RLS bloqueia agent (role 1).

#### Files to create
- `src/app/api/v1/merge_queue/route.ts` — GET (list pending)
- `src/app/api/v1/merge_queue/[id]/resolve/route.ts` — POST
- `src/app/(app)/contacts/merge_queue/page.tsx` — lista
- `src/client/components/MergeDialog/MergeDialog.tsx` — diff side-by-side
- `src/client/components/MergeDialog/DiffRow.tsx` — linha de comparação
- `src/client/hooks/useMergeQueue.ts`
- `src/client/hooks/useResolveMerge.ts`
- `src/server/services/contacts/pickPrimary.ts` — algoritmo Spec 02 §5.2

#### Files to modify
- `src/client/components/sidebar/SidebarNav.tsx` — link "Merge Queue" gated por `usePermission('manager+')` com badge de count pending

#### Implementation steps (sequential)
1. `pickPrimary(candidates)` retorna ranking 1..N seguindo §5.2 (completude > created_at ASC > last_activity_at DESC > UUID).
2. `GET /api/v1/merge_queue?status=pending` retorna lista com snapshot dos candidates expandidos.
3. `POST /api/v1/merge_queue/[id]/resolve` com body `{ action: 'merge'|'discard', primary_id?, loser_ids? }`. Action 'merge' chama `mergeContacts({primary_id, loser_ids, actor_user_id, reason: 'merge_queue_resolved'})`. Action 'discard' apenas seta `status='discarded'`. Ambos requerem role ≥3 (RLS já cobre, redundância no handler).
4. `<MergeDialog>` usa Tabs ou grid 2/3 colunas (depende do número de candidates) com toggle "Primary" (default = sugerido). DiffRow destaca campos divergentes em amber.
5. Confirm dupla antes de submit ("Esta ação é irreversível").
6. Após resolve: invalida `useMergeQueue`, navega pro contact primary, mostra toast "Mesclados N contatos em [name]".
7. Realtime: subscribe a `postgres_changes` em `merge_queue` filter `organization_id` → invalida list.

#### Acceptance Criteria

```gherkin
Given merge_queue com 1 pending (2 candidates A,B)
When manager abre dialog
Then vê diff side-by-side, "primary sugerido" marcado em A
```

```gherkin
Given confirmo merge com primary=A
When request commits
Then mergeContacts roda em transação serializável
And contact B fica com is_merged_into=A, is_anonymized=true
And api_audit_log tem 'contact.merged' com before_state
And event_log tem 'contact.merged'
```

```gherkin
Given user role=agent (1)
When chama POST /api/v1/merge_queue/[id]/resolve
Then retorna 403
And RLS bloqueia query SELECT em merge_queue
```

```gherkin
Given action='discard'
When commits
Then merge_queue.status='discarded', nenhum contact alterado
```

```gherkin
Given após merge
When abro contact perdedor (B)
Then GET retorna 410 com Location header pro primary
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | rls | Agent não vê merge_queue | autenticar role=1; SELECT vazio |
| t2 | api | manager+ vê pending | autenticar role=3; lista populada |
| t3 | api | merge atômico | POST resolve; verifica savepoints todos commitados |
| t4 | api | Merge falha → rollback | mock erro em SP3; nada persistido |
| t5 | ui | Diff destaca divergências | renderizar; campos diff têm amber |
| t6 | ui | Confirm dupla | sem confirm; submit não dispara |
| t7 | api | Loser GET → 410 | após merge; GET; espera 410 + Location |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "GET /api/v1/merge_queue"
    response_schema: "{ data: MergeQueueItem[] }"
  - type: api_route
    id: "POST /api/v1/merge_queue/[id]/resolve"
    request_schema: "{ action: 'merge'|'discard', primary_id?, loser_ids? }"
    error_codes: [forbidden_role, primary_in_losers, contacts_not_found, primary_anonymized]
  - type: react_hook
    id: "useMergeQueue"
  - type: react_hook
    id: "useResolveMerge"
  - type: react_component
    id: "<MergeDialog>"
```

#### Decisões a registrar
- "Merge é irreversível na UI; banco preserva snapshot em api_audit_log.metadata.before_state pra auditoria humana."

#### Definition of Done
- [ ] ACs passam
- [ ] Typecheck/lint OK
- [ ] Commit `feat(EPIC-05): merge_queue resolution UI + API [wave 7]`

---

### S-05.08 — `POST /api/v1/lgpd/anonymize` (cascade irreversível)

**Points**: 3 | **Priority**: P0 | **Deps**: S-05.07 | **FR refs**: BR L-04; Spec 02 §5.4 (tombstone analog)

#### Contexto
Endpoint dedicado pro direito ao esquecimento. Diferente de merge: contact mantém id (pra integridade referencial de leads/activities/orders), mas todo PII é nulificado, e mídias em Storage são deletadas. `is_anonymized=true` é set irreversível (check constraint Spec 02 §2.1 + guard L-04 em PATCH). Idempotente: chamada repetida não falha, retorna 200 com `already_anonymized=true`.

#### Files to create
- `src/app/api/v1/lgpd/anonymize/route.ts` — POST
- `src/server/services/lgpd/anonymizeContact.ts`
- `src/client/hooks/useAnonymizeContact.ts`

#### Files to modify
- (none)

#### Implementation steps (sequential)
1. `anonymizeContact(args: { organization_id, contact_id, actor_user_id, justification })` em transação:
   - SELECT contact; if `is_anonymized` → return `{ already_anonymized: true }`.
   - UPDATE contacts SET name=null, display_name=null, email=null, phone_number=null, cpf_encrypted=null, cpf_hash=null, birthdate=null, tags='{}', source_metadata='{}', is_anonymized=true, anonymized_at=now().
   - Listar leads do contact: para cada lead, blur: `title=COALESCE('Lead anonimizado', null)`, `description=null`, `custom_fields='{}'`, `external_id=null` (mantém position e stage e status histórico).
   - Em activities (`crm_lead_activities` where contact_id): UPDATE payload removendo chaves `body`, `text`, `media_url`, `customer_*`; mantém `type`, `performed_at`, `source_module` (estatísticas legítimas).
   - Em messages (Spec 03): UPDATE body=null, media_url=null; storage worker enfileira delete da mídia (event `lgpd.media_purge_requested`).
   - Insert api_audit_log `action='contact.anonymized'`, `metadata={justification, before_state_summary}`.
   - Insert event_log `event='contact.anonymized'`.
2. POST handler valida role ≥3 (manager+), body Zod `{ contact_id: uuid, justification: z.string().min(10) }`.
3. Hook `useAnonymizeContact` mutation; UI requer confirm dupla com input "ANONIMIZAR" pra liberar botão.
4. Pós-success: redireciona pra detalhe do contact (que agora exibe banner — S-05.09).

#### Acceptance Criteria

```gherkin
Given contact com 3 leads, 50 activities, 10 messages com mídia
When POST /api/v1/lgpd/anonymize com justification válida
Then contact.is_anonymized=true, anonymized_at preenchido
And contact.email,phone,cpf_*,name = null
And leads do contact têm title="Lead anonimizado", description=null
And activities têm payload sem chaves body/text/media_url
And event_log tem 'contact.anonymized'
And api_audit_log tem 'contact.anonymized' com justification
```

```gherkin
Given chamo anonymize 2× no mesmo contact
When 2ª chamada
Then retorna 200 { already_anonymized: true } (idempotente)
```

```gherkin
Given user role=agent
When POST anonymize
Then retorna 403
```

```gherkin
Given contact anonimizado
When PATCH /api/v1/contacts/[id] com qualquer campo
Then retorna 403 lgpd_anonymization_irreversible (L-04)
```

```gherkin
Given justification="curto"
When POST
Then retorna 422 (min 10 chars)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Cascade aplica | POST; verifica DB em todas as tabelas |
| t2 | api | Idempotente | POST 2×; ambos 200 |
| t3 | api | Role gate | role=1 → 403 |
| t4 | api | L-04 enforce | PATCH pós-anonymize → 403 |
| t5 | event | event_log emitido | SELECT event_log; achar contact.anonymized |
| t6 | api | Justification min | <10 chars → 422 |
| t7 | storage | Mídia delete enfileirado | event lgpd.media_purge_requested presente |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/lgpd/anonymize"
    request_schema: "{ contact_id: uuid, justification: string(min:10) }"
    response_schema: "{ data: { contact_id, anonymized_at, already_anonymized: boolean } }"
    error_codes: [forbidden_role, contact_not_found, justification_too_short]
  - type: react_hook
    id: "useAnonymizeContact"
  - type: domain_event
    id: "contact.anonymized"
    payload: "{ contact_id, actor_user_id, justification }"
  - type: domain_event
    id: "lgpd.media_purge_requested"
    payload: "{ message_ids[], contact_id }"
```

#### Decisões a registrar
- "Anonymize NÃO deleta linhas de leads/activities — preserva integridade referencial e histórico estatístico. Apenas PII vai a null."
- "Mídia em Storage é deletada async via worker que consome `lgpd.media_purge_requested` (worker fica em E08, mas evento é emitido aqui)."

#### Definition of Done
- [ ] ACs passam (incluindo idempotência)
- [ ] Typecheck/lint OK
- [ ] Commit `feat(EPIC-05): LGPD anonymize endpoint + cascade [wave 8]`

---

### S-05.09 — Anonymized contact UI banner + bloqueio de edits

**Points**: 1 | **Priority**: P0 | **Deps**: S-05.08 | **FR refs**: BR L-04

#### Contexto
Última wave: feedback visual irrevogável. Quando `contact.is_anonymized=true`, página de detalhe exibe banner sticky no topo, todos os inputs ficam disabled, botões de ação (anonymize, edit, merge) somem, e tentativas via API direta retornam 403 (já implementado em S-05.01).

#### Files to create
- `src/app/(app)/contacts/[id]/_components/AnonymizedBanner.tsx`

#### Files to modify
- `src/app/(app)/contacts/[id]/_components/ContactHeader.tsx` — esconde botões de ação
- `src/app/(app)/contacts/[id]/_components/ContactInfo.tsx` — todos inputs `disabled`
- `src/client/components/CustomFieldsEditor/CustomFieldsEditor.tsx` — aceita prop `disabled` que repassa pra todos renderers
- `src/app/(app)/contacts/[id]/page.tsx` — renderiza `<AnonymizedBanner>` no topo se `contact.is_anonymized`

#### Implementation steps (sequential)
1. `<AnonymizedBanner>` sticky top, fundo amber, ícone `Shield`, texto "Contato anonimizado em [data]. Edição bloqueada (LGPD - direito ao esquecimento, irreversível)."
2. `ContactHeader` filtra botões: se anonimizado, oculta "Editar", "Anonimizar", "Mesclar".
3. `ContactInfo` passa `disabled` para todos campos editáveis.
4. CustomFieldsEditor recebe `disabled` boolean e propaga aos renderers.
5. TimelineView continua renderizando (history é preservada), mas activities anonimizadas mostram payload sanitized (texto "—" onde body foi removido).

#### Acceptance Criteria

```gherkin
Given contact anonimizado
When abro /app/contacts/[id]
Then banner sticky aparece no topo com data correta
And inputs ContactInfo todos disabled
And botões "Editar"/"Anonimizar"/"Mesclar" sumiram
```

```gherkin
Given contact NÃO anonimizado
When abro detalhe
Then banner não aparece, inputs editáveis
```

```gherkin
Given contact anonimizado
When tento PATCH via curl direto
Then retorna 403 (defesa em profundidade — UI + API)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Banner renderiza | seed anonimizado; visual snapshot |
| t2 | ui | Inputs disabled | tentar typing; nada acontece |
| t3 | ui | Botões ocultos | anonymize/merge/edit não no DOM |
| t4 | api | PATCH 403 | curl PATCH; espera 403 |
| t5 | ui | TimelineView resiliente | activities sanitized renderizam sem crash |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<AnonymizedBanner>"
    props: "{ anonymizedAt: Date, contactId: string }"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Typecheck/lint OK
- [ ] Visual snapshot aprovado
- [ ] Commit `feat(EPIC-05): anonymized contact UI guard [wave 9]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| API contracts (CRUD contact) | 9 | S-05.01 |
| API timeline | 5 | S-05.02 |
| UI rendering (list/detail) | 12 | S-05.03, S-05.04 |
| Polymorphic timeline (12 types) | 5 | S-05.05 |
| Custom fields (10 types + strict) | 5 | S-05.06 |
| Merge queue (atomic + RLS) | 7 | S-05.07 |
| LGPD anonymize cascade | 7 | S-05.08 |
| L-04 enforcement (UI + API) | 5 | S-05.09 |
| RLS isolation cross-tenant | 4 | S-05.01, S-05.02, S-05.04, S-05.07 |
| **Total** | **59** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Merge atômico falha parcial → contacts inconsistentes | Crítica | Transação serializável + savepoints (Spec 02 §5.1); test `merge.atomic.test.ts` mata conexão no meio; rollback verificado |
| LGPD anonymize esquece tabela com FK soft → PII residual | Alta | Checklist explícito (Spec 02 §5.3 análogo); test que faz grep em todas as tabelas pelo email/phone/CPF original |
| L-04 violado por endpoint novo no futuro | Alta | Guard centralizado em `updateContact` service; lint rule custom (`no-direct-contact-update`) |
| Custom fields schema mudou após dados existirem | Média | Field deprecated mantém valor; PATCH com campo desconhecido → 422 strict; runbook §6.5 governa promoção |
| CPF leaked em logs | Crítica | `beforeSend` Sentry mascara regex CPF (regra L-08, herdada Spec 02); test unitário do sanitizador |
| Cursor HMAC secret rotaciona → cursors em uso quebram | Baixa | Versão no payload (`v:1`); rotação fica documentada em runbook |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-EPIC-05.A**: TimelineView usa registry pattern `type → Renderer`; novos types adicionados por outros epics DEVEM atualizar registry no mesmo PR (test cobre fallback `<UnknownRenderer>` mas mostra dev-warning).
- **ADR-EPIC-05.B**: Header `X-Decrypt-Purpose` é OBRIGATÓRIO em qualquer endpoint que retorna CPF descriptografado; ausência → CPF nunca volta no payload, mesmo pra super-admin.
- **ADR-EPIC-05.C**: Anonymize NÃO deleta rows; nulifica PII e mantém referência (preserva estatísticas e integridade). Mídia em Storage é deletada async via evento.
- **ADR-EPIC-05.D**: Merge UI sempre exige confirm dupla; merge é irreversível formalmente, mas `before_state` em audit_log permite recovery humano em casos extremos.
- **ADR-EPIC-05.E**: Field `deprecated=true` em custom fields nunca renderiza no editor, mas valor é preservado no payload do save.

## 9. Anexos

- Specs refs: `docs/specs/02-spec-customer-360.md` §2, §4, §5, §6, §9, §10; `docs/specs/09-spec-frontend-backend-integration.md` (TanStack Query, cursor HMAC).
- Business rules: L-04 (anonymize irreversível), L-06 (audit), L-07 (CPF encrypted), L-08 (CPF nunca em logs), P-08 (lead duplicado por contact), P-07 (vocabulary).
- Reconciliation log: R-01..R-05 (assumidas aplicadas).
- Screen flow refs: `docs/design-system/screen-flow/03-screen-inventory.md` rotas `/app/contacts`, `/app/contacts/[id]`, `/app/contacts/merge_queue`.
- Migrations base: 022 (contacts), 026 (crm_lead_activities), 028 (merge_queue), 029 (RLS), 035 (revoke writes activities).
