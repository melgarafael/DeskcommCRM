---
title: Sub-PRD 02 — Customer 360° + Identity Resolution
parent: 00-prd-master.md
depends_on: 01-prd-platform-base.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
---

# Sub-PRD 02 — Customer 360° + Identity Resolution

> O coração do SonghaiCRM. Define como o sistema enxerga uma pessoa, como reconcilia identidades vindas de fontes diferentes (WhatsApp, Nuvemshop, manual) e como acumula histórico cross-canal numa timeline única. Toda outra capacidade do produto (atendimento, IA, pipeline) opera sobre as estruturas definidas aqui.

---

## 1. Contexto & Posicionamento

Cliente que chega pelo WhatsApp tem telefone. Cliente que comprou no e-commerce tem email + CPF. Cliente que mandou DM pode ser o mesmo. **Sem identity resolution, o atendente vê 3 perfis fragmentados de uma só pessoa**, repete perguntas que o sistema já tem resposta, perde contexto histórico, falha em LGPD (data_request retorna parcial).

Customer 360° resolve isso unificando os pontos de contato numa **representação única**, com **timeline imutável** que cresce com cada evento (mensagem, pedido, ticket, ação do atendente, evento da IA), e **custom fields configuráveis por tenant** pra capturar o que importa pro negócio dele (tamanho preferido, data de aniversário, programa de fidelidade).

Esta camada também define o **vocabulary** — como cada tenant chama seu "lead" (Cliente / Aluno / Paciente) e seu "deal" (Pedido / Matrícula / Consulta) — sem isso, o produto vira CRM B2B genérico.

---

## 2. Escopo

### Dentro do escopo deste sub-PRD

1. Modelo de **Contact** (pessoa física, fonte canônica de identidade)
2. Modelo de **Lead** (card no funil; ligado a Contact; 1 contact pode ter N leads em pipelines diferentes)
3. **Identity resolution determinística** (email, telefone E.164, CPF) com regras configuráveis por tenant
4. **Merge de perfis duplicados** (manual e automático com confiança alta)
5. **Timeline event-sourced** (`crm_lead_activities` polimórfica) — append-only
6. **Custom fields declarativos** por pipeline (schema → Zod dinâmico)
7. **Vocabulary customizável** por pipeline (lead/deal/won/lost renomeáveis)
8. **Lead status e transições** (open → won / lost; reabertura)
9. **Tags e segmentação básica**
10. **Search e filters** sobre leads e contacts

### Fora do escopo deste sub-PRD

- Identity resolution probabilística (device fingerprint, comportamento) → Fase 3 do roadmap
- Sync inicial e webhooks Nuvemshop que populam contacts/orders → Sub-PRD 06
- Captura de conversas WhatsApp que populam timeline → Sub-PRD 03
- Pipeline UI Kanban (drag-drop, board) → Sub-PRD 04
- IA que lê o Customer 360 pra contextualizar resposta → Sub-PRD 05
- Analytics, segmentação avançada, NPS automatizado → pós-MVP

---

## 3. Capacidades Funcionais

### 3.1 Modelo de Contact (pessoa física)

**O que provê.** Representação única de uma pessoa real no escopo de um tenant. É a fonte de identidade canônica — todo lead aponta pra um contact (ou explicitamente declara `contact_id=null` em casos raros).

**Princípios.**
- 1 contact por pessoa por tenant (chave primária de unicidade: `(organization_id, phone_number)` quando há telefone; `(organization_id, email)` como fallback; `(organization_id, cpf)` como override forte)
- Telefones armazenados em **E.164** (ex: `+5511999998888`); validação na entrada
- Email em lowercase normalizado
- CPF armazenado apenas com dígitos (sem formatação), validado contra dígito verificador
- Campo `name` separado de `display_name` (display permite apelido/empresa)
- Estado: `is_blocked` (true se cliente respondeu STOP ou foi bloqueado manualmente), `is_anonymized` (true após redact LGPD)
- Custom fields **NÃO** vivem no contact — vivem no lead (porque variam por pipeline)
- `consent` jsonb com chaves `marketing | transactional | profiling` (governado pelo Sub-PRD 01)

