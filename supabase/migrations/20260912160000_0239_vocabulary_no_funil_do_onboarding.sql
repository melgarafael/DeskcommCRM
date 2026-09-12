-- O onboarding monta o quadro (etapas) mas NUNCA gravou o vocabulary do
-- pipeline. Consequência: o admin escolhe "Clínica" no wizard, as colunas
-- ficam certas ("Consulta marcada", "Não vai marcar"), mas o agente continua
-- falando "lead", "deal", "won", "lost" porque crm_pipelines.vocabulary
-- ficou null. A tela de settings/tenant/pipelines permite editar depois,
-- mas ninguém volta lá — o defeito é silencioso e só aparece no primeiro
-- atendimento real.
--
-- Esta migration estende fn_aplicar_quadro_do_onboarding com um parâmetro
-- opcional p_vocabulary (jsonb). Quando presente e não-null, faz UPDATE em
-- crm_pipelines.vocabulary junto com o nome/slug. Retrocompatível: chamadas
-- antigas sem o parâmetro continuam funcionando (default null = não mexe).

CREATE OR REPLACE FUNCTION public.fn_aplicar_quadro_do_onboarding(
  p_organization_id uuid,
  p_pipeline_id uuid,
  p_nome text,
  p_slug text,
  p_etapas jsonb,
  p_vocabulary jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_negocios bigint;
  v_fontes bigint;
  v_criadas bigint;
begin
  -- O funil é DESTA organização? A função roda como `postgres` e passa por cima
  -- da RLS; o filtro de tenant é responsabilidade dela.
  perform 1 from public.crm_pipelines
   where id = p_pipeline_id and organization_id = p_organization_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'funil_nao_encontrado');
  end if;

  select count(*) into v_negocios
    from public.crm_leads
   where pipeline_id = p_pipeline_id
     and organization_id = p_organization_id;

  if v_negocios > 0 then
    return jsonb_build_object('ok', false, 'motivo', 'funil_com_negocios', 'quantos', v_negocios);
  end if;

  -- ON DELETE CASCADE: sem esta recusa, trocar as colunas apaga a fonte inteira.
  select count(*) into v_fontes
    from public.webhook_sources w
    join public.crm_stages s on s.id = w.default_stage_id
   where s.pipeline_id = p_pipeline_id;

  if v_fontes > 0 then
    return jsonb_build_object('ok', false, 'motivo', 'etapa_em_uso_por_webhook', 'quantos', v_fontes);
  end if;

  delete from public.crm_stages
   where pipeline_id = p_pipeline_id
     and organization_id = p_organization_id;

  insert into public.crm_stages
    (organization_id, pipeline_id, name, slug, position, is_won, is_lost, agent_stage_hint)
  select p_organization_id,
         p_pipeline_id,
         e->>'nome',
         e->>'slug',
         (e->>'position')::numeric,
         coalesce((e->>'is_won')::boolean, false),
         coalesce((e->>'is_lost')::boolean, false),
         nullif(e->>'agent_stage_hint', '')
    from jsonb_array_elements(p_etapas) as e;
  get diagnostics v_criadas = row_count;

  update public.crm_pipelines
     set name = p_nome,
         slug = p_slug,
         vocabulary = coalesce(p_vocabulary, vocabulary),
         updated_at = now()
   where id = p_pipeline_id
     and organization_id = p_organization_id;

  return jsonb_build_object('ok', true, 'etapas', v_criadas);
end$function$;