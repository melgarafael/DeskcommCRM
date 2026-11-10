-- manifest: aviso de agendamento também num grupo do WhatsApp — `config_aviso_de_agendamento.grupo_destino` (chatId de um grupo da mesma conexão, destino extra), `entregas_de_aviso_de_agendamento.alvo` ('numero' | 'grupo') com as duas `unique` passando a ser por destino, e `fn_definir_aviso_de_agendamento` ganha `p_grupo`; aditiva, linhas antigas viram `alvo = 'numero'`.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9060 — O aviso de agendamento também vai para um grupo do WhatsApp.
--
-- Quem trabalha em equipe quer ver a agenda num grupo da empresa, sem repassar
-- mensagem. O grupo é destino EXTRA: o número continua como era, e cada
-- destino tem a SUA linha de entrega — por isso a chave da idempotência ganha
-- `alvo`. Uma unique só por evento faria o grupo e o número disputarem a mesma
-- linha, e um deles nunca sairia. O motor mora em
-- `lib/agenda/aviso-de-agendamento.ts`, no MESMO commit.
--
-- Reaplicação: tudo idempotente (`add column if not exists`, `drop … if
-- exists` + `add`, índices novos com nome novo). Linhas existentes nascem
-- `alvo = 'numero'`, então as `unique` novas (mais largas) não falham.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.config_aviso_de_agendamento
  add column if not exists grupo_destino text;
alter table public.config_aviso_de_agendamento
  drop constraint if exists config_aviso_de_agendamento_grupo_check;
alter table public.config_aviso_de_agendamento
  add constraint config_aviso_de_agendamento_grupo_check
  check (grupo_destino is null or grupo_destino ~ '^[0-9-]+@g\.us$');

alter table public.entregas_de_aviso_de_agendamento
  add column if not exists alvo text not null default 'numero';
alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_alvo_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_alvo_check
  check (alvo in ('numero', 'grupo'));

-- As chaves novas nascem ANTES de as antigas saírem: o update.sh roda sem
-- ON_ERROR_STOP, e a ordem inversa deixaria uma janela sem unique.
create unique index if not exists entregas_de_aviso_de_agendamento_evento_alvo_unico
  on public.entregas_de_aviso_de_agendamento (organization_id, event_id, alvo)
  where event_id is not null;
create unique index if not exists entregas_de_aviso_de_agendamento_resumo_alvo_unico
  on public.entregas_de_aviso_de_agendamento (organization_id, dia, alvo)
  where tipo = 'resumo';
drop index if exists public.entregas_de_aviso_de_agendamento_evento_unico;
drop index if exists public.entregas_de_aviso_de_agendamento_resumo_unico;

-- A assinatura muda (`p_grupo` no fim, com default): a de seis argumentos sai,
-- senão ficariam duas portas de escrita para a mesma tabela.
drop function if exists public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean);
create or replace function public.fn_definir_aviso_de_agendamento(
  p_org uuid,
  p_usa_numero_do_aviso_de_caso boolean,
  p_channel uuid,
  p_telefone text,
  p_ligado boolean,
  p_confirma_contato boolean default false,
  p_grupo text default null
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
  v_grupo text := nullif(btrim(coalesce(p_grupo, '')), '');
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

  -- O grupo é destino EXTRA, da mesma conexão que envia. Só a forma é
  -- conferida aqui: se o número saiu do grupo, o envio cai só para ele.
  if v_grupo is not null and v_grupo !~ '^[0-9-]+@g\.us$' then
    raise exception 'aviso_de_agendamento_grupo_invalido' using errcode = '22023';
  end if;

  select * into v_antes from public.config_aviso_de_agendamento where organization_id = p_org;

  insert into public.config_aviso_de_agendamento
    (organization_id, usa_numero_do_aviso_de_caso, channel_session_id, telefone_destino, grupo_destino, ligado, criado_por, atualizado_por)
  values
    (p_org, v_usa, v_channel, v_telefone, v_grupo, coalesce(p_ligado, false), auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set usa_numero_do_aviso_de_caso = excluded.usa_numero_do_aviso_de_caso,
        channel_session_id          = excluded.channel_session_id,
        telefone_destino            = excluded.telefone_destino,
        grupo_destino               = excluded.grupo_destino,
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
revoke all     on function public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean,text) from public, anon;
grant  execute on function public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean,text) to authenticated;

notify pgrst, 'reload schema';
