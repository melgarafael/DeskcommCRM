-- manifest: O passo "funil" do onboarding PULADO liga as etapas que o gatilho semeou (issue #2451): `trg_ligar_funil_pulado` escreve `agent_stage_hint` nas três etapas do funil "Pedidos" que têm passo equivalente no momento em que `organizations.onboarding_state->'funil'` marca `skipped`, porque `pularQuadro` só gravava o registro e a organização terminava a instalação com `coberturaDoFunil()` em `mudo: true` — o agente sem mover um card só.
-- 0621 — o passo "funil" pulado liga as etapas que o gatilho semeou.
--
-- ═══ O PROBLEMA ═══
--
-- `trg_seed_default_pipeline_for_org` semeia o funil "Pedidos" com 8 etapas de
-- e-commerce em TODA organização criada, e nenhuma delas nasce com
-- `agent_stage_hint`. O passo "funil" do wizard troca esse quadro por um do ramo
-- do negócio — a 0156 —, mas o mesmo passo tem "Pular por enquanto", e o
-- `pularQuadro` (`app/actions/onboarding/montarQuadro.ts`) só grava
-- `funil.skipped` no estado do onboarding: a decisão fica registrada e o funil
-- fica mudo. Quem pula termina a instalação com `coberturaDoFunil()` em
-- `mudo: true`, e o alarme só existe na página do agente — que quem pulou o
-- passo não abre. A medição que a própria 0156 citou é o retrato: 312 etapas, 4
-- com destino, e as 4 de organizações de teste.
--
-- ═══ POR QUE O PULO, E NÃO O NASCIMENTO ═══
--
-- Semear já ligado (a opção 2 da issue) resolveria o caso trocando o contrato
-- da 0156: `tests/invariants/quadro-do-onboarding.test.ts` mede que o funil
-- nasce em `8|0` e é o PASSO que ensina — a própria pré-condição daquela
-- entrega. Ligado no nascimento, quem completa o wizard e quem pula começam
-- iguais e o passo deixa de ser o que muda o estado do mundo. Aqui o gatilho
-- reage ao momento em que a decisão EXISTE: a escrita do pulo. Mesma transação
-- que grava `funil.skipped`, no banco onde o funil foi semeado — ou o pulo
-- registra E liga, ou nada muda; o cliente JS não tem transação, e um pular que
-- falhasse pela metade deixaria a organização com estado sem efeito.
--
-- ═══ O MAPEAMENTO — E O QUE É DECISÃO DESTA MIGRATION ═══
--
-- Três das oito etapas têm passo equivalente e são exatamente as que a issue
-- apontou:
--
--   Aguardando pagamento -> negotiating   Pago -> won (is_won)
--   Cancelado            -> lost         (is_lost)
--
-- A 0084 só derivou won/lost de is_won/is_lost; negotiating em 'Aguardando
-- pagamento' é decisão desta migration, possível porque a etapa foi semeada
-- pelo próprio sistema, não nomeada pelo tenant.
--
-- As outras cinco — Carrinho abandonado, Em separação, Enviado, Entregue,
-- Pós-venda — não têm equivalente no funil do agente. A 0084 diz, com as
-- palavras dela e citando três delas, que `null` é estado legítimo e que
-- forçar um mapeamento seria inventar semântica que o tenant não declarou. Com `negotiating` apontado,
-- `coberturaDoFunil()` sai de `mudo: true` — é o alarme que tinha de sumir.
--
-- As três guardas no UPDATE não são defeito, são o schema falando: o CHECK
-- `crm_stages_hint_coerente_com_won_lost` recusaria `won` fora de um estágio de
-- ganho, `uniq_crm_stages_pipeline_hint` recusaria dois estágios com o mesmo
-- passo no mesmo funil, e um funil que alguém já mapeou à mão não pode ser
-- reescrito por um pular. Cada guarda joga a linha FORA do update em vez de
-- levantar erro — pular o passo é decisão legítima e nunca pode morrer numa
-- colisão de índice.
--
-- ═══ IDEMPOTÊNCIA E O QUE ESTA MIGRATION NÃO FAZ ═══
--
-- `create or replace function` + `drop trigger if exists` + `create trigger`:
-- as duas passadas do `scripts/test-db.sh` (install e update, ambas com
-- `ON_ERROR_STOP=1`) aplicam o arquivo duas vezes sem erro, e o gatilho só
-- dispara na transição `skipped` false->true — regravar o mesmo estado não
-- reescreve nada. A função é `security definer` com `search_path` fixo (mesmo
-- desenho da 0156) e o EXECUTE sai de public/anon/authenticated: o gatilho
-- dispara sem passar por EXECUTE, então ninguém chama ela de fora.
--
-- Esta migration NÃO escreve em dado existente: as organizações que já pularam
-- continuam como estão até alguém passar de novo por lá — um backfill decidiria
-- o funil de tenant cujo histórico o migration não conhece, e é dado vivo de
-- produção. O efeito daqui é no próximo pulo.
create or replace function public.fn_ligar_funil_pulado() returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_pipeline_id uuid;
begin
  -- Só o funil PADRÃO: é o que o gatilho de criação semeou e é onde o passo
  -- pulado deixa a pessoa. Um funil que ela montou depois é mapeamento dela.
  select id
    into v_pipeline_id
    from public.crm_pipelines
   where organization_id = new.id
     and is_default
     and coalesce(is_archived, false) = false
   order by position
   limit 1;

  if v_pipeline_id is null then
    return new;
  end if;

  update public.crm_stages s
     set agent_stage_hint = v.hint
    from (values
           ('aguardando_pagamento', 'negotiating'),
           ('pago',                 'won'),
           ('cancelado',            'lost')
         ) as v(slug, hint)
   where s.pipeline_id = v_pipeline_id
     and s.slug = v.slug
     and s.agent_stage_hint is null
     -- CHECK crm_stages_hint_coerente_com_won_lost: um "pago" que já não é de
     -- ganho não recebe o hint de ganho.
     and (v.hint <> 'won' or s.is_won)
     and (v.hint <> 'lost' or s.is_lost)
     -- uniq_crm_stages_pipeline_hint: quem mapeou primeiro ficou com o passo,
     -- e o pular não pode levantar erro por causa disso.
     and not exists (
           select 1
             from public.crm_stages ocupada
            where ocupada.pipeline_id = s.pipeline_id
              and ocupada.agent_stage_hint = v.hint
              and coalesce(ocupada.is_archived, false) = false
         );

  return new;
end$$;

drop trigger if exists trg_ligar_funil_pulado on public.organizations;
create trigger trg_ligar_funil_pulado
  after update of onboarding_state on public.organizations
  for each row
  when (
    new.onboarding_state -> 'funil' ->> 'skipped' = 'true'
    and coalesce(old.onboarding_state -> 'funil' ->> 'skipped', 'false') <> 'true'
  )
  execute function public.fn_ligar_funil_pulado();

-- TRÊS origens de EXECUTE, como a 0156 mediu: o grant do PUBLIC, o
-- `ALTER DEFAULT PRIVILEGES ... TO anon` e a irmã `... TO authenticated`, todos
-- do corpo do baseline. Aqui o revoke não é uma economia de superfície — a
-- função é SECURITY DEFINER e escreve em `crm_stages`, e nenhum papel a chama:
-- o gatilho dispara sem checar EXECUTE. `hardening-definer-varredura` cobra que
-- uma definer volátil de `public` não seja alcançável por `authenticated`.
revoke execute on function public.fn_ligar_funil_pulado() from public, anon, authenticated;
grant execute on function public.fn_ligar_funil_pulado() to service_role;
