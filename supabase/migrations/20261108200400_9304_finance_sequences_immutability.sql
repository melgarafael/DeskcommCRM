-- =============================================================================
-- ARM Finance - Document sequences + hash chain + posted immutability
-- Adapted: organization_id + fn_user_org_ids()
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. document_sequences
CREATE TABLE IF NOT EXISTS finance.document_sequences (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID      NOT NULL REFERENCES public.organizations(id),
  doc_type      VARCHAR(20)  NOT NULL
                CHECK (doc_type IN ('invoice', 'credit_note', 'receipt', 'payment', 'journal_entry')),
  prefix        VARCHAR(20)  NOT NULL,
  fiscal_year   INTEGER      NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  pos_config_id UUID,
  next_number   INTEGER      NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  padding       INTEGER      NOT NULL DEFAULT 6 CHECK (padding BETWEEN 1 AND 12),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by    UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_sequences_scope
  ON finance.document_sequences (
    organization_id, doc_type, fiscal_year,
    (coalesce(pos_config_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

DROP TRIGGER IF EXISTS trg_document_sequences_audit ON finance.document_sequences;
CREATE TRIGGER trg_document_sequences_audit
  BEFORE INSERT OR UPDATE ON finance.document_sequences
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

SELECT finance.apply_org_rls('finance.document_sequences');

-- 2. next_sequence
CREATE OR REPLACE FUNCTION finance.next_sequence(
  p_organization_id UUID,
  p_doc_type        VARCHAR,
  p_fiscal_year     INTEGER,
  p_pos_config_id   UUID DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, finance, extensions, pg_temp
AS $$
DECLARE
  v_prefix  VARCHAR(20);
  v_seq     finance.document_sequences%ROWTYPE;
  v_number  INTEGER;
BEGIN
  IF p_organization_id IS NULL OR p_doc_type IS NULL OR p_fiscal_year IS NULL THEN
    RAISE EXCEPTION 'next_sequence: organization_id, doc_type y fiscal_year son obligatorios';
  END IF;

  IF auth.uid() IS NOT NULL AND p_organization_id NOT IN (SELECT public.fn_user_org_ids()) THEN
    RAISE EXCEPTION 'next_sequence: organization no autorizada' USING ERRCODE = '42501';
  END IF;

  v_prefix := CASE p_doc_type
    WHEN 'invoice'       THEN 'FAC'
    WHEN 'credit_note'   THEN 'NC'
    WHEN 'receipt'       THEN 'REC'
    WHEN 'payment'       THEN 'PAG'
    WHEN 'journal_entry' THEN 'ASI'
    ELSE NULL
  END;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'next_sequence: doc_type invalido: %', p_doc_type;
  END IF;

  IF p_pos_config_id IS NOT NULL THEN
    v_prefix := left(v_prefix, 15) || '-' || upper(left(replace(p_pos_config_id::text, '-', ''), 4));
  END IF;

  INSERT INTO finance.document_sequences (organization_id, doc_type, prefix, fiscal_year, pos_config_id)
  VALUES (p_organization_id, p_doc_type, v_prefix, p_fiscal_year, p_pos_config_id)
  ON CONFLICT (
    organization_id, doc_type, fiscal_year,
    (coalesce(pos_config_id, '00000000-0000-0000-0000-000000000000'::uuid))
  ) DO NOTHING;

  SELECT * INTO v_seq
    FROM finance.document_sequences s
   WHERE s.organization_id = p_organization_id
     AND s.doc_type    = p_doc_type
     AND s.fiscal_year = p_fiscal_year
     AND s.pos_config_id IS NOT DISTINCT FROM p_pos_config_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'next_sequence: no se pudo obtener la secuencia (%, %, %)',
      p_doc_type, p_fiscal_year, p_pos_config_id;
  END IF;

  v_number := v_seq.next_number;

  UPDATE finance.document_sequences
     SET next_number = v_number + 1
   WHERE id = v_seq.id;

  RETURN v_seq.prefix || '/' || p_fiscal_year::text || '/' || lpad(v_number::text, v_seq.padding, '0');
END
$$;

REVOKE ALL ON FUNCTION finance.next_sequence(UUID, VARCHAR, INTEGER, UUID) FROM public;
GRANT EXECUTE ON FUNCTION finance.next_sequence(UUID, VARCHAR, INTEGER, UUID) TO authenticated, service_role;

-- 3. compute_entry_hash (unchanged logic)
CREATE OR REPLACE FUNCTION finance.compute_entry_hash(
  p_entry_data    JSONB,
  p_previous_hash VARCHAR
)
RETURNS VARCHAR
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(
    digest(coalesce(p_previous_hash, '') || coalesce(p_entry_data::text, ''), 'sha256'),
    'hex'
  )::varchar;
$$;

-- 4. verify_hash_chain
CREATE OR REPLACE FUNCTION finance.verify_hash_chain(
  p_organization_id UUID,
  p_journal_id      UUID
)
RETURNS TABLE (entry_id UUID, is_valid BOOLEAN)
LANGUAGE plpgsql
STABLE
SET search_path = public, finance, extensions, pg_temp
AS $$
DECLARE
  r         RECORD;
  v_prev    VARCHAR := '';
  v_expect  VARCHAR;
BEGIN
  IF auth.uid() IS NOT NULL AND p_organization_id NOT IN (SELECT public.fn_user_org_ids()) THEN
    RAISE EXCEPTION 'verify_hash_chain: organization no autorizada' USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT je.id, je.hash_data, je.previous_hash, je.hash_chain
      FROM finance.journal_entries je
     WHERE je.organization_id = p_organization_id
       AND je.journal_id      = p_journal_id
       AND je.hash_chain IS NOT NULL
     ORDER BY je.hash_seq, je.id
  LOOP
    v_expect := finance.compute_entry_hash(r.hash_data, v_prev);

    entry_id := r.id;
    is_valid := (r.hash_chain = v_expect)
            AND (coalesce(r.previous_hash, '') = v_prev);
    RETURN NEXT;

    v_prev := r.hash_chain;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION finance.verify_hash_chain(UUID, UUID) FROM public;
GRANT EXECUTE ON FUNCTION finance.verify_hash_chain(UUID, UUID) TO authenticated, service_role;

-- 5. prevent_posted_modification (unchanged logic)
CREATE OR REPLACE FUNCTION finance.prevent_posted_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state::text <> 'posted' THEN
    RETURN NEW;
  END IF;

  IF NEW.state::text = 'cancelled'
     AND (to_jsonb(NEW) - 'state' - 'updated_by' - 'updated_at')
       = (to_jsonb(OLD) - 'state' - 'updated_by' - 'updated_at')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Registro % de %.% esta publicado (posted) y es inmutable. Solo se permite anularlo (posted -> cancelled); para corregir use nota de credito o reversion.',
    OLD.id, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
