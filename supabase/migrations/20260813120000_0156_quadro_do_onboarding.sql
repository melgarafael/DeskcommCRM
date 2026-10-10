-- 0156: o quadro de clientes montado no onboarding, numa transação só
--
-- ═══ O PROBLEMA ═══
--
-- `trg_seed_default_pipeline_for_org` semeia o MESMO funil de e-commerce em toda
-- organização criada: "Carrinho abandonado", "Aguardando pagamento", "Em
-- separação", "Enviado". Num produto que se declara multi-nicho, a clínica
-- termina a instalação e abre o quadro dela com uma coluna chamada "Carrinho
-- abandonado". O gatilho continua: uma organização precisa nascer com ALGUM
-- funil, senão o primeiro lead não tem onde entrar. O que faltava era o passo do
-- wizard que troca esse quadro por um que sirva.
--
-- E tem a metade que não se vê. Medido neste banco em 2026-08-13:
--
--   select count(*), count(*) filter (where agent_stage_hint is not null)
--     from crm_stages;   ->   312 |  4
--
-- Quatro. E as quatro são de organizações de teste. Ou seja, toda instalação
-- real nasce com o assistente incapaz de mover UM card: `coberturaDoFunil()`
-- devolve `mudo: true`. Por isso a gravação aqui insere `agent_stage_hint` junto
-- com o nome — trocar as colunas sem ensinar o caminho seria trocar um quadro
-- errado por um quadro certo e igualmente parado.
--
-- ═══ POR QUE UMA FUNÇÃO, E NÃO QUATRO CHAMADAS DO CLIENTE ═══
--
-- A troca é DELETE das etapas seguido de INSERT das novas, e a ordem é
-- obrigatória: `uniq_crm_stages_pipeline_won`, `uniq_crm_stages_pipeline_hint` e
-- `uniq_crm_stages_pipeline_slug` são imediatos, então qualquer estado
-- intermediário com as duas gerações no mesmo funil é recusado pelo banco.
--
-- Só que o cliente JS não tem transação. Pelo cliente, um DELETE que passa
-- seguido de um INSERT que falha deixa o funil SEM NENHUMA COLUNA — um quadro
-- vazio, que é pior que o quadro errado com que a pessoa começou, e num passo
-- de onboarding onde ela não tem como saber o que aconteceu. Aqui os dois vivem
-- na mesma transação implícita da função: ou o quadro inteiro troca, ou nada
-- muda.
--
-- ═══ AS DUAS RECUSAS ═══
--
-- (1) FUNIL COM NEGÓCIO. `crm_leads_stage_id_fkey` é ON DELETE RESTRICT, então o
--     DELETE falharia — mas falharia como erro do Postgres numa tela de
--     onboarding. Recusar antes devolve um motivo que a tela sabe explicar.
--
-- (2) ETAPA USADA POR UMA FONTE DE WEBHOOK. Esta é a silenciosa:
--     `webhook_sources.default_stage_id` referencia `crm_stages` com ON DELETE
--     **CASCADE**. O DELETE não falha — ele APAGA A FONTE DE WEBHOOK INTEIRA, em
--     silêncio, e as integrações que mandavam lead para ela param sem nada ficar
--     vermelho. É o "cascade fantasma" que a doutrina deste repositório lista
--     como anti-pattern. Uma organização em onboarding normalmente não tem
--     nenhuma; "normalmente" não é um lugar de onde se apaga dado.
--
-- A função devolve o motivo em jsonb em vez de `raise exception` porque as duas
-- recusas são estados NORMAIS do produto, não erros: a tela precisa explicá-las
-- em português, e exception vira string opaca do lado do cliente.

-- ---- o quadro do onboarding, atômico (migration 0156) ----

create or replace function public.fn_aplicar_quadro_do_onboarding(
  p_organization_id uuid,
  p_pipeline_id uuid,
  p_nome text,
  p_slug text,
  p_etapas jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
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
         updated_at = now()
   where id = p_pipeline_id
     and organization_id = p_organization_id;

  return jsonb_build_object('ok', true, 'etapas', v_criadas);
end$$;

-- TRÊS origens de EXECUTE, e medi as três antes de escrever esta lista — com o
-- revoke de `public, anon` apenas, `has_function_privilege` ainda respondia
-- `authenticated, service_role`:
--
--   (A) o grant que o Postgres dá a PUBLIC ao criar qualquer função;
--   (B) `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` (baseline);
--   (C) a irmã dela, `... TO authenticated` (baseline, linha seguinte).
--
-- Nenhum dos revokes remove os outros dois. E aqui (C) é a perigosa, não (B):
-- esta função é SECURITY DEFINER, roda como `postgres` por cima da RLS e recebe
-- `p_organization_id` como ARGUMENTO. Executável por `authenticated`, qualquer
-- usuário logado de qualquer tenant poderia reescrever o funil de OUTRA
-- organização passando o id dela — exatamente a classe de furo que a 0149
-- fechou. O invariante `hardening-definer-varredura` reprova definer volátil
-- alcançável por `authenticated` fora da allowlist, e esta não entra nela.
revoke execute on function public.fn_aplicar_quadro_do_onboarding(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
-- Só o service role: o único chamador é a Server Action do onboarding, que já
-- resolveu a organização do cookie de sessão. Quem não precisa não recebe.
grant execute on function public.fn_aplicar_quadro_do_onboarding(uuid, uuid, text, text, jsonb)
  to service_role;
