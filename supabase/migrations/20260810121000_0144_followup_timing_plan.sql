-- 0144 — plano de tempo do follow-up (o modo adaptativo deixa de ser decorativo).
--
-- O nó de espera oferece na tela o modo "Adaptativo (min–max)", com mínimo,
-- máximo e uma orientação. O motor ignorava os três e esperava SEMPRE o máximo.
-- Esta coluna guarda o plano decidido UMA VEZ no acionamento do fluxo (nó
-- trigger), para todas as esperas adaptativas de uma vez: cada nó de espera lê
-- o instante que lhe cabe em vez de enfileirar uma decisão própria.
--
-- Formato (lib/followup/timing-plan.ts é quem valida — a coluna não impõe
-- shape de propósito):
--   { "decidido_em": "<ISO>", "modelo": "<id>",
--     "esperas": { "<node_id>": { "escolhido_ms": int, "min_ms": int,
--                                 "max_ms": int, "proposto_ms": int,
--                                 "clampado": bool, "motivo": "<pt-br>" } } }
--
-- SEM CHECK e SEM NOT NULL, deliberadamente:
--   * `null` é o estado "ainda não planejado" E o de todo enrollment anterior a
--     esta migration — os dois querem dizer a mesma coisa para o motor, que cai
--     no comportamento antigo (o máximo). Não há dado a corrigir antes.
--   * um CHECK de shape sobre jsonb quebraria o `update.sh` de um clone que já
--     tivesse gravado qualquer coisa aqui; o leitor (`esperaPlanejadaDe`) já
--     degrada para o máximo diante de plano ilegível, que é o desfecho seguro.

alter table followup_enrollments
  add column if not exists timing_plan jsonb;

comment on column followup_enrollments.timing_plan is
  'Plano de tempo das esperas adaptativas, decidido uma vez no acionamento do fluxo. null = sem plano (cai no max_ms de cada espera). Ver lib/followup/timing-plan.ts.';