**ACs principais.**
- Importação de pedido Nuvemshop com email já existente em outro contact dispara fluxo de identity resolution (vide §3.3)
- Telefone novo cria contact novo se não existir; reusa se mesmo `(org, phone_number)`
- Tentativa de criar contact com email duplicado no mesmo tenant retorna 409 com `error.code='contact_email_exists'` e `details.existing_contact_id=...`
- Contact com `is_anonymized=true` retorna apenas o ID + tokens de anonimização em qualquer GET; nunca dados pessoais

### 3.2 Modelo de Lead (card no funil)

**O que provê.** Instância de oportunidade comercial dentro de um pipeline específico. Em e-commerce: 1 pedido = 1 lead (no pipeline "Pedidos"). 1 ticket de suporte = 1 lead (no pipeline "Suporte", se existir). 1 cliente pode ter N leads simultaneamente em pipelines distintos.

**Princípios.**
- Tabela canônica `crm_leads` (não `crm_deals` — vide decisão arquitetural na referência)
- `contact_id` é FK opcional (`on delete set null`); permite anonimização do contact sem perder o histórico do lead
- `pipeline_id` é FK obrigatória (RESTRICT); lead vive em UM pipeline específico
- `stage_id` é FK obrigatória (RESTRICT); muda à medida que o lead avança
- `position_in_stage` é `numeric` com fractional indexing (`midpoint(prev, next)`) — **NUNCA `int`**
- `value_cents` em bigint + `currency` ISO-4217
- `status` enum text: `open | won | lost`
- `owner_user_id` (soft FK pra `auth.users`) define o atendente responsável
- `source` text: `whatsapp_inbound | nuvemshop_order | web_form | manual | api`
- `source_metadata` jsonb pra payload original da fonte
- `custom_fields` jsonb governado pelo schema declarativo do pipeline (vide §3.4)
- `tags` text[] indexado com GIN
- `last_activity_at` denormalizado por trigger (caminho **I**ntegrar do DIRC)

**ACs principais.**
- Criar lead via `POST /api/v1/leads` com `pipeline_id` obrigatório e `stage_id` opcional (default = primeiro stage do pipeline)
- Lead criado a partir de pedido Nuvemshop tem `source='nuvemshop_order'` e `source_metadata.order_id` preenchido
- Lead com `position_in_stage=2.5` arrastado pra cima/baixo recebe novo valor calculado por `midpoint()`, sem reescrita em massa
- Tentativa de mover lead pra stage de outro pipeline retorna 422 `stage_pipeline_mismatch`

### 3.3 Identity resolution determinística

**O que provê.** Mecanismo que, dado um conjunto de pontos de contato (telefone, email, CPF), encontra contact existente OU cria um novo, OU sinaliza ambiguidade pra resolução manual.

**Algoritmo (versão MVP, sequencial):**
1. Se `cpf` presente E `cpf` único no tenant → contact resolvido (alta confiança)
2. Senão, se `phone_e164` presente E único no tenant → contact resolvido (alta confiança)
3. Senão, se `email` presente E único no tenant → contact resolvido (média confiança)
4. Senão, criar contact novo
5. Se algum match encontra **mais de um contact** no tenant → criar com `merge_pending=true`, gerar entrada em `merge_queue` pra resolução manual

**Princípios.**
- Regras configuráveis por tenant: alguns tenants não coletam CPF — settings `identity_resolution.fields_in_priority_order = ['cpf', 'phone_e164', 'email']`
- Match é **case-insensitive** (`LOWER(email)`)
- Telefone normalizado pra E.164 antes de matching
- CPF: apenas dígitos, validação de dígito verificador
- Conflitos vão pra `merge_queue` (tabela com `tenant_id, candidates uuid[], status, resolved_by, resolved_at`)
- Resolução manual pode: (a) escolher um existente, (b) criar novo separado, (c) mesclar todos em um (fluxo §3.4 abaixo)

**ACs principais.**
- Pedido Nuvemshop com email = `joao@x.com` (existente) e telefone = `+551199` (existente noutro contact) → entra em `merge_queue` com 2 candidatos
- Mensagem WhatsApp com telefone existente (alta confiança) gera atividade no contact existente, sem fila
- Tentativa de criar contact com `phone='11999998888'` (sem +55, formato local) retorna 422 `phone_must_be_e164`
- Tenant que desativa CPF nas regras (`fields_in_priority_order` sem 'cpf') pula step 1 do algoritmo

### 3.4 Merge de perfis duplicados

