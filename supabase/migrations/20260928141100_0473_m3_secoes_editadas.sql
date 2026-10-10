-- 20260928012000_0473_m3_secoes_editadas.sql
-- M3 (onda de modelos, §11 — canvas) — edição manual por seção. jsonb
-- {secaoId: textoEditado}, nullable, sem CHECK (mapa livre, chave = id de
-- seção do modelo em uso; não há vocabulário fechado a validar no schema).
alter table public.crm_proposals add column if not exists secoes_editadas jsonb;
