-- manifest: **Compromisso sem Google Meet passa a chegar ao cliente: o porteiro do envio comparava `meeting_request_id` nulo com `=` (issue #2188).** `fn_meet_delivery_current` é a última guarda antes de a mensagem sair, e a 0366 afrouxou o LOCAL (compromisso presencial não precisa de link) sem tocar nesta linha: `and a.meeting_request_id::text = j.payload->>'meeting_request_id'`. Num presencial o campo é NULO nos dois lados, e `NULL = NULL` não é verdadeiro — então o porteiro devolvia `false`, o job terminava `failed` com `access_or_stale` e o cliente nunca recebia. Medido pelo relator em v1.69.0 (compromisso presencial, conversa aberta, admin dono): repique do clique dá sempre o mesmo. Conserto: `is not distinct from`, que é o que o resto do arquivo já usa em TODO lugar onde compara esta coluna (`baseline.sql:21637, 21723, 21944, 34861, 34916, 34996`) — esta linha era a única com `=`. Corpo idêntico ao da 0366, com um operador trocado; `create or replace`, apêndice do baseline editado NO LUGAR na última definição. Gate: `tests/invariants/porteiro-do-envio-sem-meet.test.ts`, cuja precondição passou a ser a de produção (sem Meet o campo é NULO, não um uuid de enfeite).

-- 0528: o porteiro do envio de compromisso sem Meet deixa de comparar NULL com `=`
-- (issue #2188, medido pelo relator em produção).
--
-- A 0366 abriu a entrega para compromisso que não é Google Meet, e mexeu em três
-- pontas: o gatilho que enfileira, a ação que autoriza e este porteiro. O porteiro
-- ficou com uma linha que só é verdadeira quando os DOIS lados têm valor:
--
--   and a.meeting_request_id::text = j.payload->>'meeting_request_id'
--
-- Num compromisso presencial o campo nunca foi preenchido — quem o preenche é o
-- pedido de Meet (`fn_meet_action`, `fn_meet_enqueue`) — então ele é NULO na
-- agenda E no payload do job (o payload o carrega em `jsonb_build_object`, e
-- `jsonb_build_object('k', null)` grava `{"k": null}`, que lido com `->>` é NULO).
-- `NULL = NULL` é NULO, não verdadeiro: a condição derruba o `exists`, o porteiro
-- responde `false`, `fn_meet_delivery_policy` cai no `else 'access_or_stale'` e o
-- job morre sem que nada saia. Determinístico, e em TODO envio de presencial.
--
-- `is not distinct from` é a comparação certa, e é a que o resto do arquivo já usa
-- em todas as outras leituras desta coluna (a 0226, a 0366, a 0496): esta linha era
-- a única com `=`. Ela NÃO afrouxa a checagem — com id de um lado e nulo do outro,
-- ou com ids diferentes, continua falso; o que ela passa a aceitar é o par
-- (nulo, nulo), que é o estado legítimo de quem não tem Meet.
create or replace function public.fn_meet_delivery_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j join public.calendar_appointments a on a.organization_id=j.organization_id and a.id::text=j.payload->>'appointment_id'
  join public.contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
  join public.conversations v on v.organization_id=a.organization_id and v.contact_id=a.contact_id and v.id::text=j.payload->'service_boundary'->>'conversation_id'
  join public.channel_sessions cs on cs.organization_id=v.organization_id and cs.id=v.channel_session_id
  join public.organizations o on o.id=a.organization_id and o.status='active'
  where cs.archived_at is null and a.meeting_delivery->>'channel_session_id'=cs.id::text and j.organization_id=p_org and j.id=p_job and j.kind='transactional_delivery' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
   and a.contact_id=j.contact_id and not c.is_anonymized and not c.is_blocked and a.status<>'cancelled' and (a.location_kind<>'google_meet' or (a.meeting_state='ready' and a.meeting_url is not null))
   and a.meeting_request_id::text is not distinct from j.payload->>'meeting_request_id' and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation'
   and a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'state'='queued'
   and exists(select 1 from public.user_organizations where organization_id=p_org and user_id=a.owner_user_id and revoked_at is null)
   and (a.meeting_delivery->'authorized_by'->>'kind'='ai_agent' or
    (a.meeting_delivery->'authorized_by'->>'kind'='user' and a.meeting_delivery->'authorized_by'->>'id'=a.owner_user_id::text and exists(
     select 1 from public.user_organizations u where u.organization_id=p_org and u.user_id=a.owner_user_id and u.revoked_at is null and u.role in ('agent','manager','admin')
      and (u.role in ('manager','admin') or v.assigned_to_user_id=u.user_id or o.settings->>'visibility_mode'='all'
       or (coalesce(o.settings->>'visibility_mode','own_and_unassigned')='own_and_unassigned' and v.assigned_to_user_id is null)))))
   and a.meeting_delivery->'service_boundary'=j.payload->'service_boundary' and public.fn_meet_boundary_current(j.payload->'service_boundary'));
$$;
revoke all on function public.fn_meet_delivery_current(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_current(uuid,uuid,text,timestamptz) to service_role;
