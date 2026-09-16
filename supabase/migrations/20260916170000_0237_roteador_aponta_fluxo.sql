-- 0237 · O roteador de intenção pode apontar um fluxo de atendimento.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um membro do roteador (`ai_router_members`) continua roteando para o AGENTE;
-- opcionalmente passa a apontar também um FLUXO de atendimento
-- (`followup_flow_pointers` com `surface='atendimento'`). Quando a intenção
-- casa, o fluxo COMEÇA junto (o agente atende e as perguntas do fluxo guiam o
-- turno) — é a "entrada no fluxo" escolhida pelo roteamento.
--
-- ─── Por que coluna, e não tabela nova ──────────────────────────────────────
-- É uma informação por membro (0..1 fluxo), não uma entidade. Uma tabela
-- paralela só repetiria o vínculo e exigiria um segundo carregamento no mesmo
-- ponto do turno. ON DELETE SET NULL: apagar o fluxo não apaga o membro (o
-- roteamento para o agente continua valendo).
--
-- Aditiva e idempotente: nenhuma constraint nova, nenhuma função nova em
-- `public` ⇒ o item 9 da doutrina de migrations não é acionado.

alter table public.ai_router_members
  add column if not exists flow_pointer_id uuid
    references public.followup_flow_pointers(id) on delete set null;

comment on column public.ai_router_members.flow_pointer_id is
  'Fluxo de atendimento (surface=atendimento) que começa quando esta intenção casa. NULL = só roteia agente.';

create index if not exists idx_ai_router_members_flow
  on public.ai_router_members (flow_pointer_id)
  where flow_pointer_id is not null;

notify pgrst, 'reload schema';
