-- 0076 — a evidência do score passa a exigir ÂNCORA **e** FATORES
--
-- O defeito: o CHECK guardava `activity_ids | message_ids | checkpoint_ids` e a
-- tela lê `factors`. Interseção VAZIA. Gravar só `{activity_ids:[…]}` o banco
-- ACEITA e o card diz "Sem evidências registradas"; gravar só `{factors:[…]}` o
-- banco RECUSA com 23514. Só funciona com as duas — e nada obrigava a segunda.
--
-- Por que isso é grave apesar de o escritor atual acertar: a LEI estava sendo
-- cobrada numa chave que a UI nunca lê. Qualquer outro escritor — um backfill,
-- um script, um worker futuro — satisfazia a constraint e produzia score
-- INVISÍVEL para o humano. O banco diria "tem evidência", a tela diria "sem
-- evidência", as duas certas, sobre a mesma linha.
--
-- É o anti-pattern nº 6 do CLAUDE.md ("jsonb lock-in: UI lê path direto sem
-- schema central"), que estava proibido POR ESCRITO e aconteceu assim mesmo —
-- porque proibição em texto não gera atrito no teclado. Daí o invariante que
-- acompanha esta migration (tests/invariants/evidencia-jsonb-chaves.test.ts):
-- ele falha alto no dia em que alguém acrescentar chave de um lado só.
--
-- As duas partes cobrem promessas DIFERENTES do cenário 15:
--   âncora  → "clique leva ao registro"  (evidência rastreável)
--   factors → "hover revela o porquê"    (evidência legível)
-- Uma sem a outra dá evidência ilegível ou irrastreável, e o cenário promete as
-- duas coisas.

-- ---- limpeza ANTES da constraint (doutrina) ----
-- Aqui são 0 linhas de 2, mas um clone PODE ter score sem `factors`, porque o
-- CHECK nunca exigiu. Apaga o SCORE, não inventa fatores: score sem o porquê
-- legível é exatamente o que esta migration existe para tornar impossível, e
-- fabricar a explicação que falta seria produzir o dado plausível que é pior
-- que o buraco.
update public.crm_lead_scores
   set ai_probability = null,
       ai_probability_reason = null,
       ai_probability_at = null,
       ai_probability_band = null,
       ai_probability_band_since = null,
       updated_at = now()
 where ai_probability is not null
   and coalesce(jsonb_array_length(ai_probability_evidence -> 'factors'), 0) = 0;

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_needs_reason;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_needs_reason check (
    ai_probability is null
    or (
      ai_probability_reason is not null
      and btrim(ai_probability_reason) <> ''
      -- ÂNCORA: para onde o clique leva.
      and coalesce(jsonb_array_length(ai_probability_evidence -> 'activity_ids'), 0)
        + coalesce(jsonb_array_length(ai_probability_evidence -> 'message_ids'), 0)
        + coalesce(jsonb_array_length(ai_probability_evidence -> 'checkpoint_ids'), 0) > 0
      -- FATORES: o que o hover revela. É a chave que a tela lê de verdade.
      and coalesce(jsonb_array_length(ai_probability_evidence -> 'factors'), 0) > 0
    )
  );

comment on column public.crm_lead_scores.ai_probability_evidence is
  'O QUE SUSTENTA o score, em DUAS partes que a constraint exige juntas: uma âncora (activity_ids→crm_lead_activities, message_ids→messages, checkpoint_ids→lead_checkpoints), que é para onde o clique leva; e `factors`, as parcelas legíveis que o hover revela — a chave que a UI de fato lê. Uma sem a outra dá evidência irrastreável ou ilegível, e o cenário 15 promete as duas. Ver migration 0076: as duas chaves já divergiram uma vez, com o banco cobrando uma e a tela lendo a outra.';
