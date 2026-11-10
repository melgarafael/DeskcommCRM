-- manifest: aviso de agendamento no WhatsApp do dono — `config_aviso_de_agendamento` (uma linha por organização: número, conexão, liga/desliga, ou "usar o número do aviso de caso") e `entregas_de_aviso_de_agendamento` (uma linha por evento de agenda avisado e uma por resumo diário, com `unique` que impede aviso em dobro), RLS (config admin, histórico manager), escrita só por `fn_definir_aviso_de_agendamento` (papel, suporte, MFA, número fora das conexões da organização, confirmação de número de cliente) e expurgo com piso de 30 dias; desligado por padrão.
-- ═══════════════════════════════════════════════════════════════════════════
-- 0753 — O WhatsApp do dono é avisado dos agendamentos.
--
-- ─── O que não existia ────────────────────────────────────────────────────
--
-- Quem agenda FORA do CRM (no caderno, no celular, no Google) não enxerga o que
-- a IA e a equipe marcaram por dentro, e o resultado é marcação em dobro. O
-- aviso leva cada `appointment.created`, `.rescheduled` e `.cancelled` ao
-- WhatsApp do dono, e às 7h o resumo do dia. O motor mora em
-- `lib/agenda/aviso-de-agendamento.ts`, no MESMO commit que este arquivo.
--
-- ─── DOUTRINA DIRC, respondida ────────────────────────────────────────────
--
--   Duplicar   — não: a configuração do aviso de caso (0292) responde "para
--                onde mandar o aviso de CASO", e ligar um não pode ligar o
--                outro. A opção "usar o número do aviso de caso" é uma
--                REFERÊNCIA (o número é lido de lá no envio), não uma cópia;
--   Integrar   — `channel_session_id` e `appointment_id` são FK;
--   Referenciar— `status`, `tipo` e `erro_codigo` são vocabulário fechado, e o
--                de erro é o MESMO do aviso de caso;
--   Calcular   — "este aviso já saiu?" não é calculável depois: sem a linha de
--                entrega, a rodada seguinte do dreno mandaria de novo.
--
-- ─── UMA ENTREGA POR EVENTO, e não por agendamento ───────────────────────
--
-- Remarcar duas vezes são duas notícias; o mesmo evento reentregue pelo dreno
-- é uma só. Por isso a chave é `(organization_id, event_id)` — o id da linha do
-- `event_log` — e não `(organization_id, appointment_id)`. O resumo das 7h tem
-- a chave dele, `(organization_id, dia)`. `event_id` NÃO é FK: o `event_log`
-- tem dono próprio e não pode ser segurado por esta tabela.
--
-- **O TEXTO NUNCA É GUARDADO**, só `corpo_hash` (precedente da 0292). E,
-- diferente da 0292, NÃO há `erro_detalhe`: a causa crua do transporte é a
-- única coluna capaz de ecoar dado pessoal, e sem ela esta tabela não guarda
-- nada que a cascata de LGPD precise redigir — o primeiro nome do cliente só
-- existe no texto, que não é guardado.
--
-- ─── Por que não há CHECK de "ligado exige número" ────────────────────────
--
-- A mesma armadilha da 0292: `on delete set null` da conexão é um UPDATE, e um
-- CHECK violado abortaria a exclusão da conexão. A coerência é do trigger
-- `trg_aviso_de_agendamento_coerente`, que se autocura.
--
-- ─── REAPLICAÇÃO ──────────────────────────────────────────────────────────
--
-- Tudo idempotente (`if not exists`, `drop … if exists` + `add`, `create or
-- replace`). As tabelas nascem aqui, então nenhuma constraint nova incide sobre
-- dado existente (regra 8 da doutrina de migrations).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.config_aviso_de_agendamento (
  organization_id     uuid primary key references public.organizations(id) on delete cascade,
  -- `true` = a conexão e o número são os do aviso de caso, LIDOS de lá a cada
  -- envio. É o padrão porque é o caso comum: o número do dono já está lá.
  usa_numero_do_aviso_de_caso boolean not null default true,
  -- Só valem com `usa_numero_do_aviso_de_caso = false`. NULLABLE e `set null`
  -- pela mesma razão da 0292: excluir a conexão desliga, não falha.
  channel_session_id  uuid references public.channel_sessions(id) on delete set null,
  telefone_destino    text,
  ligado              boolean not null default false,
  criado_por          uuid references auth.users(id) on delete set null,
  atualizado_por      uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.config_aviso_de_agendamento
  drop constraint if exists config_aviso_de_agendamento_e164;
alter table public.config_aviso_de_agendamento
  add constraint config_aviso_de_agendamento_e164
  check (telefone_destino is null or telefone_destino ~ '^\+[1-9][0-9]{7,14}$');

create or replace function public.fn_aviso_de_agendamento_coerente()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Número próprio sem conexão ou sem número não tem por onde sair: deixar
  -- `ligado` aqui faria a tela dizer "ativo" sobre um aviso que nunca dispara.
  if not new.usa_numero_do_aviso_de_caso
     and (new.channel_session_id is null or new.telefone_destino is null) then
    new.ligado := false;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_aviso_de_agendamento_coerente() from public, anon, authenticated;

drop trigger if exists trg_aviso_de_agendamento_coerente on public.config_aviso_de_agendamento;
create trigger trg_aviso_de_agendamento_coerente
  before insert or update on public.config_aviso_de_agendamento
  for each row execute function public.fn_aviso_de_agendamento_coerente();

create table if not exists public.entregas_de_aviso_de_agendamento (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  tipo                text not null default 'aviso',
  -- O evento avisado (`event_log.id`). Sem FK — ver o cabeçalho.
  event_id            uuid,
  appointment_id      uuid references public.calendar_appointments(id) on delete cascade,
  evento              text,
  -- O dia LOCAL do resumo (`YYYY-MM-DD` no fuso da organização).
  dia                 date,
  -- O destino NO INSTANTE do envio — registro, não estado.
  destino             text not null,
  channel_session_id  uuid references public.channel_sessions(id) on delete set null,
  status              text not null default 'pendente',
  tentativas          smallint not null default 0,
  erro_codigo         text,
  external_id         text,
  corpo_hash          text,
  enviado_em          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_tipo_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_tipo_check
  check (tipo in ('aviso', 'resumo'));

alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_forma_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_forma_check
  check (
    (tipo = 'aviso' and event_id is not null and evento is not null and dia is null)
    or (tipo = 'resumo' and dia is not null and event_id is null and appointment_id is null and evento is null)
  );

alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_evento_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_evento_check
  check (evento is null or evento in ('appointment.created', 'appointment.rescheduled', 'appointment.cancelled'));

alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_status_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_status_check
  check (status in ('pendente', 'enviado', 'falhou', 'cancelado', 'para_o_resumo', 'no_resumo'));

-- O MESMO vocabulário de `entregas_de_aviso_de_caso.erro_codigo`
-- (`ERROS_DA_ENTREGA_DE_AVISO`): o mesmo canal, o mesmo transporte, o mesmo
-- anti-ban — as causas são as mesmas.
alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_erro_codigo_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_erro_codigo_check
  check (erro_codigo is null or erro_codigo in (
    'canal_desconectado',
    'canal_arquivado',
    'canal_nao_aceita_aviso_livre',
    'canal_desativado',
    'transporte_ausente',
    'destino_invalido',
    'destino_da_propria_organizacao',
    'teto_diario_do_numero',
    'sem_endereco_publico',
    'titular_anonimizado',
    'expirou',
    'falha_no_envio',
    'indeterminado'));

-- AS DUAS CHAVES DA IDEMPOTÊNCIA. O `23505` delas é o sinal que o handler lê
-- para REIVINDICAR a entrega antes de tocar a rede.
create unique index if not exists entregas_de_aviso_de_agendamento_evento_unico
  on public.entregas_de_aviso_de_agendamento (organization_id, event_id)
  where event_id is not null;
create unique index if not exists entregas_de_aviso_de_agendamento_resumo_unico
  on public.entregas_de_aviso_de_agendamento (organization_id, dia)
  where tipo = 'resumo';

-- Os leitores declarados: a lista da tela e o cancelamento por agendamento.
create index if not exists entregas_de_aviso_de_agendamento_org_idx
  on public.entregas_de_aviso_de_agendamento (organization_id, created_at desc);
create index if not exists entregas_de_aviso_de_agendamento_agendamento_idx
  on public.entregas_de_aviso_de_agendamento (organization_id, appointment_id)
  where appointment_id is not null;

drop trigger if exists trg_entregas_de_aviso_de_agendamento_updated_at on public.entregas_de_aviso_de_agendamento;
create trigger trg_entregas_de_aviso_de_agendamento_updated_at
  before update on public.entregas_de_aviso_de_agendamento
  for each row execute function public.fn_set_updated_at();

alter table public.config_aviso_de_agendamento      enable row level security;
alter table public.entregas_de_aviso_de_agendamento enable row level security;

-- `revoke all` PRIMEIRO (a lição da 0279): o default ACL do baseline daria
-- INSERT/UPDATE/DELETE a `authenticated`, e a policy seria a única barreira.
revoke all    on public.config_aviso_de_agendamento      from anon, authenticated;
revoke all    on public.entregas_de_aviso_de_agendamento from anon, authenticated;
grant  select on public.config_aviso_de_agendamento      to authenticated;
grant  select on public.entregas_de_aviso_de_agendamento to authenticated;
grant  all    on public.config_aviso_de_agendamento      to service_role;
grant  all    on public.entregas_de_aviso_de_agendamento to service_role;

-- Leitura da CONFIGURAÇÃO: `admin` (carrega o telefone de alguém da empresa).
drop policy if exists leitura_config_aviso_de_agendamento on public.config_aviso_de_agendamento;
create policy leitura_config_aviso_de_agendamento
  on public.config_aviso_de_agendamento
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

-- Leitura do HISTÓRICO: `manager` — "o aviso está saindo?" é pergunta de quem
-- opera a agenda, e a linha não guarda texto nenhum.
drop policy if exists leitura_entregas_de_aviso_de_agendamento on public.entregas_de_aviso_de_agendamento;
create policy leitura_entregas_de_aviso_de_agendamento
  on public.entregas_de_aviso_de_agendamento
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

-- ── A escrita da configuração: uma RPC, as guardas na mesma transação ─────
create or replace function public.fn_definir_aviso_de_agendamento(
  p_org uuid,
  p_usa_numero_do_aviso_de_caso boolean,
  p_channel uuid,
  p_telefone text,
  p_ligado boolean,
  p_confirma_contato boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes public.config_aviso_de_agendamento;
  v_arch timestamptz;
  v_digitos text;
  v_variantes text[];
  v_usa boolean := coalesce(p_usa_numero_do_aviso_de_caso, true);
  v_channel uuid := p_channel;
  v_telefone text := nullif(btrim(coalesce(p_telefone, '')), '');
begin
  if auth.uid() is null or p_org is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'aviso_de_agendamento_forbidden' using errcode = '42501';
  end if;
  if not public.fn_session_mfa_proven() then
    raise exception 'aviso_de_agendamento_mfa_required' using errcode = '42501';
  end if;

  if v_usa then
    -- O número do aviso de caso já passou pelas guardas da 0292 quando foi
    -- salvo. Aqui só se exige que ele EXISTA, senão a tela diria "usando o
    -- número do aviso de caso" sobre um número que não há.
    if not exists (
         select 1 from public.config_aviso_de_caso c
          where c.organization_id = p_org
            and c.channel_session_id is not null) then
      raise exception 'aviso_de_agendamento_sem_aviso_de_caso' using errcode = '22023';
    end if;
    v_channel := null;
    v_telefone := null;
  else
    if v_telefone is null or v_telefone !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception 'aviso_de_agendamento_telefone_invalido' using errcode = '22023';
    end if;
    if v_channel is null then
      raise exception 'aviso_de_agendamento_canal_invalido' using errcode = '22023';
    end if;
    select archived_at into v_arch
      from public.channel_sessions
     where id = v_channel and organization_id = p_org;
    if not found or v_arch is not null then
      raise exception 'aviso_de_agendamento_canal_invalido' using errcode = '22023';
    end if;

    -- As duas grafias do nono dígito — a MESMA regra da 0292 e de
    -- `lib/channels/phone-variants.ts`.
    v_digitos := regexp_replace(v_telefone, '\D', '', 'g');
    v_variantes := array[v_digitos];
    if v_digitos like '55%' then
      if length(v_digitos) = 13
         and substring(v_digitos from 5 for 1) = '9'
         and substring(v_digitos from 6 for 1) between '6' and '9' then
        v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || substring(v_digitos from 6));
      elsif length(v_digitos) = 12
         and substring(v_digitos from 5 for 1) between '6' and '9' then
        v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || '9' || substring(v_digitos from 5));
      end if;
    end if;

    -- O número de destino NÃO pode ser de uma conexão da própria organização:
    -- é o laço robô-com-robô (a conexão avisa o número oficial, o agente dele
    -- responde, e as duas pontas se alimentam).
    if exists (
         select 1 from public.channel_sessions s
          where s.organization_id = p_org
            and s.archived_at is null
            and s.phone_number is not null
            and regexp_replace(s.phone_number, '\D', '', 'g') = any (v_variantes)) then
      raise exception 'aviso_de_agendamento_numero_da_propria_org' using errcode = '22023';
    end if;

    -- O número de aviso vira INTERNO (o que chega dele não vira atendimento).
    -- Se ele já é um cliente, isso não pode acontecer por engano.
    if not coalesce(p_confirma_contato, false) and exists (
         select 1 from public.contacts c
          where c.organization_id = p_org
            and c.phone_number is not null
            and regexp_replace(c.phone_number, '\D', '', 'g') = any (v_variantes)) then
      raise exception 'aviso_de_agendamento_numero_de_cliente' using errcode = '22023';
    end if;
  end if;

  select * into v_antes from public.config_aviso_de_agendamento where organization_id = p_org;

  insert into public.config_aviso_de_agendamento
    (organization_id, usa_numero_do_aviso_de_caso, channel_session_id, telefone_destino, ligado, criado_por, atualizado_por)
  values
    (p_org, v_usa, v_channel, v_telefone, coalesce(p_ligado, false), auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set usa_numero_do_aviso_de_caso = excluded.usa_numero_do_aviso_de_caso,
        channel_session_id          = excluded.channel_session_id,
        telefone_destino            = excluded.telefone_destino,
        ligado                      = excluded.ligado,
        atualizado_por              = auth.uid(),
        updated_at                  = now();

  return jsonb_build_object(
    'trocou_numero', (v_antes.telefone_destino is distinct from v_telefone
                      or v_antes.usa_numero_do_aviso_de_caso is distinct from v_usa),
    'antes_ligado',  coalesce(v_antes.ligado, false)
  );
end;
$$;
-- AS DUAS ORIGENS DE EXECUTE (item 9 da doutrina de migrations).
revoke all     on function public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean) from public, anon;
grant  execute on function public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean) to authenticated;

