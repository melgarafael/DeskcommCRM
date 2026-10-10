-- 0149: as SECURITY DEFINER que confiavam no organization_id do ARGUMENTO
--
-- Veio de um relatório de segurança da comunidade (auditoria da tag v1.0.0). A
-- metade dele sobre ACL — "as definer estão executáveis por anon" — já tinha
-- sido fechada pela 0108 e pela 0116: medido hoje, 0 de 31 definer de `public`
-- são executáveis por `anon`. Mas fechar o ACL e validar quem chamou são
-- defeitos DIFERENTES, e o segundo continuava aberto. É por isso que este furo
-- sobreviveu com o gate verde: a varredura da 0116 pergunta "quem pode
-- executar?", nunca "a função confere de qual organização é quem executou?".
--
-- As duas abaixo seguem executáveis por `authenticated` — corretamente, elas
-- têm call site com a sessão do usuário — e usavam o `p_organization_id` do
-- argumento como ÚNICO filtro de tenant. Medido num pg17 descartável com o
-- baseline da main, um usuário papel `viewer` membro só da org A, rodando como
-- role `authenticated` com o `sub` dele em `request.jwt.claims`:
--
--   INSERT direto em event_log da org B  -> ERROR: permission denied  (a RLS vale)
--   emit_event(..., p_organization_id => B) -> gravou a linha na org B
--   SELECT direto em ai_chunks da org B  -> 0 linhas               (a RLS vale)
--   retrieve_top_k_chunks(B, kb_version)  -> devolveu o texto do chunk da org B
--
-- Ou seja: a RLS está de pé e quem a contorna é a própria RPC, que roda como
-- `postgres`. `event_log` é a fila que os workers e as automações consomem, e
-- `ai_chunks` é a base de conhecimento — conteúdo que o cliente subiu.
--
-- O remédio é o guard que este schema JÁ usa em `fn_conversation_assign`:
--
--     if auth.uid() is not null and not fn_role_at_least(org, '<papel>') then
--       raise exception ...
--
-- O `auth.uid() is not null` é a parte que faz isto ser seguro SEM quebrar o
-- produto: worker, cron e trigger chamam com `service_role` (ou como `postgres`
-- dentro de um trigger), onde não há JWT e `auth.uid()` é null — esses passam
-- direto, como sempre passaram. Quem ganha a checagem é exatamente o caminho
-- que hoje fura: uma sessão de usuário real.
--
-- `fn_log_event` é um wrapper que delega a `emit_event` e herda o guard; não
-- precisa (nem deve) ganhar uma cópia da regra.

-- ---- emit_event: confere membership quando quem chama é uma sessão de usuário ----
--
-- Papel mínimo `viewer`: emitir evento da PRÓPRIA organização é comportamento
-- legítimo de qualquer membro (a UI emite ao mover card, abrir conversa etc.).
-- O que se está barrando aqui não é o papel fraco — é a organização alheia.
create or replace function public.emit_event(
  p_event_type text,
  p_entity_kind text,
  p_entity_id uuid,
  p_payload jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_organization_id uuid default null
) returns uuid
  language plpgsql security definer
  set search_path to 'public'
as $$
declare
  v_org_id uuid;
  v_event_id uuid;
begin
  v_org_id := p_organization_id;
  if v_org_id is null then
    -- Try to resolve from caller's first org (best-effort; trigger callers MUST pass it)
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  -- Sessão de usuário só emite evento da própria organização. Worker/cron/trigger
  -- (service_role ou postgres, sem JWT) têm auth.uid() null e seguem passando.
  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $$;

-- ---- retrieve_top_k_chunks: idem, na leitura da base de conhecimento ----
--
-- O COMMENT desta função já declarava a dívida em voz alta ("Caller must validate
-- p_organization_id matches authenticated tenant") — só que o caller podia ser o
-- browser de qualquer membro, e aí não há ninguém para validar. Agora valida ela.
--
-- Passa a `language plpgsql` (era `sql`) porque o guard precisa de `raise`.
--
-- ATENÇÃO ao reescrever esta função: `create or replace` recusa mudança de NOME
-- de parâmetro ("cannot change name of input parameter") e de nome de coluna do
-- retorno. Os nomes abaixo — `p_embedding`, `p_threshold` (default 0.40, não
-- 0.0) e a coluna `knowledge_source_id` — são os que estão no banco hoje, não
-- os que a leitura apressada sugere. O corpo é o mesmo de antes, incluindo o
-- `>= p_threshold` sem cast e o `limit greatest(p_k, 0)`.
create or replace function public.retrieve_top_k_chunks(
  p_organization_id uuid,
  p_kb_version_id uuid,
  p_embedding public.vector,
  p_k integer default 5,
  p_threshold real default 0.40
) returns table (
  chunk_id uuid,
  knowledge_source_id uuid,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'retrieve_top_k_chunks: caller must be an active member of the organization';
  end if;

  return query
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  where c.organization_id = p_organization_id
    and c.kb_version_id   = p_kb_version_id
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
end $$;

-- Função em `public` nasce EXPOSTA — as duas origens de EXECUTE (o grant a
-- PUBLIC que o Postgres dá ao criar, e o `ALTER DEFAULT PRIVILEGES ... TO anon`
-- do baseline). `create or replace` sobre função existente PRESERVA o ACL, mas
-- `retrieve_top_k_chunks` troca de linguagem e pode ser recriada num clone onde
-- ela não exista; repetir o revoke é barato e mantém a doutrina explícita.
revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from public, anon;
grant  execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

revoke execute on function public.retrieve_top_k_chunks(uuid, uuid, public.vector, integer, real) from public, anon;
grant  execute on function public.retrieve_top_k_chunks(uuid, uuid, public.vector, integer, real) to authenticated, service_role;

-- Nenhuma sobrecarga órfã pode sobreviver: se um clone tiver a versão antiga com
-- OUTRA assinatura, o `create or replace` acima teria criado uma função nova e
-- deixado a vulnerável viva. Não há caso conhecido (a assinatura é estável desde
-- a 0005), mas o custo de conferir é zero e o custo de errar é o furo inteiro.
do $$
declare
  v_extra text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_extra
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'retrieve_top_k_chunks'
     and p.oid::regprocedure::text <> 'retrieve_top_k_chunks(uuid,uuid,vector,integer,real)';
  if v_extra is not null then
    raise warning '0149: sobrecarga inesperada de retrieve_top_k_chunks sem o guard de membership: %', v_extra;
  end if;
end $$;

comment on function public.retrieve_top_k_chunks(uuid, uuid, public.vector, integer, real) is
  'Busca vetorial na KB de uma organização. Valida membership do chamador quando há sessão de usuário (auth.uid() não nulo); worker/cron com service_role passam direto.';
