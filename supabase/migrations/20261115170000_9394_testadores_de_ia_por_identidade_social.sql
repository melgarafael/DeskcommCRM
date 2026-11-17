-- manifest: **Testadores de IA por identidade social (Instagram/Facebook) no pré-go-live.** Canal em modo de teste ganha uma segunda lista, `channel_sessions.metadata.ai_test_social_identities` (o texto exato de `contacts.social_identity`), porque contato de rede social não tem telefone e a lista de números não o expressava. Cria a sobrecarga de 5 argumentos de `fn_configurar_pre_go_live_canal` (grava as duas listas na mesma instrução; a de 4 argumentos fica, para a imagem anterior e para quem só mexe em telefones) e ensina `fn_automatico_da_conversa` a ler a lista nova, senão o Inbox diria "ninguém atende" à conversa que a IA está respondendo. Sem DDL de tabela e sem backfill: chave ausente = lista vazia, o comportamento de hoje.
--
-- ─── Por quê ───────────────────────────────────────────────────────────────
--
-- O gate do pré-go-live (`decidirElegibilidade`, lib/ai/elegibilidade/gate.ts)
-- autorizava só por telefone (`ai_test_phone_numbers`). Contato de Instagram e
-- Facebook entra por `contacts.social_identity` =
-- `<rede>:<conta conectada (24 hex)>:<participante>` (lib/channels/zernio/ingest.ts)
-- e não tem telefone: um canal social em teste não tinha como liberar a IA
-- para UMA conta de confiança. A regra TypeScript passa a ser
-- `contatoPodeTestar` (telefone OU identidade social); esta migration leva a
-- mesma pergunta para os dois lugares em que o banco a responde sozinho.
--
-- ─── (1) a gravação: sobrecarga, não troca de assinatura ──────────────────
--
-- `create or replace` não muda assinatura, e `drop` da versão de 4 argumentos
-- quebraria a imagem anterior durante o rollback (o `agent.sh` reverte a
-- imagem, nunca o banco). A versão de 5 argumentos grava as DUAS listas na
-- mesma instrução, sem leitura-modificação-escrita no app. A PostgREST escolhe
-- a sobrecarga pelos NOMES dos argumentos: a rota manda `p_identidades` só
-- quando a tela mandou a lista social.
--
-- ─── (2) o comando da conversa ──────────────────────────────────────────────
--
-- Corpo da 9331 (`fn_automatico_da_conversa`), com a pergunta (b) ampliada.
-- O contato continua sendo lido só depois de saber que o canal está em
-- pré-go-live com alguma lista preenchida — o custo por linha da #2739 não volta.

