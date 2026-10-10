-- 0077 — a evidência do score passa a ter UMA FONTE SÓ
--
-- A 0076 exigiu âncora **e** `factors`, e isso consertava o caso: as duas
-- passavam a existir juntas. Mas mantinha DUAS LISTAS que precisam concordar —
-- e trocava "podem não existir juntas" por "existem juntas e podem DISCORDAR".
-- Quem gravasse `activity_ids:[X]` e um factor ancorado em `Y` satisfaria o
-- CHECK e mentiria igual, agora sem sintoma: as duas passam.
--
-- Conserto que transforma um defeito visível num defeito silencioso é pior que
-- não consertar. Por isso as chaves de arrays de ids SAEM do evidence do score:
-- a âncora passa a morar DENTRO de cada fator, que é onde a UI já a lê.
--
-- Com uma fonte só não há o que divergir, e a promessa do cenário 15 fica
-- cobrada por construção:
--   "hover revela o porquê"  → `factors` não-vazio
--   "clique leva ao registro" → pelo menos um fator COM âncora
--
-- ⚠️ O FORMATO AQUI É DIFERENTE DE `crm_lead_activities.evidence` DE PROPÓSITO,
-- e unificar os dois REINTRODUZ o problema que esta migration existe para
-- matar. Atividade cita FATOS de N tabelas (por isso arrays de ids por tabela);
-- score cita PARCELAS de um cálculo, cada uma com seu peso, sua frase e seu
-- destino. Forçar o mesmo formato foi o que criou a divergência da 0076.
-- Uniformidade de forma entre coisas que significam coisas diferentes é
-- semelhança acidental, não coerência — quem vier depois vai ver dois formatos
-- e achar que encontrou uma inconsistência para arrumar. Não é.

-- ---- limpeza ANTES da constraint ----
-- Hoje são 0 linhas de 2, mas o CHECK nunca exigiu âncora DENTRO do fator: um
-- clone pode ter `factors` sem âncora nenhuma, e essa linha passa hoje e
-- reprovaria depois. Apaga o SCORE — não inventa âncora, porque âncora
-- fabricada aponta para um registro que não sustenta nada e é indistinguível
-- da verdadeira.
update public.crm_lead_scores
   set ai_probability = null,
       ai_probability_reason = null,
       ai_probability_at = null,
       ai_probability_band = null,
       ai_probability_band_since = null,
       updated_at = now()
 where ai_probability is not null
   and (
     coalesce(jsonb_array_length(ai_probability_evidence -> 'factors'), 0) = 0
     or not (ai_probability_evidence @? '$.factors[*].ancora')
   );

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_needs_reason;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_needs_reason check (
    ai_probability is null
    or (
      ai_probability_reason is not null
      and btrim(ai_probability_reason) <> ''
      -- LEGÍVEL: o que o hover revela.
      and coalesce(jsonb_array_length(ai_probability_evidence -> 'factors'), 0) > 0
      -- RASTREÁVEL: para onde o clique leva. `@?` com jsonpath em vez de
      -- subconsulta, que CHECK não aceita — e é o que permite exigir a âncora
      -- DENTRO do fator, mantendo a fonte única.
      and ai_probability_evidence @? '$.factors[*].ancora'
    )
  );

comment on column public.crm_lead_scores.ai_probability_evidence is
  'O QUE SUSTENTA o score, em FONTE ÚNICA: `factors` — cada parcela com `pontos` (com sinal), `frase` legível e, quando há ponto no tempo, `ancora` {kind,id}. A constraint exige factors não-vazio E pelo menos um fator com âncora: legível sem rastreável é adjetivo, rastreável sem legível é um id que ninguém entende. NÃO unificar com o formato de crm_lead_activities.evidence (arrays de ids por tabela): a diferença é deliberada e está explicada na migration 0077 — atividade cita FATOS de N tabelas, score cita PARCELAS de um cálculo. Unificar reintroduz as duas listas que já divergiram uma vez (0076), com o banco cobrando uma chave e a tela lendo outra.';
