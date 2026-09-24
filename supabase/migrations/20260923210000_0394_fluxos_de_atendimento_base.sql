-- ---- fluxos de atendimento: a base, desligada por padrão (migration 0394, de @vgamkt, #1130) ----
--
-- O roteiro de perguntas que a IA conduz durante a conversa (doc 64, opção a),
-- trazido como MÓDULO OPCIONAL da instalação (`MODULO_FLUXOS_DE_ATENDIMENTO` em
-- `platform_config`, 0341). Desligado, nada aqui é lido: o turno do agente não
-- consulta roteiro nenhum. Plano e decisões em
-- `docs/superpowers/plans/2026-09-23-fluxos-de-atendimento.md`.
--
-- O PR do autor criava oito migrations e duas tabelas (`contact_flow_data`,
-- `contact_flow_events`). Aqui não nasce tabela nenhuma, pela DIRC:
--
--   * a RESPOSTA do cliente vai para `contacts.custom_fields` — que já existe, já
--     é exportada no pedido do titular e já é zerada pela anonimização nos DOIS
--     caminhos (`trg_contacts_anonimizado_limpa_custom_fields`). A prova prática
--     mediu o custo da tabela própria: o CPF morava em dois lugares e o botão
--     "Anonimizar" deixava um deles para trás;
--   * a TRILHA vai para `followup_enrollment_events`, sem o valor respondido;
--   * as TENTATIVAS por pergunta são contadas dessa trilha, não guardadas.
--
-- O que muda no schema:
--
-- 1. `followup_flow_pointers.surface` aceita 'atendimento'. CHECK de conjunto:
--    no baseline, o bloco ÚNICO da 0196 é editado no lugar.
--
-- 2. `followup_enrollments.status` ganha 'coletando' — a execução de um roteiro.
--    É status PRÓPRIO, e não 'active', de propósito: todo caminho do follow-up
--    (claim do relógio, aplicar-inbound, varredura de silêncio, cancelamentos)
--    lê `status in ('active','waiting_reply')`, e o autor pagou essa classe
--    cinco vezes ao reusar 'active'. E o índice `idx_followup_enrollments_one_live`
--    (um follow-up vivo por contato) deixa de ver o roteiro: na prova, quem
--    parava no meio do roteiro NUNCA recebia a retomada automática — o roteiro
--    ocupava a vaga dele. 'coletando' entra no grupo SEM relógio do
--    `relogio_coerente` (o autor precisava gravar `next_eval_at = 2999-12-31`).
--    Os dois CHECKs vivem no bloco único da 0145, editado no lugar.
--
-- 3. Um roteiro 'coletando' por contato (índice único parcial próprio).
--
-- 4. `ai_router_members.flow_pointer_id` — a intenção do roteador pode começar
--    um roteiro. FK COMPOSTA com a organização: a FK simples deixaria um membro
--    apontar o roteiro de OUTRA empresa. Exige o índice único
--    `(organization_id, id)` em `followup_flow_pointers`.
--
-- 5. Anonimizar o contato ENCERRA o roteiro vivo, nos dois caminhos (botão e
--    pedido formal), por gatilho na virada de `is_anonymized` — o mesmo desenho
--    dos gatilhos de redação do schema. Sem ele, um roteiro 'coletando'
--    continuaria perguntando e regravando dado pessoal depois do esquecimento.
--
-- 6. Superfície e status coerentes, por gatilho em `followup_enrollments`:
--    roteiro de atendimento só existe como 'coletando' (ou terminal), e
--    'coletando' só existe em roteiro de atendimento.
--
-- 7. A superfície é IMUTÁVEL depois de criada (`trg_superficie_do_fluxo_imutavel`)
--    e roteiro só tem gatilho manual (CHECK `followup_flow_pointers_roteiro_so_manual`)
--    — revisão adversarial: sem isso, um viewer mudava pelo PostgREST a superfície
--    de um fluxo de silêncio e a varredura de silêncio abortava a cada tick.
--
-- Idempotente, sem BEGIN/COMMIT. Nenhum dado existente é reescrito: os valores
-- novos só ampliam conjuntos aceitos.

alter table public.followup_flow_pointers
  drop constraint if exists followup_flow_pointers_surface_check;
alter table public.followup_flow_pointers
  add constraint followup_flow_pointers_surface_check
  check (surface in ('followup', 'crm_automation', 'atendimento'));

alter table public.followup_enrollments
  drop constraint if exists followup_enrollments_status_valido;
alter table public.followup_enrollments
  add constraint followup_enrollments_status_valido
  check (status in ('active','waiting_reply','dormente','paused_handoff','paused_manual','coletando','completed','cancelled','dead'));

alter table public.followup_enrollments
  drop constraint if exists followup_enrollments_relogio_coerente;
alter table public.followup_enrollments
  add constraint followup_enrollments_relogio_coerente
  check (
    (status in ('active','waiting_reply','dormente') and next_eval_at is not null)
    or (status in ('paused_handoff','paused_manual','coletando','completed','cancelled','dead'))
  );

create unique index if not exists idx_followup_enrollments_um_roteiro_coletando
  on public.followup_enrollments (organization_id, contact_id)
  where status = 'coletando';

create unique index if not exists idx_followup_flow_pointers_org_id
  on public.followup_flow_pointers (organization_id, id);

alter table public.ai_router_members
  add column if not exists flow_pointer_id uuid;

do $$ begin
  alter table public.ai_router_members
    add constraint ai_router_members_flow_pointer_mesma_org
    foreign key (organization_id, flow_pointer_id)
    references public.followup_flow_pointers (organization_id, id)
    on delete set null (flow_pointer_id);
exception when duplicate_object then null; end $$;

comment on column public.ai_router_members.flow_pointer_id is
  'Roteiro de atendimento (surface=atendimento) que começa quando esta intenção casa. NULL = só roteia o agente. FK composta: só roteiro da mesma organização.';

create or replace function public.fn_contato_anonimizado_encerra_roteiro()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.followup_enrollments
     set status = 'cancelled',
         cancel_reason = 'Contato anonimizado (LGPD)',
         completed_at = now(),
         updated_at = now()
   where organization_id = new.organization_id
     and contact_id = new.id
     and status = 'coletando';
  return new;
end
$$;

revoke all on function public.fn_contato_anonimizado_encerra_roteiro() from public;
revoke execute on function public.fn_contato_anonimizado_encerra_roteiro() from anon;
revoke execute on function public.fn_contato_anonimizado_encerra_roteiro() from authenticated;

drop trigger if exists trg_contato_anonimizado_encerra_roteiro on public.contacts;
create trigger trg_contato_anonimizado_encerra_roteiro
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_contato_anonimizado_encerra_roteiro();

-- A superfície e o status andam juntos, no BANCO. Quem cria enrollment pelo
-- relógio (gatilhos de etapa, lead, caso, retorno, silêncio, o enroll manual) lê
-- o pointer pelo `trigger_config`, não pela superfície: um roteiro de
-- atendimento com gatilho de silêncio viraria enrollment 'active' e o motor de
-- follow-up executaria as perguntas como passos de relógio. E o inverso — um
-- 'coletando' num fluxo de follow-up — ocuparia a vaga do roteiro. Uma regra, um
-- lugar, para todos os produtores de hoje e os que vierem.
create or replace function public.fn_enrollment_superficie_coerente()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_surface text;
begin
  select p.surface into v_surface
    from public.followup_flow_pointers p
   where p.id = new.pointer_id;
  if v_surface = 'atendimento' and new.status not in ('coletando','completed','cancelled','dead') then
    raise exception 'roteiro de atendimento só roda como coletando (status %)', new.status
      using errcode = '23514';
  end if;
  if v_surface is distinct from 'atendimento' and new.status = 'coletando' then
    raise exception 'coletando é exclusivo de roteiro de atendimento'
      using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function public.fn_enrollment_superficie_coerente() from public;
revoke execute on function public.fn_enrollment_superficie_coerente() from anon;
revoke execute on function public.fn_enrollment_superficie_coerente() from authenticated;

drop trigger if exists trg_enrollment_superficie_coerente on public.followup_enrollments;
create trigger trg_enrollment_superficie_coerente
  before insert or update of status, pointer_id on public.followup_enrollments
  for each row
  execute function public.fn_enrollment_superficie_coerente();

-- A superfície de um fluxo é IMUTÁVEL depois de criado, e roteiro de atendimento
-- só tem gatilho manual (revisão adversarial do #1559). A policy de
-- `followup_flow_pointers` é só de tenant: qualquer membro da empresa, até
-- viewer, faria pelo PostgREST `update ... set surface = 'atendimento'` num
-- fluxo de silêncio ativo — e o `trg_enrollment_superficie_coerente` passaria a
-- recusar (23514) cada inscrição da varredura. E um PATCH de gatilho levaria um
-- roteiro publicado de Manual para Silêncio. As duas portas fecham no BANCO.
-- Nenhuma linha antes da 0394 pode ter 'atendimento' (o CHECK de conjunto o
-- recusava), então o CHECK abaixo não tem dado a corrigir.
alter table public.followup_flow_pointers
  drop constraint if exists followup_flow_pointers_roteiro_so_manual;
alter table public.followup_flow_pointers
  add constraint followup_flow_pointers_roteiro_so_manual
  check (surface <> 'atendimento' or coalesce(trigger_config->>'kind', 'manual') = 'manual');

create or replace function public.fn_superficie_do_fluxo_imutavel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.surface is distinct from old.surface then
    raise exception 'a superfície de um fluxo não muda depois de criado (% → %)', old.surface, new.surface
      using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function public.fn_superficie_do_fluxo_imutavel() from public;
revoke execute on function public.fn_superficie_do_fluxo_imutavel() from anon;
revoke execute on function public.fn_superficie_do_fluxo_imutavel() from authenticated;

drop trigger if exists trg_superficie_do_fluxo_imutavel on public.followup_flow_pointers;
create trigger trg_superficie_do_fluxo_imutavel
  before update of surface on public.followup_flow_pointers
  for each row
  execute function public.fn_superficie_do_fluxo_imutavel();

notify pgrst, 'reload schema';
