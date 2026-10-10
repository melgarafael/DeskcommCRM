-- manifest: **A intenção do roteador ganha funil e etapa de DESTINO (PR #2290, de @webtecnica; issue #2155).** O roteador (`resolve-turn-agent.ts`) decidia só o AGENTE: o card nascia no funil de entrada e ficava lá, e o agente do produto não escrevia nele — a conversa morria no time errado (medido em instalação com 3 funis/3 agentes). Cada `ai_router_members` ganha `pipeline_id` (funil) e `stage_id` (etapa) de destino; `NULL` = só roteia o agente, como antes, então instalação atualizada não muda de comportamento. FK composta com a organização em `crm_pipelines` e `crm_stages` (mesmo desenho da 0394) e `on delete set null` com coluna-lista: funil/etapa excluído zera só o destino. O turno aplica a MESMA transferência das automações (`lib/leads/transfere-para-o-funil.ts`, extraído do `create_or_move_lead`): clona no destino e encerra a origem como transferência, motivo canônico que não conta perda (0266). Recusas silenciosas: card já no destino (idempotente), destino já com negócio aberto (não duplica o card), sem negócio aberto e alvo ambíguo (§3.2). Apêndice no fim do `baseline.sql`; tipos em `lib/database.types.ts`.
-- #2155 — a intenção do roteador ganha funil e etapa de DESTINO.
--
-- O roteador só decidia o AGENTE: o card nascia no funil de entrada e ficava
-- lá (issue #2155, medida em instalação com 3 funis/3 agentes). O resolvedor
-- passa a expor `destinationPipelineId`/`destinationStageId` e o turno aplica a
-- MESMA transferência que as regras de automação já sabem fazer
-- (`transfereParaOFunil`: clona no destino e encerra a origem como transferência,
-- motivo canônico que não conta perda — migration 0266).
--
-- Sem destino configurado NADA muda: a operação com um único funil continua
-- inteira e instalação atualizada não muda de comportamento.
--
-- FK composta com a organização (mesmo desenho da 0394): uma intenção nunca
-- aponta para funil/etapa de OUTRA empresa. `on delete set null` com coluna-
-- lista zera só o destino quando o funil/etapa é excluído — a intenção continua
-- roteando o agente.

alter table public.ai_router_members
  add column if not exists pipeline_id uuid,
  add column if not exists stage_id uuid;

do $$ begin
  alter table public.ai_router_members
    add constraint ai_router_members_pipeline_mesma_org
    foreign key (organization_id, pipeline_id)
    references public.crm_pipelines (organization_id, id)
    on delete set null (pipeline_id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.ai_router_members
    add constraint ai_router_members_stage_mesma_org
    foreign key (organization_id, stage_id)
    references public.crm_stages (organization_id, id)
    on delete set null (stage_id);
exception when duplicate_object then null; end $$;

comment on column public.ai_router_members.pipeline_id is
  'Funil de DESTINO quando esta intenção casa (#2155). NULL = só roteia o agente, como antes.';
comment on column public.ai_router_members.stage_id is
  'Etapa de destino dentro de pipeline_id (#2155). NULL = a primeira etapa aberta do funil.';

notify pgrst, 'reload schema';
