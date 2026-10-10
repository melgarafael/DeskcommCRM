-- 0074 — score de probabilidade com evidência (CORE 3, Wave 5)
--
-- A LEI DESTA WAVE, e ela mora no banco, não no app: score sem `reason` NÃO É
-- GRAVADO. Validação de aplicação morre no primeiro caminho novo que esquecer
-- de chamar — e caminho novo é o que mais nasce aqui. Um número sem porquê na
-- tela é o "dado que não muda decisão" que a doutrina do épico proíbe: o humano
-- não consegue nem concordar nem DISCORDAR dele.
--
-- A evidência também é exigida, e pelo mesmo motivo do lastro da 0071: razão
-- sem referência é adjetivo. Se o card diz "quente", tem de haver o FATO por
-- trás (uma atividade, uma mensagem, um checkpoint) — não uma frase bonita
-- gerada junto com o número.
--
-- `ai_probability_band` existe porque HISTERESE precisa de memória. Sem a faixa
-- anterior persistida, um score oscilando em volta do limiar faz o card piscar a
-- cada recálculo, e sinal que pisca é sinal em que o usuário para de olhar — o
-- score viraria enfeite. A regra de transição vive no TypeScript (testada com o
-- caso oscilante); a coluna é só a memória dela.
--
-- Quem escreve isto é WORKER consumindo `event_log`. Nunca trigger: trigger que
-- calcula score faria o INSERT de qualquer mensagem esperar pelo cálculo.

alter table public.crm_leads
  add column if not exists ai_probability numeric(5, 2),
  add column if not exists ai_probability_reason text,
  add column if not exists ai_probability_evidence jsonb not null default '{}'::jsonb,
  add column if not exists ai_probability_at timestamptz,
  add column if not exists ai_probability_band text,
  add column if not exists ai_probability_band_since timestamptz;

-- ---- backfill ANTES da constraint ----
-- Não há linha com score hoje (colunas nascendo agora), mas a ordem é doutrina:
-- a constraint nasce depois dos dados estarem coerentes, senão o `update.sh` de
-- um clone com dado velho quebra. Se alguma linha chegar aqui com score órfão
-- de razão, o score é apagado — não a razão inventada.
update public.crm_leads
   set ai_probability = null,
       ai_probability_at = null,
       ai_probability_band = null,
       ai_probability_band_since = null
 where ai_probability is not null
   and (
     ai_probability_reason is null
     or btrim(ai_probability_reason) = ''
     or coalesce(jsonb_array_length(ai_probability_evidence -> 'activity_ids'), 0)
        + coalesce(jsonb_array_length(ai_probability_evidence -> 'message_ids'), 0)
        + coalesce(jsonb_array_length(ai_probability_evidence -> 'checkpoint_ids'), 0) = 0
   );

-- Implicação, não igualdade: "se há score, então há razão E lastro". Ausência de
-- score continua livre — lead sem sinal suficiente não mostra score inventado
-- (cenário 17), e é isso que `null` significa aqui.
alter table public.crm_leads
  drop constraint if exists crm_leads_score_needs_reason;

alter table public.crm_leads
  add constraint crm_leads_score_needs_reason check (
    ai_probability is null
    or (
      ai_probability_reason is not null
      and btrim(ai_probability_reason) <> ''
      and coalesce(jsonb_array_length(ai_probability_evidence -> 'activity_ids'), 0)
        + coalesce(jsonb_array_length(ai_probability_evidence -> 'message_ids'), 0)
        + coalesce(jsonb_array_length(ai_probability_evidence -> 'checkpoint_ids'), 0) > 0
    )
  );

-- `jsonb_array_length(...) > 0` e NÃO `evidence ? 'activity_ids'`: a segunda
-- forma passa com array VAZIO, que é lastro nenhum com cara de lastro. Mesma
-- armadilha já paga na 0071.

alter table public.crm_leads
  drop constraint if exists crm_leads_score_range;

alter table public.crm_leads
  add constraint crm_leads_score_range check (
    ai_probability is null or (ai_probability >= 0 and ai_probability <= 100)
  );

alter table public.crm_leads
  drop constraint if exists crm_leads_score_band_check;

alter table public.crm_leads
  add constraint crm_leads_score_band_check check (
    ai_probability_band is null
    or ai_probability_band = any (array['frio', 'morno', 'quente']::text[])
  );

comment on column public.crm_leads.ai_probability is
  'Probabilidade 0-100 calculada por worker a partir de sinais que JÁ EXISTEM (lead_checkpoints.objections/commitments, lead_state.qualification, recência de last_activity_at). Nunca por trigger. null = sinal insuficiente, e é um estado legítimo: o card não mostra score inventado.';

comment on column public.crm_leads.ai_probability_reason is
  'O PORQUÊ em português, obrigatório por constraint quando há score. Existe para o humano poder DISCORDAR: sem razão citável o número é opinião sem apelação.';

comment on column public.crm_leads.ai_probability_evidence is
  'O QUE SUSTENTA (N referências), cada chave apontando para UMA tabela: activity_ids→crm_lead_activities, message_ids→messages, checkpoint_ids→lead_checkpoints. Constraint exige pelo menos uma. Não confundir com reason, que é a leitura humana desses fatos.';

comment on column public.crm_leads.ai_probability_band is
  'Faixa exibida (frio/morno/quente). Persistida porque HISTERESE precisa da faixa anterior: sem ela, score oscilando no limiar faz o card piscar a cada recálculo. A regra de transição vive no TypeScript; esta coluna é a memória dela.';

comment on column public.crm_leads.ai_probability_band_since is
  'Desde quando a faixa atual vale. Serve à confirmação por tempo/leituras da histerese e a explicar "está quente há 2 dias" sem recalcular nada.';

-- ---- coerência entre faixa e score ----
-- A faixa é PERSISTIDA (histerese precisa de memória), e valor persistido que
-- parece derivado pode divergir da fonte. Divergência tem de ser IMPOSSÍVEL DE
-- GRAVAR, não só improvável.
--
-- Os limites são os ALCANÇÁVEIS sob a histerese, não os limiares de entrada:
-- 'quente' entra em 70 mas se MANTÉM até 65 enquanto o lead desce — por isso o
-- piso é 65. Gravar 'quente' com 67 é legítimo; com 40 é impossível.
-- Os mesmos números vivem em FAIXA_LIMITES (lib/kanban/score-band.ts), que o
-- emissor e a UI consomem: uma fonte, três consumidores.
alter table public.crm_leads
  drop constraint if exists crm_leads_score_band_coherence;

alter table public.crm_leads
  add constraint crm_leads_score_band_coherence check (
    ai_probability_band is null
    or ai_probability is null
    or (ai_probability_band = 'quente' and ai_probability >= 65)
    or (ai_probability_band = 'morno' and ai_probability >= 35 and ai_probability <= 75)
    or (ai_probability_band = 'frio' and ai_probability <= 45)
  );

-- ANALYZE ao fim: `ALTER TABLE ADD COLUMN` deixa o planner sem estatística para
-- as colunas novas, e ele passa a superestimar a largura da linha. Medido: sem
-- isto, a consulta de métricas por responsável (G4-04) troca o
-- `idx_crm_leads_org_status_closed_owner` por um bitmap em outro índice — o
-- invariante de performance reprova, e nada no schema estava errado. Custa
-- milissegundos numa tabela vazia e evita um vermelho que não aponta defeito.
analyze public.crm_leads;
