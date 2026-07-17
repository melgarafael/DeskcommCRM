# Migration Manifest — DeskcommCRM

Migrations applied to Supabase project `rrydmwnporysaiysiztn` (sa-east-1, Postgres 17) via Supabase MCP on 2026-04-28.

## Applied

| Version | Name | Description |
|---|---|---|
| `20260428195354` | `0001_platform_base` | organizations, user_organizations, platform_admins, api_tokens, api_audit_log, user_recovery_codes, idempotency_keys + RLS helpers (fn_user_org_ids, fn_is_platform_admin, fn_user_role_in_org, fn_role_at_least) |
| `20260428195513` | `0002_event_log_and_compat` | event_log + emit_event/fn_log_event helpers + compat aliases (fn_set_updated_at, fn_user_role_in returning int) |
| `20260428195708` | `0003_customer_360` | contacts (CPF encrypted), crm_pipelines, crm_stages, crm_leads, crm_lead_activities, crm_lead_links, merge_queue + 5 domain triggers |
| `20260428200016` | `0004_whatsapp_waha` | channel_sessions, channel_session_warmup, conversations, messages, webhook_events_log + emit_message_event trigger |
| `20260428200128` | `0005_ai_rag` | ai_agents, ai_knowledge_sources, ai_chunks (vector(1536) ivfflat), ai_knowledge_versions, ai_invocations, ai_pricing (3 seeded), ai_budgets + fn_audit_log_row helper |
| `20260428200211` | `0006_nuvemshop_lgpd` | tenant_integrations, orders, nuvemshop_products, lgpd_requests + fn_encrypt_oauth/fn_decrypt_oauth + LGPD/DLQ extra indexes on webhook_events_log |
| `20260428200331` | `0007_security_hardening` | search_path=public set on all functions, ai_pricing public-read policy, revoke EXECUTE anon on internal helpers, tighten api_audit_log INSERT policy |
| `20260429013958` | `0008_tenant_onboarding_state` | onboarding state machine columns + transitions on organizations |
| `20260429021857` | `0009_expand_messaging_constraints` | extra check constraints + indexes on conversations/messages for inbox perf |
| `20260429032132` | `0010_ai_rag_handoff_columns_and_rpcs` | EPIC-06 wave 1: contacts.force_human + conversations.bot_silenced_until/last_handoff_at + RPC retrieve_top_k_chunks (security definer + programmatic org filter) + RPC activate_kb_version + ai_pricing seed corrections (haiku 100/500, embedding-3-small 20) |
| `20260429040000` | `0011_handoff_reason_column` | EPIC-06 wave 3: conversations.last_handoff_reason (diagnostic) + crm_stages.requires_human (gate G4 — bypass bot when lead enters critical stage) |
| `20260429060000` | `0012_kb_version_lifecycle_columns` | EPIC-06 wave 4: ai_knowledge_versions lifecycle columns — status (building/ready/failed), error_message, indexed_at |
| *(wave 5)* | `0013_ai_faq_items` | EPIC-06 wave 5: ai_faq_items table (RLS via fn_user_org_ids) + name/status/ingested_at columns on ai_knowledge_sources + expanded source_type check |
| `20260429080000` | `0014_storage_policies_ai_policy` | EPIC-06 wave 6: private ai-policy bucket (20MB cap, pdf+md MIME) + per-tenant SELECT/INSERT/DELETE RLS on storage.objects (path-prefix org isolation via user_organizations EXISTS subquery) |
| `20260429090000` | `0015_conversations_rag_optin` | EPIC-06 wave 7 (S-06.07, LGPD L-08): conversations.usable_for_rag + marked_at + marked_by + rag_review_status (tri-state) + partial index on (org, usable_for_rag, marked_at) where true |
| `20260428000000` | `0016_lgpd_emergency_scope` | EPIC-08 wave 3: lgpd_requests.emergency (boolean, default false) + scope (text check 'contact'/'tenant', default 'contact') + partial index lgpd_requests_emergency_idx on (org, emergency, due_at) where emergency=true |
| `20260429100000` | `0017_storage_policies_lgpd_exports` | EPIC-08 wave 4 (S-08.04): private lgpd-exports bucket (50MB cap, pdf+json MIME) + per-tenant SELECT RLS on storage.objects (path-prefix org isolation via user_organizations EXISTS subquery). Worker uploads via service-role only — no INSERT/DELETE policies for anon/authenticated. |
| `20260429110000` | `0018_lgpd_redaction_queue` | EPIC-08 wave 5 (S-08.05): storage_redaction_queue table (org-scoped RLS, unique (bucket, object_path), partial index on pending) — async drain target for LGPD media deletion. |
| `20260429110001` | `0019_lgpd_cascade_redact_rpc` | EPIC-08 wave 5 (S-08.05, L-04): SECURITY DEFINER fn_lgpd_cascade_redact_contact(org, contact, request) — atomic 8-step cascade (contacts irreversible + conversations + messages + activities + leads + orders payload strip + media enqueue + audit). ACL revoked from anon/authenticated; granted only to service_role. |
| `20260429120000` | `0020_organization_suspend_reason` | EPIC-11 wave 8 (S-11.08): organizations.suspended_reason (text) + suspended_by (uuid → auth.users) — enables suspend/reactivate API to store reason + actor. |
| *(wave 11)* | `0021_incidents` | EPIC-11 wave 11 (S-11.11): incidents table (organization_id optional FK, severity check info/warning/critical, status open/acknowledged/resolved, payload jsonb, acknowledged/resolved actor+timestamp, resolution_note, RLS via fn_is_platform_admin — platform-admins only, users do not see). Indexes on status+created_at (partial, excludes resolved), org+created_at, severity+status. |
| `20260429140000` | `0022_ai_budget_trigger` | EPIC-06 finalize: ai_budget enforcement trigger on ai_invocations. |
| `20260505140000` | `0023_ai_agents_module` | EPIC-13 wave 1 (S-13.01): foundation schema for configurable AI Agents — extends ai_agents (published_version_id, priority, archived_at, kind), creates ai_agent_versions, ai_provider_credentials (+ safe view, security_invoker), ai_agent_runs (partial unique one_running_per_conv), ai_models (global catalog, 8 models seeded). RLS via fn_user_org_ids on tenant-aware tables; audit triggers via fn_audit_log_row (helper inlined idempotently — was missing from local migrations although present on remote since 0005). ai_models is global read-all, write via service role only. |
| `20260506000000` | `0024_ai_agent_publish_fn` | EPIC-13 S-13.06: fn_publish_ai_agent_version (atomic Save/Publish flip) — validates agent/version/credential/channel_session/model before flipping published_version_id. |
| `20260506100000` | `0025_fix_publish_fn_and_realtime_publication` | Forward-fix: qualifies column refs in fn_publish_ai_agent_version to resolve `agent_id` ambiguity against RETURNS TABLE output params; adds ai_agent_runs/ai_agents/ai_knowledge_sources to the supabase_realtime publication. |
| `20260706200000` | `0026_fix_publish_fn_status_case` | Forward-fix: fn_publish_ai_agent_version compared channel_sessions.status against lowercase `'working'`, but the canonical value (channel_sessions_status_check, written by the WAHA webhook handler) is uppercase `'WORKING'`. Publish always raised `channel_session_offline`, even for a genuinely connected session. Bug present since 0024, carried forward unchanged by 0025. |
| `20260706210000` | `0027_whatsapp_conversation_unification` | Bugfix de governança de conversas WhatsApp. Causa-raiz: contatos @lid sem unique key + resolução check-then-act, e o WAHA emitindo `message`+`message.any` por mensagem → 1 pessoa virava N contatos/conversas (medido: 1 lid = 12 contatos). Adiciona coluna gerada `contacts.wa_identity` (`phone:+E164`/`lid:<digits>`), faz merge idempotente do histórico duplicado repontando todas as FKs (usa `is_merged_into` como mapa, sem temp tables → portável em psql), cria `uniq_contacts_org_wa_identity` + `uniq_conversations_1to1_per_contact_session` (a antiga unique incluía group_chat_id NULL, que no Postgres não protege 1:1), e as funções de upsert atômico `fn_upsert_wa_contact`/`fn_upsert_wa_conversation`/`fn_mark_conversation_message` que a app passa a usar (lib/waha/ingest.ts) no lugar do check-then-act. Também corrige mapeamento de `type` WAHA→CRM (`chat`→`text` etc.) que fazia mensagens reais violarem messages_type_check e sumirem. |
| `20260716120000` | `0030_config_rls_role_policies` | G2-03 (gov-loop): RLS por role nas tabelas de config, fechando no banco o que a G2-01 fechou na API (spec 13 §4; auditoria em §4.1). crm_pipelines/crm_stages: policy ALL org-flat vira SELECT org + WRITE manager+ (`fn_role_at_least`, padrão de api_tokens/merge_queue) — agent deixa de escrever config de pipeline. conversations: WRITE vira agent+ (viewer é read-only); SELECT permanece org-flat com a mesma expressão (escopo own/unassigned é G4-01). NNNN pula 0028/0029 (ocupados nas branches vendaval/F2-*). Sem mudança de contrato — database.types.ts intocado. |

## Reproducibility

Migrations were applied directly via the Supabase MCP `apply_migration` tool during the autonomous bootstrap session. The SQL of each migration is also embedded in the corresponding spec under `docs/specs/0X-spec-*.md` and the database keeps them in `supabase_migrations.schema_migrations`.

To re-apply on a fresh Supabase project, replay the migrations in version order via `supabase db push` (Supabase CLI) or via the MCP.

## Tables created (33 total, all RLS enabled)

- **Platform**: organizations, user_organizations, platform_admins, api_tokens, api_audit_log, user_recovery_codes, idempotency_keys
- **Bus**: event_log
- **Customer 360**: contacts, crm_pipelines, crm_stages, crm_leads, crm_lead_activities, crm_lead_links, merge_queue
- **WhatsApp**: channel_sessions, channel_session_warmup, conversations, messages, webhook_events_log
- **AI**: ai_agents, ai_knowledge_sources, ai_knowledge_versions, ai_chunks, ai_invocations, ai_pricing (global), ai_budgets, ai_faq_items
- **Integrations**: tenant_integrations, orders, nuvemshop_products
- **Compliance**: lgpd_requests
- **Ops**: incidents
