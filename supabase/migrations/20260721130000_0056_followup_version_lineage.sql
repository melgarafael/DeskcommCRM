-- 0056 — linhagem version→pointer + publish atômico (fix pós-review Task 3.1)
--
-- Review da Task 3.1 pegou 2 pontos: (1) followup_flow_versions não tinha
-- pointer_id, então rollback não conseguia validar "essa version já foi
-- deste pointer" — só "é da mesma org" (permissivo demais); (2) publish
-- fazia insert(version) + update(pointer) como 2 chamadas separadas da rota
-- (não atômico — falha entre as duas deixa a version órfã sem o pointer
-- apontar pra ela). Fix: coluna pointer_id + RPC única security definer,
-- espelhando fn_publish_ai_agent_version (0024/0026).

alter table followup_flow_versions
  add column if not exists pointer_id uuid references followup_flow_pointers(id) on delete cascade;

-- Backfill genérico (qualquer clone): a version que está ATIVA num pointer
-- claramente pertence a ele. Versions nunca promovidas a active (superseded
-- antes de qualquer publish, ou nunca usadas) ficam pointer_id null —
-- aceitável, nunca são alvo de rollback (ver check na RPC/rota).
update followup_flow_versions v
set pointer_id = p.id
from followup_flow_pointers p
where p.active_version_id = v.id
  and v.pointer_id is null;

create index if not exists idx_followup_versions_pointer
  on followup_flow_versions (pointer_id);

-- Publish atômico: insere a version (já com pointer_id) + ativa o pointer
-- numa única transação de função. Falha (pointer inexistente/org errada)
-- não deixa nenhum dos dois lados pela metade.
create or replace function fn_publish_followup_flow_version(
  p_org uuid,
  p_pointer uuid,
  p_graph jsonb,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pointer record;
  v_version_id uuid;
begin
  select p.id, p.organization_id
    into v_pointer
  from followup_flow_pointers p
  where p.id = p_pointer
  for update;

  if not found or v_pointer.organization_id <> p_org then
    raise exception 'pointer_not_found' using errcode = 'P0001';
  end if;

  insert into followup_flow_versions (organization_id, pointer_id, graph, created_by)
  values (p_org, p_pointer, p_graph, p_created_by)
  returning id into v_version_id;

  update followup_flow_pointers
     set active_version_id = v_version_id,
         status = 'active',
         updated_at = now()
   where id = p_pointer;

  return v_version_id;
end;
$$;

-- Mesma postura de fn_claim_due_followup_enrollments (0054): sem grant
-- default de ALTER DEFAULT PRIVILEGES a anon/authenticated pra uma função
-- security definer que escreve — só service_role (a rota chama via admin
-- client, como lib/ai/agents/publish.ts faz com fn_publish_ai_agent_version).
revoke all on function fn_publish_followup_flow_version(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
