-- manifest: **Fila de atendimento — o destino e o horário.** `conversations.sector_id` (FK composta com a organização, `on delete set null (sector_id)`), `attendant_sectors.schedule` (mesmo shape tz-aware de `attendant_availability.schedule`) e `attendant_sector_members` com N atendentes por fila; a distribuição automática (`fn_channel_routing_claim`) recusa candidato fora da fila da conversa.
--
-- 9062 — fila de atendimento: o destino da conversa, o horário da fila e N
-- atendentes por fila.
--
-- ─── O defeito que esta migration abre a porta para consertar ──────────────
--
-- A 0801 criou `attendant_sectors` e os atendentes por setor. O docblock dela e
-- o texto do catálogo (`lib/recursos-opcionais/catalogo.ts`) dizem a mesma
-- coisa, de propósito: *"Agrupa os atendentes por área e filtra a aba Atendimento
-- por setor. **Não muda quem recebe as conversas**."* Medido na `main` em
-- 31/10/2026: nenhuma coluna em `conversations` aponta para um setor, e o
-- roteamento (`lib/routing/eligibles.ts`) só conhece dois escopos —
-- `conversation_channel` e `organization_summary`. Ou seja: o setor agrupa, mas
-- não é DESTINO.
--
-- Sem destino não existe fila. Tudo o que a operação pede em cima disso —
-- "o cliente escolheu o comercial", "o financeiro atende só até as 18h", "o
-- suporte tem três atendentes e o comercial dois" — precisa de três coisas no
-- banco, e são exatamente as três que entram aqui.
--
-- ─── 1. `conversations.sector_id`: o destino mora na CONVERSA ──────────────
--
-- Quem escolhe a fila é o cliente (menu, triagem por IA) ou o operador — e a
-- escolha tem de sobreviver ao refresh, ao realtime e à troca de atendente.
-- Guardar isso em `organizations.settings` (por canal) expressaria a vontade do
-- GESTOR, não a escolha da pessoa que está falando com a empresa.
--
-- FK COMPOSTA `(organization_id, sector_id)`, e não a FK simples de `sector_id`:
-- com a simples, uma escrita errada (ou um handler que esqueça de filtrar a org)
-- consegue pendurar a conversa de uma empresa no setor de OUTRA, e o erro só
-- aparece na tela de quem não devia ver. A composta usa o `unique
-- (organization_id, id)` que a 0801 já criou em `attendant_sectors`.
--
-- `on delete set null (sector_id)` — a LISTA DE COLUNAS é o detalhe que faz a
-- migration funcionar: sem ela, o padrão do Postgres anula TODAS as colunas da
-- FK, `organization_id` inclusive, e apagar um setor passaria a estourar
-- `not null violation` em toda conversa daquele setor. Com a lista, apagar a
-- fila solta a conversa (ela volta ao comportamento de hoje, sem dono e sem
-- fila) e não apaga nada — que é a regra do produto: fila organiza, não é dono
-- do histórico.
--
-- ─── 2. `attendant_sectors.schedule`: o horário da FILA ────────────────────
--
-- Mesmo SHAPE e mesma régua de `attendant_availability.schedule`:
-- `{ timezone, windows: [{ dow, start, end }] }`, validado em TypeScript por
-- `availabilityScheduleSchema` (fuso conferido contra o `Intl`, `start < end`,
-- no máximo 50 janelas). Dois formatos para a mesma pergunta seriam a
-- duplicação que este repo já pagou caro — e `isWithinSchedule`
-- (`lib/routing/eligibility.ts`) é a MESMA função que passa a responder pela
-- fila. `{}` (default) = 24/7: janela existe para RESTRINGIR, nunca para
-- habilitar, igual à jornada da pessoa.
--
-- ─── 3. `attendant_sector_members` com N filas por atendente ───────────────
--
-- A 0801 fechou a PK em `(organization_id, user_id)` — "um setor por
-- atendente". Isso não cobre o caso que a fila existe para resolver: a
-- recepção cobre comercial e financeiro, o suporte de manhã e o comercial à
-- tarde. A PK passa a `(organization_id, user_id, sector_id)`.
--
-- A troca é SEM PERDA: toda linha existente continua existindo, passa a ser o
-- primeiro vínculo de cada pessoa. O bloco é idempotente nos dois sentidos —
-- confere a definição da PK antes de mexer — porque esta migration pode rodar
-- num clone que já a aplicou (o `update.sh` de quem instalou numa VPS).
--
-- ─── 4. A guarda na distribuição (`fn_channel_routing_claim`) ──────────────
--
-- A coluna sozinha não é a regra: alguém tem de RECUSAR entregar a conversa a
-- quem não é da fila. A função que faz o claim é o único ponto por onde passam
-- o worker de rodízio e o handoff da IA (`lib/routing/worker.ts`,
-- `lib/mcp/tools/handoff.ts`), então a guarda mora ali — uma régua, quatro
-- caminhos, no mesmo espírito de `loadEligibleAttendants`.
--
-- Ela NÃO mexe em atribuição manual: `fn_conversation_assign` continua
-- aceitando o que o humano decidir. Fila governa a DISTRIBUIÇÃO automática; o
-- operador que quiser pôr alguém de fora na conversa continua podendo, e isso é
-- declaração de produto, não esquecimento.
--
-- ─── Compatibilidade ───────────────────────────────────────────────────────
--
-- * Sem fila (`sector_id is null`) NADA muda: é o estado de toda conversa de
--   toda instalação hoje, e o módulo `setores` continua desligado por padrão —
--   com ele desligado, as rotas de setor respondem 404 e nenhuma conversa
--   ganha fila.
-- * Coluna nova é nullable e sem default: `alter table` instantâneo. A FK
--   valida uma vez (scan), como toda FK nova.
-- * Nada de tabela nova, nada de backfill, nada reescrito. `if not exists` em
--   tudo, DO block onde o DDL não tem forma idempotente (PK e FK).
-- * O baseline espelha este bloco porque é ele que o kit self-host aplica
--   (`scripts/test-db.sh` roda o baseline em install e em update).