**O que provê.** UI + API pra mesclar 2+ contacts duplicados num único, preservando todo o histórico.

**Princípios.**
- Operação **destrutiva** (irreversível) — exige role `manager` ou superior + audit log obrigatório
- Merge escolhe um contact "vencedor" (primary) e move tudo dos perdedores pra ele:
  - `crm_leads` → reaponta `contact_id` pro primary
  - `crm_lead_activities` → reaponta (via `source_id` quando aplicável) pro primary
  - `conversations` → reaponta `contact_id` pro primary
  - `messages` → indireto via `conversations`
- Contacts perdedores recebem `is_merged_into=<primary_id>` e `is_anonymized=true`; ficam na tabela como tombstone (não deleta pra manter integridade do audit)
- Conflito de `custom_fields`: primary vence; perdedores guardam diff no audit
- Operation atômica em transação (com SAVEPOINT por tabela afetada)

**ACs principais.**
- UI mostra "merge candidates" com diff lado-a-lado (campo a campo) e botão "manter X / manter Y / manual"
- Merge bem-sucedido emite evento `contact.merged` no `event_log` pra workers atualizarem caches/RAG
- Tentativa de merge com role `agent` retorna 403
- Merge desfeito (não suportado) retorna 405 `merge_irreversible`

### 3.5 Timeline event-sourced

**O que provê.** Histórico imutável e cronológico de tudo que aconteceu com um lead — todo input do canal, ação do atendente, transição de status, evento de IA, integração externa. É **append-only**, ordenado por `performed_at`.

**Princípios.**
- Tabela canônica `crm_lead_activities` polimórfica com `(source_module text, source_id uuid)`
- `type` text canônico (não enum — evolui sem migration). Tipos canônicos pro MVP:
  - `whatsapp_inbound`, `whatsapp_outbound`, `whatsapp_call_started`
  - `system` (notas do sistema), `note` (nota do atendente)
  - `stage_changed`, `assigned`, `unassigned`
  - `won`, `lost`, `reopened`
  - `nuvemshop_order_created`, `nuvemshop_order_paid`, `nuvemshop_order_fulfilled`, `nuvemshop_cart_abandoned`
  - `ai_responded`, `handoff_triggered`, `sentiment_alert`
  - `lgpd_consent_changed`, `lgpd_redact_applied`
- `payload` jsonb com dados do evento (mensagem, mudança, score sentiment, etc.)
- `metadata` jsonb com contexto (user_id que executou, fonte externa, request_id)
- `performed_at timestamptz` (ordenação canônica) — **diferente de** `created_at` (quando entrou no DB)
- Activities **NÃO** disparam HTTP de trigger Postgres; emitem linha em `event_log` consumida por workers (Sub-PRD da Plataforma Base já governa isso)

**ACs principais.**
- Mensagem WhatsApp recebida cria 1 atividade `whatsapp_inbound` na timeline do lead vinculado em <2s
- Pedido Nuvemshop pago cria atividade `nuvemshop_order_paid` com `payload.order_id` e `payload.value_cents`
- Mudança manual de stage cria atividade `stage_changed` com `metadata.from_stage_id` e `metadata.to_stage_id`
- Activity criada **não pode ser editada nem deletada** via API (retorna 405)

### 3.6 Custom fields declarativos

**O que provê.** Cada pipeline define um schema de campos custom que aparecem nos seus leads. Tenant configura sem deploy. UI gera form dinâmico, validação roda Zod gerado a partir do schema.

**Princípios.**
- Schema vive em `pipelines.settings.fields` jsonb como array de `{ key, label, type, required, options?, ... }`
- Tipos suportados no MVP: `text`, `textarea`, `number`, `date`, `boolean`, `select` (com `options`), `multiselect`, `currency` (em cents), `url`, `email`
- Valor armazenado em `crm_leads.custom_fields` jsonb com chave igual a `field.key`
- Indexação: GIN em `custom_fields` pra filter; campos hot promovidos a coluna gerada (`generated always as (...) stored`) **só** quando viram filtro frequente (decisão na Spec)
- **Renomear key** quebra leads existentes — UI exige confirmação dupla; alternativa preferida = `deprecated=true` no field
- **Adicionar/remover field** é operação `manager`+; auditada

