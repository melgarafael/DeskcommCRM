-- 0469 — Onda C4 da spec de Propostas (2026-09-23): D4 (revisar cria v2 em
-- rascunho pela tela — a v1 e a v2 convivem, a v1 ainda `enviada`, até a v2
-- ser enviada). A unicidade de numeração vigente é (organization_id, ano,
-- numero) — cedo demais para D4: as duas linhas da mesma cadeia teriam o
-- MESMO numero/ano com status <> 'substituida' ao mesmo tempo.

-- Medir ANTES de trocar o índice (doutrina de migrations item 8): não deve
-- haver hoje nenhum grupo violando a chave nova, porque a v2 só nascia
-- (até esta migration) dentro do envio, no mesmo instante em que a v1 virava
-- substituida. Se houver, a migration PARA — investigar manualmente é mais
-- seguro que criar um índice que a própria migration furaria.
do $$
declare
  v_conflitos int;
begin
  select count(*) into v_conflitos
  from (
    select organization_id, ano, numero, versao
    from public.crm_proposals
    where numero is not null and status <> 'substituida'
    group by organization_id, ano, numero, versao
    having count(*) > 1
  ) c;
  if v_conflitos > 0 then
    raise exception 'migration_0413: % grupo(s) já violam (organization_id, ano, numero, versao) — investigar antes de trocar o índice', v_conflitos;
  end if;
end $$;

drop index if exists public.crm_proposals_numero_ano_org_uidx;
create unique index if not exists crm_proposals_numero_ano_versao_org_uidx
  on public.crm_proposals (organization_id, ano, numero, versao)
  where numero is not null and status <> 'substituida';

notify pgrst, 'reload schema';