alter table public.conversations add column if not exists sector_id uuid;

do $mig$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'conversations_sector_fk'
       and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations
      add constraint conversations_sector_fk
      foreign key (organization_id, sector_id)
      references public.attendant_sectors (organization_id, id)
      on delete set null (sector_id);
  end if;
end;
$mig$;

comment on column public.conversations.sector_id is
  'Fila de atendimento da conversa (migration 9062). NULL = sem fila, o comportamento de sempre. FK composta com a organização; apagar a fila solta a conversa e não apaga histórico. Governa a distribuição automática (fn_channel_routing_claim), não a atribuição manual.';

create index if not exists conversations_org_sector_awaiting
  on public.conversations (organization_id, sector_id, awaiting_since)
  where sector_id is not null;

alter table public.attendant_sectors
  add column if not exists schedule jsonb not null default '{}'::jsonb;

comment on column public.attendant_sectors.schedule is
  'Horário de funcionamento da fila (migration 9062): { timezone, windows: [{ dow, start, end }] }, o MESMO shape de attendant_availability.schedule. {} = 24/7 — janela existe para restringir. Lido por isWithinSchedule em lib/routing/eligibility.ts; escrita só pela rota PATCH /api/v1/attendants/sectors/[id] (manager+).';

do $mig$
begin
  if exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'attendant_sector_members'
       and c.contype = 'p'
       and pg_get_constraintdef(c.oid) not like '%sector_id%'
  ) then
    alter table public.attendant_sector_members
      drop constraint attendant_sector_members_pkey;
  end if;

  if not exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'attendant_sector_members'
       and c.contype = 'p'
  ) then
    alter table public.attendant_sector_members
      add primary key (organization_id, user_id, sector_id);
  end if;
end;
$mig$;

comment on table public.attendant_sector_members is
  'Vínculo atendente → fila (migrations 0801 e 9062). N filas por atendente: PK (organization_id, user_id, sector_id). Apagar a fila solta os atendentes dela.';

create or replace function public.fn_channel_routing_claim(p_org uuid,p_conversation uuid,p_channel uuid,p_user uuid,p_schedule jsonb default null,p_reason text default 'routing')
returns text language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid; member_id uuid; v_policy_id uuid; v_default uuid; availability public.attendant_availability; current_load integer;
begin
 if p_reason not in('routing','handoff') then raise exception 'routing_reason_invalid' using errcode='22023';end if;
 select contact_id into pre_contact from public.conversations where organization_id=p_org and id=p_conversation;
 if not found then return 'conversation_changed';end if;
 perform public.fn_service_lock(p_org,pre_contact);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text,228));
 -- Task9: o trigger de status do canal toca conversas; ordem comum channel -> conversation.
 perform 1 from public.channel_sessions where organization_id=p_org and id=p_channel for share;
 if not found then return 'conversation_changed';end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation for no key update;
 if not found or c.contact_id is distinct from pre_contact or c.channel_session_id is distinct from p_channel
  or c.status not in('open','pending','claimed','ai_handling') then return 'conversation_changed';end if;
 if c.assigned_to_user_id is not null then return 'already_assigned';end if;
 select id into member_id from public.user_organizations where organization_id=p_org and user_id=p_user
  and revoked_at is null and role in('agent','manager','admin') for share;
 if not found then return 'candidate_revoked';end if;
 -- (migration 0663, issue #2331) O destino padrão do número é aceito mesmo que
 -- não esteja na lista de responsáveis: são ajustes distintos (responsáveis
 -- restringem o rodízio; o destino padrão é entrega direta).
 select id,default_assignee_user_id into v_policy_id,v_default from public.channel_routing_policies where organization_id=p_org and channel_session_id=p_channel;
 if found and p_user is distinct from v_default
  and not exists(select 1 from public.channel_routing_responsibles r where r.organization_id=p_org and r.policy_id=v_policy_id and r.user_id=p_user)
 then return 'candidate_not_allowed';end if;
 -- (migration 9062) FILA É DESTINO: com fila na conversa, a distribuição
 -- automática não sai dela. Vale para o worker de rodízio e para o handoff da IA,
 -- que entram por esta função; a atribuição MANUAL não passa aqui de propósito.
 -- Módulo `setores` desligado ⇒ a fila não manda (mesma leitura de
 -- lib/instalacao/modulos.ts: só `ligado` liga). Quem liga, usa e desliga não
 -- fica com a fila velha gravada restringindo o rodízio sem tela que a mostre.
 if c.sector_id is not null
  and exists(select 1 from public.platform_config pc where pc.chave='MODULO_SETORES' and pc.valor='ligado')
  and not exists(select 1 from public.attendant_sector_members m where m.organization_id=p_org
                  and m.sector_id=c.sector_id and m.user_id=p_user)
 then return 'candidate_not_in_sector';end if;
 select * into availability from public.attendant_availability where organization_id=p_org and user_id=p_user for share;
 if not found or not availability.is_available or (p_schedule is not null and availability.schedule is distinct from p_schedule)
 then return 'capacity_changed';end if;
 select count(*) into current_load from public.conversations where organization_id=p_org and assigned_to_user_id=p_user and status in('open','pending','claimed','ai_handling');
 if current_load>=availability.capacity then return 'capacity_changed';end if;
 perform public.fn_conversation_assign(p_org,p_conversation,p_user,p_reason,null,true);
 return 'assigned';
end;
$$;
revoke all on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

notify pgrst, 'reload schema';
