-- =============================================================================
-- Migration 00001 — Initial setup
-- =============================================================================
-- Apenas extensions. Schema real vem das specs de implementação (`docs/specs/`).
-- Cada migration subsequente referencia a spec correspondente no header.
-- =============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- TODO: aplicar Spec 01 — Plataforma Base
--   - organizations
--   - user_organizations (role: viewer|agent|manager|admin)
--   - platform_admins (ou coluna is_platform_admin em auth.users)
--   - api_tokens (hash SHA256, plaintext só na criação)
--   - api_audit_log (append-only; sem RLS de UPDATE/DELETE)
--   - fn_user_org_ids() helper
--   - RLS template tenant_isolation_<tabela>_all

-- TODO: aplicar Spec 02 — Customer 360 + Identity Resolution determinística
--   - contacts (unique org+phone E.164; consent jsonb; cpf encrypted via pgcrypto)
--   - crm_pipelines, crm_stages, crm_leads (position_in_stage NUMERIC), crm_lead_activities, crm_lead_links

-- TODO: aplicar Spec 03 — WhatsApp via WAHA Plus
--   - channel_sessions (1 sessão = 1 número; webhook_secret próprio)
--   - conversations (thread por contact + channel_session)
--   - messages (unique org+external_id; status: queued|sending|sent|delivered|read|failed)

-- TODO: aplicar Spec 05 — IA + RAG
--   - ai_agents (config por tenant, prompt, threshold sentiment)
--   - ai_chunks (embedding vector(1536); metadata jsonb; index ivfflat ou hnsw)
--   - ai_sources (FAQ | policy | nuvemshop_catalog | resolved_conversation)

-- TODO: aplicar Spec 06 — Nuvemshop + LGPD
--   - tenant_integrations (oauth tokens encrypted)
--   - orders (linkado a crm_leads via crm_lead_links polimórfico)
--   - nuvemshop_products (sync incremental)
--   - lgpd_requests (data_request | redact; status; SLA)

-- TODO: aplicar Spec 07 — Event log
--   - event_log (entity, action, payload jsonb, processed_at, retry_count)
--   - webhook_subscriptions, webhook_deliveries (backoff exp 30s→1m→2m→5m→10m→30m→1h)
