-- 0388 — o funil padrão passa a nascer em espanhol (idioma do dono).
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
-- O funil padrão de e-commerce ("Pedidos"), semeado pelo trigger
-- `fn_seed_default_pipeline_for_org()` em toda organização nova, vinha com os
-- nomes das etapas em português: "Carrinho abandonado", "Aguardando
-- pagamento", "Pago", "Em separação", "Entregue", "Pós-venda". O dono não lê
-- português — cada instalação nova abria o quadro num idioma que ele não
-- entende.
--
-- ─── O conserto ────────────────────────────────────────────────────────────
-- 1. A função de seed passa a gravar os nomes em espanhol simples, sem
--    jargão (palavras de dono, não de manual):
--      Carrito abandonado · Esperando pago · Pagado · En preparación ·
--      Enviado · Entregado · Posventa · Cancelado
--    Os slugs ficam como estão (`carrinho_abandonado`, etc.): são
--    identificadores internos, não texto de tela, e renomeá-los quebraria
--    código que os referencia.
-- 2. As etapas já semeadas em português são renomeadas no lugar, com escopo
--    cirúrgico — pipeline padrão + slug imutável + nome ainda em português:
--    onde o dono já renomeou pela tela, é no-op seguro; etapa criada pelo dono
--    com o mesmo nome noutro funil não é tocada.
-- 3. O vocabulário padrão do pipeline (`crm_pipelines.vocabulary`) dizia
--    `'won', 'Pago'`; passa a `'won', 'Pagado'`, no default da coluna e nas
--    linhas que ainda têm o valor original.
--
-- ─── Idempotência ───────────────────────────────────────────────────────────
-- `create or replace` na função; os `update` casam pelo nome exato, então
-- reaplicar numa base já corrigida não mexe em nada.

-- 1. Seed daqui em diante: espanhol.
create or replace function public.fn_seed_default_pipeline_for_org()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_pipeline_id uuid;
  v_position numeric := 1000;
  r record;
begin
  insert into public.crm_pipelines (organization_id, name, slug, is_default, position)
  values (new.id, 'Pedidos', 'pedidos', true, 1000)
  returning id into v_pipeline_id;

  for r in
    select * from (values
      ('Carrito abandonado', 'carrinho_abandonado',  false, false),
      ('Esperando pago',     'aguardando_pagamento', false, false),
      ('Pagado',             'pago',                 true,  false),
      ('En preparación',     'em_separacao',         false, false),
      ('Enviado',            'enviado',              false, false),
      ('Entregado',          'entregue',             false, false),
      ('Posventa',           'pos_venda',            false, false),
      ('Cancelado',          'cancelado',            false, true)
    ) as t(stage_name, stage_slug, won, lost)
  loop
    insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
    values (new.id, v_pipeline_id, r.stage_name, r.stage_slug, v_position, r.won, r.lost);
    v_position := v_position + 1000;
  end loop;

  return new;
end$$;

-- 2. Renomeia o que já foi semeado em português (no-op onde a tela já corrigiu).
--
-- Escopo cirúrgico, de propósito: SÓ a etapa semeada pelo trigger, ainda com o
-- nome em português. O `slug` é chave técnica imutável — não muda ao renomear
-- (`lib/leads/stage-editing.ts`: "o slug nasce com a etapa e morre com ela") —
-- então `pipeline padrão + slug + nome` identifica exatamente "a etapa do seed
-- que o dono não tocou". Um `WHERE name = 'Pago'` global renomearia também uma
-- etapa CRIADA PELO DONO com o mesmo nome noutro funil; dado do usuário não se
-- toca por coincidência de texto. `uniq_crm_pipelines_org_default` garante um
-- só pipeline padrão por organização.
update public.crm_stages s
set name = 'Carrito abandonado'
from public.crm_pipelines p
where s.pipeline_id = p.id and p.is_default
  and s.slug = 'carrinho_abandonado' and s.name = 'Carrinho abandonado';
update public.crm_stages s
set name = 'Esperando pago'
from public.crm_pipelines p
where s.pipeline_id = p.id and p.is_default
  and s.slug = 'aguardando_pagamento' and s.name = 'Aguardando pagamento';
update public.crm_stages s
set name = 'Pagado'
from public.crm_pipelines p
where s.pipeline_id = p.id and p.is_default
  and s.slug = 'pago' and s.name = 'Pago';
update public.crm_stages s
set name = 'En preparación'
from public.crm_pipelines p
where s.pipeline_id = p.id and p.is_default
  and s.slug = 'em_separacao' and s.name = 'Em separação';
update public.crm_stages s
set name = 'Entregado'
from public.crm_pipelines p
where s.pipeline_id = p.id and p.is_default
  and s.slug = 'entregue' and s.name = 'Entregue';
update public.crm_stages s
set name = 'Posventa'
from public.crm_pipelines p
where s.pipeline_id = p.id and p.is_default
  and s.slug = 'pos_venda' and s.name = 'Pós-venda';

-- 3. Vocabulário: 'won' segue o nome da etapa de ganho.
alter table public.crm_pipelines
  alter column vocabulary set default
  jsonb_build_object('lead', 'Cliente', 'lead_plural', 'Clientes', 'deal', 'Pedido',
                     'deal_plural', 'Pedidos', 'won', 'Pagado', 'lost', 'Cancelado',
                     'stage', 'Etapa', 'stage_plural', 'Etapas');

update public.crm_pipelines
  set vocabulary = jsonb_set(vocabulary, '{won}', '"Pagado"')
  where is_default and vocabulary->>'won' = 'Pago';
