-- 0096 — toda organização nasce com um modelo de LLM padrão
--
-- O turno do agente resolve o modelo assim: knob de env → agente publicado →
-- `organizations.settings.llm.default_model`. Numa instalação self-host o env
-- não traz knob, e o `default_model` nunca era preenchido por ninguém — não há
-- tela para isso e nem o instalador o escreve.
--
-- Enquanto o turno casa um agente publicado, o modelo vem dele e tudo funciona.
-- Mas o caminho GENÉRICO — que é decisão de produto e está documentado em
-- `resolve-turn-agent.ts` ("config:null ⇒ responde com o agente genérico, não é
-- silêncio") — ficava sem modelo nenhum e o turno morria com
-- "modelo LLM não definido".
--
-- Como isso aparece na prática: basta criar um roteador de intenção sem membros
-- (a tela permite) para TODO turno cair no genérico. Medido nesta VPS: 80
-- chamadas de classificador queimadas em retry, nenhuma resposta enviada, e
-- nada na interface avisando.
--
-- Idempotente e auto-curativo: só preenche quem está sem, e escolhe o modelo
-- default do provider no catálogo (com literal de segurança se o catálogo
-- estiver vazio).

update public.organizations o
set settings = jsonb_set(
      coalesce(o.settings, '{}'::jsonb),
      '{llm}',
      coalesce(o.settings->'llm', '{}'::jsonb)
        || jsonb_build_object(
             'provider', coalesce(o.settings->'llm'->>'provider', 'anthropic'),
             'default_model', coalesce(
               (select m.model_id from public.ai_models m
                where m.provider = coalesce(o.settings->'llm'->>'provider', 'anthropic')
                  and m.is_default_for_provider
                  and m.deprecated_at is null
                limit 1),
               'claude-sonnet-4-6'
             )
           ),
      true
    )
where coalesce(o.settings->'llm'->>'default_model', '') = '';

-- Organização nova já nasce configurada: o mesmo seed que cria o funil padrão
-- passa a semear o modelo.
CREATE OR REPLACE FUNCTION "public"."fn_seed_org_llm_defaults"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if coalesce(new.settings->'llm'->>'default_model', '') = '' then
    new.settings := jsonb_set(
      coalesce(new.settings, '{}'::jsonb),
      '{llm}',
      coalesce(new.settings->'llm', '{}'::jsonb)
        || jsonb_build_object(
             'provider', 'anthropic',
             'default_model', coalesce(
               (select m.model_id from public.ai_models m
                where m.provider = 'anthropic' and m.is_default_for_provider
                  and m.deprecated_at is null limit 1),
               'claude-sonnet-4-6'
             )
           ),
      true
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_seed_org_llm_defaults on public.organizations;
create trigger trg_seed_org_llm_defaults
  before insert on public.organizations
  for each row execute function public.fn_seed_org_llm_defaults();