**Casos de uso pro MVP de e-commerce:**
- `tamanho_preferido` (select)
- `data_aniversario` (date)
- `ltv_cents` (currency, calculado por trigger)
- `categoria_preferida` (multiselect)
- `programa_fidelidade_pontos` (number)
- `nps_ultima_avaliacao` (number 0-10)

**ACs principais.**
- Manager adiciona field "data_aniversario" via UI; novos leads do pipeline mostram campo no form; leads antigos têm `null`
- Tentativa de salvar lead com `custom_fields.tamanho_preferido='XXXL'` quando schema lista opções `['P','M','G','GG']` retorna 422 `field_value_not_in_options`
- Field marcado `deprecated=true` desaparece de forms novos mas mantém valores em leads antigos
- API filter `?custom_field[tamanho_preferido]=GG` retorna leads correspondentes via JSONB `@>`

### 3.7 Vocabulary customizável por pipeline

**O que provê.** Cada pipeline pode renomear os termos canônicos pra refletir o negócio do tenant. UI lê o vocabulary; banco mantém schema invariante.

**Princípios.**
- `pipelines.vocabulary` jsonb: `{ lead, deal, won, lost, stage }` (e variações de pluralização: `lead_plural`, etc.)
- Defaults pro pipeline e-commerce: `lead='Cliente'`, `deal='Pedido'`, `won='Pago'`, `lost='Cancelado'`
- Outros nichos (futuro): saúde (`Paciente / Consulta / Agendado / Cancelado`), educação (`Aluno / Matrícula / Matriculado / Desistente`)
- Mudança de vocabulary é evento auditado, **não** muda dados, apenas labels da UI/exports
- Vocabulary é referenciado por todo componente de UI via hook `usePipelineVocabulary(pipelineId)`

**ACs principais.**
- Pipeline criado com vocabulary default (e-commerce) mostra "Cliente" / "Pedido" / "Pago" / "Cancelado" na UI
- Manager edita vocabulary pra `lead='Comprador'`; UI atualiza em <5s sem refresh manual
- Export de relatório usa o vocabulary do pipeline (não o canônico)

### 3.8 Lead status e ciclo de vida

**O que provê.** Transições explícitas e auditadas entre os estados `open`, `won`, `lost`, e reabertura controlada.

**Princípios.**
- Status `open` é o default
- Mudança pra `won` ou `lost` exige stage marcado `is_won=true` ou `is_lost=true` correspondente. Trigger automático `fn_crm_lead_close_on_stage` aplica (vide referência)
- `closed_at` preenchido automaticamente quando vai pra won/lost; `null` quando reaberto
- Reabertura permitida (status volta pra `open`) com auditoria explícita; pode estar restrita por role (manager+)
- `lost_reason` campo text obrigatório quando vai pra `lost` (`reason='requested_by_customer'`, `'price'`, `'no_response'`, `'product_unavailable'`, `'other'`)

**ACs principais.**
- Mover lead pra stage com `is_won=true` muda status pra `won` automaticamente
- Tentativa de marcar lead `won` sem ir por um stage `is_won` retorna 422 `must_transition_via_stage`
- Reabrir lead `won` registra atividade `reopened` com `metadata.previous_status='won'` e `metadata.reason`

### 3.9 Tags e segmentação básica

**O que provê.** Marcadores livres em leads e contacts pra agrupar/filtrar. No MVP: text[] simples.

**Princípios.**
- Coluna `tags text[] not null default '{}'` em `crm_leads` e em `contacts`
- Indexação GIN
- Tag promovida a "tag oficial" do tenant via `pipelines.settings.canonical_tags` (lista whitelist) — opcional; sem isso vira free-form
- API: `POST /api/v1/leads/:id/tags/add { tags: ['vip', 'recompra'] }` e `.../tags/remove`
- Operação **idempotente** (adicionar tag já existente é no-op)

**ACs principais.**
- Lead recebe tag `'vip'`; filter `?tag=vip` retorna ele
- Tag `'VIP'` (maiúscula) e `'vip'` são tratadas como **diferentes** no MVP (case-sensitive); decisão de normalizar deferida
- Adicionar 100 tags simultâneas em 1 request retorna 422 `tags_max_per_request_exceeded`

### 3.10 Search e filters

**O que provê.** API para buscar leads e contacts com filtros combinados, paginação cursor, ordenação configurável.