-- ── Retenção: a tabela nasce com dono de piso ─────────────────────────────
create or replace function public.fn_expurgar_avisos_de_agendamento_vencidos(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Mesmo horizonte do aviso de caso (180 dias, piso de 30 no CORPO): a
  -- pergunta útil — "o aviso daquele horário saiu?" — é de semanas.
  v_dias int := greatest(coalesce(p_retencao_dias, 180), 30);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select e.id from public.entregas_de_aviso_de_agendamento e
     where e.created_at < now() - make_interval(days => v_dias)
     order by e.created_at
     limit v_limite
  )
  delete from public.entregas_de_aviso_de_agendamento e using vencidas v where e.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke all     on function public.fn_expurgar_avisos_de_agendamento_vencidos(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_avisos_de_agendamento_vencidos(int,int) to service_role;

comment on table public.config_aviso_de_agendamento is
  'Aviso de agendamento no WhatsApp do dono (0753). Uma linha por organização. Escrita só por fn_definir_aviso_de_agendamento.';
comment on table public.entregas_de_aviso_de_agendamento is
  'Uma linha por evento de agenda avisado (unique organization_id+event_id) e uma por resumo diário (unique organization_id+dia). O texto nunca é guardado, só corpo_hash.';

notify pgrst, 'reload schema';
