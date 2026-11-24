-- manifest: o chat no site entra como canal `webchat` — o provider e o canal da conversa aceitam o valor, a conexão guarda a chave pública (única entre conexões ativas) e as origens permitidas (CHECK por função imutável, teto de 20, só https sem caminho), e o plano não conta o chat como número. Spec 36, F1, Task 1.
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. Duas colunas em `channel_sessions`: `webchat_public_key` (a chave que o
--      widget manda; `wck_` + 32 bytes aleatórios em base64url, gerada pela rota)
--      e `webchat_allowed_origins` (as origens que podem abrir o widget, not null
--      com default vazio).
--   2. `fn_webchat_origens_validas(text[])`: no máximo 20 itens, cada um
--      `https://` + host + porta opcional, sem caminho; e `http://localhost` +
--      porta opcional, para a instalação em loopback. O banco aceita o localhost;
--      QUEM decide se ele vale é a rota, porque depende da instalação.
--   3. `'webchat'` no vocabulário de `channel_sessions.provider` e no ramo do
--      `channel_sessions_provider_ref_check` (exige a chave pública).
--   4. `'webchat'` em `conversations_channel_check`: sem ele a primeira mensagem
--      do visitante não grava a conversa.
--   5. Índice único da chave pública entre conexões NÃO arquivadas: duas conexões
--      ativas com a mesma chave disputariam a mesma caixa de entrada.
--   6. `fn_trava_canais_do_plano` ignora `webchat` como já ignora `wacalls`: o chat
--      não é número de WhatsApp e não ocupa a vaga do plano.
--
-- `webhook_events_log_provider_check` NÃO muda: o chat não chega por webhook de
-- terceiro. `contacts` não ganha coluna: o contato usa
-- `social_identity = webchat:<channel_session_id>:<visitante_id>`.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `add column if not exists`; `create or replace` na função; as constraints
-- trocadas com drop + add dentro de um bloco `do` (o `update.sh` roda sem
-- `ON_ERROR_STOP`: um drop solto sem o add deixaria a tabela sem guarda); o
-- índice com `if not exists`; os `comment on` dentro de `to_regclass`.

alter table public.channel_sessions
  add column if not exists webchat_public_key text,
  add column if not exists webchat_allowed_origins text[] not null default '{}';

create or replace function public.fn_webchat_origens_validas(origens text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(cardinality(origens), 0) <= 20
     and not exists (
       select 1 from unnest(origens) as o
        where o is null
           or (o !~* '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$'
               and o !~* '^http://localhost(:[0-9]{1,5})?$')
     );
$$;

revoke execute on function public.fn_webchat_origens_validas(text[]) from public, anon;
grant  execute on function public.fn_webchat_origens_validas(text[]) to authenticated, service_role;

do $$
begin
  alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
  alter table public.channel_sessions add constraint channel_sessions_provider_check
    check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text,
                                 'wacalls'::text, 'zernio_social'::text, 'datafy'::text,
                                 'telegram'::text, 'webchat'::text]));

  alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
  alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null) or
    (provider = 'telegram'   and telegram_bot_id      is not null) or
    (provider = 'webchat'    and webchat_public_key   is not null)
  );

  alter table public.channel_sessions drop constraint if exists channel_sessions_webchat_allowed_origins_check;
  alter table public.channel_sessions add constraint channel_sessions_webchat_allowed_origins_check
    check (public.fn_webchat_origens_validas(webchat_allowed_origins));
end
$$;

do $$
begin
  alter table public.conversations drop constraint if exists conversations_channel_check;
  alter table public.conversations add constraint conversations_channel_check
    check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram', 'webchat'));
end
$$;

create unique index if not exists channel_sessions_webchat_public_key_ativa_unique
  on public.channel_sessions (webchat_public_key)
  where archived_at is null;

-- Uma conexão de chat ATIVA por organização. Sem isto, dois POST simultâneos passam pela
-- checagem da rota e criam duas caixas de entrada para a mesma empresa.
create unique index if not exists channel_sessions_webchat_org_ativa_unique
  on public.channel_sessions (organization_id)
  where provider = 'webchat' and archived_at is null;