**Filtros suportados no MVP** (em `GET /api/v1/leads`):
- `pipeline_id`, `stage_id`, `owner_user_id`, `contact_id`, `status`
- `source` (whatsapp_inbound, nuvemshop_order, etc.)
- `tag` (uma tag)
- `search` (ILIKE em `title`)
- `value_min` / `value_max`
- `created_after` / `created_before`
- `last_activity_after` / `last_activity_before`
- `expected_close_after` / `expected_close_before`
- `custom_field[KEY]=value` (JSONB containment)
- `is_overdue` (computado: lead `open` com `expected_close_date < today`)
- `order_by`: `created_at | last_activity_at | value_cents | position_in_stage`
- `order_dir`: `asc | desc`

**Princípios.**
- Paginação cursor por default (HMAC-protegido pra prevenir tampering)
- Limit padrão 50; máx 200 por request
- Search ILIKE em `title` (sem full-text no MVP; entra em fase pós-MVP se necessário)
- Filtros ANDed (todos devem matchar)
- Notação `?campo[op]=valor` opcional (gt/lt/gte/lte/in/contains/ilike) — decisão na Spec

**ACs principais.**
- `GET /api/v1/leads?pipeline_id=X&status=open&owner_user_id=ME&order_by=last_activity_at&order_dir=desc` retorna leads filtrados, ordenados, com cursor pra próxima página
- Cursor manipulado retorna 400 `cursor_invalid_signature`
- Filter inválido (campo desconhecido) retorna 422 `unknown_filter`

---

## 4. Requisitos Não-Funcionais

### 4.1 Performance
- p95 de criação de lead via API: <300ms
- p95 de identity resolution determinística (3 fields): <100ms (queries indexadas)
- p95 de listagem de leads com 5 filters + cursor: <500ms até 1M leads/tenant
- p95 de inserção de timeline activity: <150ms
- Particionamento de `crm_lead_activities` por `(organization_id, performed_at)` quando tenant ultrapassar 5M activities (decisão na Spec)

### 4.2 Consistência
- Identity resolution e merge são operações com transação (consistência forte)
- Timeline é eventually consistent com event_log → workers (latência alvo <2s p95)
- Custom fields validados em nível de aplicação (Zod gerado dinamicamente); banco aceita qualquer jsonb (validação dupla é overkill no MVP)

### 4.3 Escalabilidade
- Tenant alvo MVP: ~5k pedidos/mês × 12 meses × 5 anos = ~300k leads no longo prazo (pequeno pra Postgres)
- Activities: ~5M/ano por tenant médio (vide sizing no Sub-PRD 03)
- Indexes essenciais: `(org, contact_id)`, `(org, pipeline_id, status)`, `(org, owner_user_id, status)`, `(org, last_activity_at desc)`, GIN em `custom_fields` e `tags`

---

## 5. Acceptance Criteria do sub-PRD

Customer 360° é considerado **MVP-completo** quando:

1. ✅ Pedido Nuvemshop sincroniza pra `crm_leads` no pipeline "Pedidos" com contact resolvido (existente ou criado) corretamente
2. ✅ Mensagem WhatsApp inbound de telefone novo cria contact + lead default; de telefone existente reusa contact e cria activity
3. ✅ Identity resolution determinística passa em ≥95% dos casos sem precisar `merge_queue`; remaining 5% caem na fila com 2+ candidatos visíveis
4. ✅ Merge manual de 2 contacts duplicados move 100% das references (leads, conversations, activities) pro primary; perdedores ficam como tombstone
5. ✅ Timeline de um lead com pedido + 5 mensagens + 2 mudanças de stage mostra 8 activities ordenadas por `performed_at`
6. ✅ Custom field `data_aniversario` adicionado no pipeline aparece no form de novo lead em <5s; valor é validado e persistido
7. ✅ Vocabulary do pipeline "Pedidos" mostra "Cliente / Pedido / Pago / Cancelado" na UI; mudança propaga em <5s
8. ✅ Lead movido pra stage marcada `is_won=true` vira automaticamente `status='won'` com `closed_at` preenchido
9. ✅ Filter combinado de 5 critérios (`pipeline_id`, `status`, `owner`, `tag`, `last_activity_after`) retorna resultado correto em <500ms
10. ✅ Audit log captura: `contact.created`, `contact.merged`, `lead.created`, `lead.stage_changed`, `lead.won`, `lead.lost`, `custom_field.added`, `vocabulary.changed`

---