create or replace function public.fn_configurar_pre_go_live_canal(
  p_org uuid,
  p_canal uuid,
  p_modo text,
  p_numeros text[],
  p_identidades text[]
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_linhas integer;
  v_gate text;
begin
  if p_modo is null or p_modo not in ('open', 'pre_go_live') then
    raise exception 'modo de acesso da IA inválido' using errcode = '22023';
  end if;

  if p_numeros is null or exists (
    select 1
      from unnest(p_numeros) as n(numero)
     where numero is null or numero !~ '^\+[1-9][0-9]{7,14}$'
  ) then
    raise exception 'lista de telefones de teste inválida' using errcode = '22023';
  end if;

  -- Mesma forma de `identidadeSocialDeTesteSchema` e o mesmo teto de
  -- `MAX_TESTADORES_SOCIAIS` (lib/ai/elegibilidade/pre-go-live.ts).
  if p_identidades is null
     or coalesce(cardinality(p_identidades), 0) > 50
     or exists (
       select 1
         from unnest(p_identidades) as i(identidade)
        where identidade is null
           or identidade !~ '^(instagram|facebook):[0-9a-fA-F]{24}:[A-Za-z0-9_.-]{1,128}$'
     )
  then
    raise exception 'lista de identidades sociais de teste inválida' using errcode = '22023';
  end if;

  v_gate := case when p_modo = 'pre_go_live' then 'allowlist' else 'open' end;

  update public.channel_sessions
     set metadata = jsonb_set(
       jsonb_set(
         jsonb_set(
           jsonb_set(coalesce(metadata, '{}'::jsonb), '{ai_gate}', to_jsonb(v_gate), true),
           '{ai_gate_mode}', to_jsonb(p_modo), true
         ),
         '{ai_test_phone_numbers}', to_jsonb(p_numeros), true
       ),
       '{ai_test_social_identities}', to_jsonb(p_identidades), true
     )
   where organization_id = p_org
     and id = p_canal
     and archived_at is null;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

revoke execute on function public.fn_configurar_pre_go_live_canal(uuid, uuid, text, text[], text[])
  from public, anon, authenticated;
grant execute on function public.fn_configurar_pre_go_live_canal(uuid, uuid, text, text[], text[])
  to service_role;

create or replace function public.fn_automatico_da_conversa(
  p_organization_id    uuid,
  p_channel_session_id uuid,
  p_contato_id         uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $automatico$
declare
  v_quem        boolean;
  v_metadata    jsonb;
  v_numeros     jsonb;
  v_variantes   text[];
  v_numero      text;
  v_telefone    text;
  v_identidades jsonb;
  v_identidade  text;
begin
  -- (a) HÁ QUEM ATENDA ESTE NÚMERO? Espelho de `haQuemAtendaASessao`
  -- (lib/ai/agents/quem-atende-a-sessao.ts): agente publicado na sessão, ou
  -- roteador ativo nela cujo fallback/membro pode EXECUTAR (versão publicada,
  -- não arquivado, não pausado). Medir a existência da linha em
  -- `ai_router_members` deixaria o portão aberto para roteador de membros todos
  -- pausados — a mesma correção que o SQL do worker já carrega.
  select
    exists (
      select 1
        from public.ai_agents a
        join public.ai_agent_versions v on v.id = a.published_version_id
       where a.organization_id = p_organization_id
         and a.archived_at is null
         and a.paused_at is null
         and v.status = 'published'
         and v.channel_session_id = p_channel_session_id
    )
    or exists (
      select 1
        from public.ai_routers r
       where r.organization_id = p_organization_id
         and r.is_active
         and r.channel_session_id = p_channel_session_id
         and (
           exists (
             select 1
               from public.ai_agents fa
               join public.ai_agent_versions fv on fv.id = fa.published_version_id
              where fa.id = r.fallback_agent_id
                and fa.organization_id = p_organization_id
                and fa.archived_at is null
                and fa.paused_at is null
                and fv.status = 'published'
           )
           or exists (
             select 1
               from public.ai_router_members m
               join public.ai_agents ma on ma.id = m.agent_id
               join public.ai_agent_versions mv on mv.id = ma.published_version_id
              where m.router_id = r.id
                and ma.organization_id = p_organization_id
                and ma.archived_at is null
                and ma.paused_at is null
                and mv.status = 'published'
           )
         )
    )
  into v_quem;

  if v_quem is not true then
    return false;
  end if;

  -- (b) O CANAL ESTÁ EM PRÉ-GO-LIVE? Espelho de `contatoPodeTestar`
  -- (lib/ai/elegibilidade/pre-go-live.ts): as DUAS listas do canal — telefones
  -- e identidades sociais — são a ÚNICA autorização positiva. O nono dígito é
  -- comparado nas duas direções por `fn_telefone_variantes`; a identidade
  -- social, por igualdade exata (a conta conectada faz parte dela).
  select s.metadata
    into v_metadata
    from public.channel_sessions s
   where s.id = p_channel_session_id
     and s.organization_id = p_organization_id;

  -- Canal sem metadata (o legado) não tem gate: nada a perguntar.
  if v_metadata is null then
    return true;
  end if;
  if coalesce(v_metadata ->> 'ai_gate', '') <> 'allowlist' then
    return true;
  end if;
  if coalesce(v_metadata ->> 'ai_gate_mode', '') <> 'pre_go_live' then
    return true;
  end if;

  v_numeros := v_metadata -> 'ai_test_phone_numbers';
  if v_numeros is null or jsonb_typeof(v_numeros) <> 'array' or jsonb_array_length(v_numeros) = 0 then
    v_numeros := null;
  end if;
  v_identidades := v_metadata -> 'ai_test_social_identities';
  if v_identidades is null or jsonb_typeof(v_identidades) <> 'array' or jsonb_array_length(v_identidades) = 0 then
    v_identidades := null;
  end if;
  if v_numeros is null and v_identidades is null then
    return false;
  end if;
  -- O contato é resolvido AQUI DENTRO, e não no wrapper: `comando_da_conversa`
  -- é campo calculado de conversa e a issue #2739 proíbe subconsulta a
  -- `contacts` por linha (o invariante `o-comando-da-conversa-le-o-bit-do-contato`
  -- mede). E só NESTE ponto: quem chega aqui é a conversa de um canal em
  -- pré-go-live com alguma lista de teste preenchida.
  select ct.phone_number, ct.social_identity
    into v_telefone, v_identidade
    from public.contacts ct
   where ct.id = p_contato_id
     and ct.organization_id = p_organization_id;

  -- Identidade social: igualdade exata, item fora da forma IGNORADO — a mesma
  -- regra de `lerIdentidadesSociaisDeTeste` (zod).
  if v_identidades is not null and v_identidade is not null and btrim(v_identidade) <> '' then
    if exists (
      select 1
        from jsonb_array_elements(v_identidades) as e(item)
       where jsonb_typeof(e.item) = 'string'
         and (e.item #>> '{}') ~ '^(instagram|facebook):[0-9a-fA-F]{24}:[A-Za-z0-9_.-]{1,128}$'
         and (e.item #>> '{}') = btrim(v_identidade)
    ) then
      return true;
    end if;
  end if;

  if v_numeros is null or v_telefone is null or btrim(v_telefone) = '' then
    return false;
  end if;

  v_variantes := public.fn_telefone_variantes(v_telefone);
  if coalesce(array_length(v_variantes, 1), 0) = 0 then
    return false;
  end if;

  for v_numero in select jsonb_array_elements_text(v_numeros) loop
    -- Item inválido é IGNORADO, nunca vira match permissivo — a mesma regra de
    -- `lerNumerosDeTeste` (zod): só telefone com DDI e ao menos 8 dígitos.
    if v_numero ~ '^\+[1-9][0-9 ()-]*$'
       and length(regexp_replace(v_numero, '\D', '', 'g')) >= 8
       and public.fn_telefone_variantes(v_numero) && v_variantes
    then
      return true;
    end if;
  end loop;

  return false;
end;
$automatico$;

comment on function public.fn_automatico_da_conversa(uuid, uuid, uuid)
  is 'Há agente que vai responder ESTA conversa? Espelho SQL do portão do dreno (haQuemAtendaASessao) + pré-go-live (contatoPodeTestar: telefone OU identidade social). Recebe o CONTATO (não o telefone) e resolve o número e a identidade por dentro, com a empresa: o wrapper comando_da_conversa não pode voltar a consultar contacts por linha (issue #2739). false = sem agente publicado no número, ou contato fora das listas de teste do canal. Issues #4012 e testadores sociais.';

revoke execute on function public.fn_automatico_da_conversa(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.fn_automatico_da_conversa(uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';