do $$
begin
  if to_regclass('public.channel_sessions') is not null then
    comment on column public.channel_sessions.webchat_public_key is
      'Chave pública do widget do chat no site (wck_...). Identifica a conexão para o navegador do visitante; NÃO é segredo e não dá acesso ao CRM. Única entre conexões não arquivadas.';
    comment on column public.channel_sessions.webchat_allowed_origins is
      'Origens (https://host[:porta]) que podem abrir o widget desta conexão. Máximo 20, sem caminho. O localhost (loopback) passa no banco; a rota decide se vale.';
  end if;
end
$$;

-- A trava do plano passa a ignorar o chat como ignora a voz (wacalls): o chat não
-- é número de WhatsApp e não ocupa vaga. Mesmo corpo da definição anterior, com
-- 'webchat' ao lado de 'wacalls' nos três pontos.
create or replace function public.fn_trava_canais_do_plano()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limite integer;
  v_em_uso integer;
begin
  if new.archived_at is not null or new.provider in ('wacalls', 'webchat') then
    return new;
  end if;
  -- Só no WAHA: nos outros provedores o número não identifica a conexão, e a
  -- linha sem número segue sendo uma conexão da empresa.
  if new.provider = 'waha' and new.phone_number is null and new.status in ('FAILED', 'STOPPED') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.archived_at is null
       and old.provider not in ('wacalls', 'webchat')
       and new.organization_id is not distinct from old.organization_id then
      return new;
    end if;
  end if;

  v_limite := public.fn_limite_do_plano(new.organization_id, 'canais');
  if v_limite is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 2281));

  select count(*) into v_em_uso
    from public.channel_sessions cs
   where cs.organization_id = new.organization_id
     and cs.archived_at is null
     and cs.provider not in ('wacalls', 'webchat')
     and (cs.provider <> 'waha' or cs.phone_number is not null or cs.status not in ('FAILED', 'STOPPED'))
     and cs.id <> new.id;

  if v_em_uso >= v_limite then
    raise exception 'limite_do_plano:canais:%', v_limite
      using errcode = 'PT402',
            detail = jsonb_build_object('recurso', 'canais', 'limite', v_limite, 'em_uso', v_em_uso)::text;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_trava_canais_do_plano() from public, anon, authenticated;

-- O reviver (9036) conta a vaga com a MESMA régua do gatilho: voz e chat no site
-- (webchat) não são número de WhatsApp. Última definição do arquivo (rfind).
create or replace function public.fn_vaga_ao_reviver_canal(p_org uuid, p_canal uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canal public.channel_sessions;
  v_limite integer;
  v_em_uso integer;
begin
  -- A MESMA trava de `fn_trava_canais_do_plano` e da reserva: contagem e
  -- tomada da vaga nunca correm em paralelo com outra conexão da empresa.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 2281));

  select * into v_canal
    from public.channel_sessions
   where organization_id = p_org and id = p_canal
   for update;

  -- Só interessa a linha que hoje NÃO ocupa vaga (WAHA morta e sem número, 0809) e
  -- vai voltar a ocupar. Número pareado, conexão em curso, arquivada e voz
  -- seguem como antes: reconectar um número que já é da empresa nunca é recusado.
  if not found
     or v_canal.archived_at is not null
     or v_canal.provider <> 'waha'
     or v_canal.phone_number is not null
     or v_canal.status not in ('FAILED', 'STOPPED') then
    return;
  end if;

  v_limite := public.fn_limite_do_plano(p_org, 'canais');
  if v_limite is not null then
    select count(*) into v_em_uso
      from public.channel_sessions cs
     where cs.organization_id = p_org
       and cs.archived_at is null
       and cs.provider not in ('wacalls', 'webchat')
       and (cs.provider <> 'waha' or cs.phone_number is not null or cs.status not in ('FAILED', 'STOPPED'))
       and cs.id <> p_canal;

    if v_em_uso >= v_limite then
      raise exception 'limite_do_plano:canais:%', v_limite
        using errcode = 'PT402',
              detail = jsonb_build_object('recurso', 'canais', 'limite', v_limite, 'em_uso', v_em_uso)::text;
    end if;
  end if;

  -- A vaga é TOMADA aqui, ainda dentro da trava: a linha passa a ser conexão
  -- em curso, que ocupa. Conferir e tomar são um passo só.
  update public.channel_sessions
     set status = 'STARTING',
         status_reason = 'connection_pending',
         last_status_change_at = now()
   where organization_id = p_org and id = p_canal;
end;
$$;

revoke execute on function public.fn_vaga_ao_reviver_canal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_vaga_ao_reviver_canal(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