## 6. Dependências

### Internas
- **Sub-PRD 01 (Plataforma Base)** — auth, RLS, audit log, event_log, convenções de API. Bloqueante.

### Externas
- Nenhuma direta. Identity resolution e timeline são camadas internas.

### Decisões deferidas pra Spec
- Particionamento de `crm_lead_activities` (estratégia exata de partition por mês ou por tenant)
- Estratégia de coluna gerada vs índice JSONB pra custom fields hot
- Algoritmo exato de "qual contact vence no merge automático" (timestamp mais antigo? mais completo?)
- Política de deduplicação de tags (case-insensitive normalize? canonical_tags whitelist?)
- Suporte futuro a full-text search (Postgres `tsvector` ou serviço externo tipo Algolia/Meilisearch)

---

## 7. Riscos Específicos do sub-PRD

| # | Risco | Mitigação |
|---|---|---|
| C1 | **Identity resolution erra match** (cria duplicado quando devia mesclar, ou mescla quando devia separar) | Algoritmo conservador no MVP (preferir criar e deixar em `merge_queue` que mesclar errado); UI clara de revisão manual; teste com dataset realístico antes de produção |
| C2 | **Merge de contacts perde dado** | Operação atômica + savepoint por tabela; merge gera snapshot do estado anterior em audit `metadata.before_state`; processo de revisão pós-merge na primeira semana |
| C3 | **Timeline em volumes muito altos fica lenta** | Particionamento por `(org, performed_at)`; índice composto; cleanup de events `system` muito antigos (>2 anos) com archive em cold storage |
| C4 | **Custom fields explodem schema** (tenant adiciona 50 fields, performance degrada) | Limite no MVP de 30 fields ativos por pipeline; aviso UX em 20+; campos `deprecated=true` não contam |
| C5 | **Vocabulary causa confusão em UI** (atendente em modo BPO troca de tenant e vê vocabulários diferentes) | Hook `usePipelineVocabulary` injeta sempre; nunca strings hardcoded em UI; testes visuais cross-vocabulary |
| C6 | **Tags free-form viram caos semântico** ("vip" vs "VIP" vs "Vip" vs "cliente_vip") | Documentação de convenção; canonical_tags whitelist como feature opcional; possível normalização case-insensitive em fase pós-MVP |
| C7 | **CPF capturado mas LGPD-protegido não criptografado at-rest** | CPF em coluna com pgcrypto encrypted-at-rest; consulta sempre via função `decrypt_cpf()` que valida acesso; nunca log de CPF mesmo em debug |

---

## 8. Fora de Escopo (deste sub-PRD)

- Identity resolution probabilística (Fase 3)
- Merge automático com confiança alta sem revisão (deferido pra pós-MVP)
- Full-text search com ranking semântico (pós-MVP)
- Segmentos salvos / smart lists (pós-MVP)
- Programa de fidelidade integrado nativo (pós-MVP)
- NPS automatizado pós-conversa (Sub-PRD 05 cobre o trigger; cálculo agregado é pós-MVP)
- Calculadora de LTV em tempo real (computado por trigger no MVP, mas dashboard analytics é pós-MVP)

---

## 9. Decisões deferidas pra Spec (Fase 3)

A serem decididas no spec correspondente (`docs/specs/02-spec-customer-360.md`):

1. Schema SQL completo: `contacts`, `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`, `merge_queue`
2. RLS policies por tabela
3. Triggers: `fn_crm_lead_close_on_stage`, `fn_update_last_activity_at`, `fn_emit_event_on_lead_change`
4. Algoritmo exato de identity resolution (incluindo critérios de desempate quando >1 candidato com mesma confiança)
5. Esquema do schema declarativo de custom fields (incluindo todos os tipos suportados e suas validações)
6. Layout exato da UI de merge (mockups)
7. Particionamento e estratégia de archive de `crm_lead_activities`
8. Catálogo final de `type` canônico de activity (nomes definitivos)
9. Política de canonical_tags vs free-form
10. Lista canônica de `lost_reason` permitidos (com extensibilidade por tenant?)

---

## Anexos

- `docs/research/reference-synthesis.md` (especialmente §3 Data model, §9 Anti-patterns, §10 Naming convention)
- `docs/prd/00-prd-master.md`
- `docs/prd/01-prd-platform-base.md`
- `tasks/todo.md`
