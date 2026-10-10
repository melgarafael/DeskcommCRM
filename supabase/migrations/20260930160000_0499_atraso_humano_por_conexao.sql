-- ═══ Atraso humano configurável por conexão (0499) ═══
--
-- Os quatro números que governam o atraso humano ANTES da primeira bolha
-- (`lib/agent-engine/agent/atraso-humano.ts`) eram fixos em código: NOTAR
-- (~900ms), POR_CARACTERE (~22ms), MINIMO (~1200ms) e MAXIMO (~7500ms), sem
-- superfície. Uma clínica e um e-commerce querem ritmos diferentes, e os dois
-- recebiam o mesmo valor cravado (issue #653, do achado no PR #644).
--
-- Estes quatro knobs nascem em `channel_knobs` — a MESMA tabela que já guarda
-- `throttle_ms`/`jitter_max_ms` (0010) e `resposta_*` (0495) por conexão.
-- Coluna NULL = cai no default conservador em `defaults.ts`, que espelha os
-- valores de antes: regressão zero para quem não configurou.
--
-- Nenhuma migration nova se o mecanismo knob-por-conexão já existisse — ele
-- existe, e é `channel_knobs`. Estes são só quatro colunas novas na tabela
-- existente, com o MESMO contrato das vizinhas (nullable, sem default).
--
-- O jitter entre bolhas (`1200 + rand*800` em `inbound-turn.ts`) NÃO ganha
-- coluna nova: ele já é `throttle_ms + jitter_max_ms` (defaults 1200/800) —
-- o que mudou foi o call site passar a LER os knobs da conexão em vez do
-- literal. O preenchimento acima e a exposição na ficha Anti-ban valem para
-- o par.

alter table public.channel_knobs
  add column if not exists atraso_notar_ms integer,
  add column if not exists ms_por_caractere integer,
  add column if not exists atraso_minimo_ms integer,
  add column if not exists atraso_maximo_ms integer;

comment on column public.channel_knobs.atraso_notar_ms is
  'Parcela fixa do atraso humano (ms): ver a notificação e abrir a conversa. NULL = default (900).';
comment on column public.channel_knobs.ms_por_caractere is
  'Taxa de digitação do atraso humano (ms por caractere). NULL = default (22).';
comment on column public.channel_knobs.atraso_minimo_ms is
  'Piso do atraso humano (ms). NULL = default (1200).';
comment on column public.channel_knobs.atraso_maximo_ms is
  'Teto do atraso humano (ms). NULL = default (7500).';

-- Sanidade: valores positivos e dentro do mesmo teto dos vizinhos (intervalMaxMs).
-- O `drop … if exists` antes do `add` é o que torna o apêndice reaplicável.
alter table public.channel_knobs
  drop constraint if exists channel_knobs_atraso_humano_saneamento;

alter table public.channel_knobs
  add constraint channel_knobs_atraso_humano_saneamento
  check (
    (atraso_notar_ms   is null or (atraso_notar_ms   between 0 and 600000))
    and (ms_por_caractere is null or (ms_por_caractere between 0 and 1000))
    and (atraso_minimo_ms is null or (atraso_minimo_ms between 0 and 600000))
    and (atraso_maximo_ms is null or (atraso_maximo_ms between 0 and 600000))
    and (atraso_maximo_ms is null or atraso_minimo_ms is null or atraso_maximo_ms >= atraso_minimo_ms)
  );