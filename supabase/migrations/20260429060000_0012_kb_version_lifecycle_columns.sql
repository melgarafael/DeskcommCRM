-- =============================================================================
-- Migration 0012 — KB version lifecycle columns (applied via Supabase MCP)
-- EPIC-06 Wave 4 — supports rag-indexer worker (S-06.04)
-- =============================================================================
-- Adds lifecycle tracking columns to ai_knowledge_versions:
--   * status        — building | ready | failed
--   * error_message — set on failure
--   * indexed_at    — timestamptz set when ready
--
-- version_number and total_chunks already exist from the initial schema.
-- =============================================================================

alter table public.ai_knowledge_versions
  add column if not exists status text default 'building'
    check (status in ('building', 'ready', 'failed')),
  add column if not exists error_message text,
  add column if not exists indexed_at timestamptz;
