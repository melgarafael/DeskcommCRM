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

## Reproducibility

Migrations were applied directly via the Supabase MCP `apply_migration` tool during the autonomous bootstrap session. The SQL of each migration is also embedded in the corresponding spec under `docs/specs/0X-spec-*.md` and the database keeps them in `supabase_migrations.schema_migrations`.

To re-apply on a fresh Supabase project, replay the migrations in version order via `supabase db push` (Supabase CLI) or via the MCP.

## Tables created (31 total, all RLS enabled)

- **Platform**: organizations, user_organizations, platform_admins, api_tokens, api_audit_log, user_recovery_codes, idempotency_keys
- **Bus**: event_log
- **Customer 360**: contacts, crm_pipelines, crm_stages, crm_leads, crm_lead_activities, crm_lead_links, merge_queue
- **WhatsApp**: channel_sessions, channel_session_warmup, conversations, messages, webhook_events_log
- **AI**: ai_agents, ai_knowledge_sources, ai_knowledge_versions, ai_chunks, ai_invocations, ai_pricing (global), ai_budgets
- **Integrations**: tenant_integrations, orders, nuvemshop_products
- **Compliance**: lgpd_requests
