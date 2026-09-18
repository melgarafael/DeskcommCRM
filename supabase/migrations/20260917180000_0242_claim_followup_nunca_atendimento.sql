-- 0242 · O motor de FOLLOW-UP nunca pega o enrollment de ATENDIMENTO.
--
-- ─── O defeito (medido ao vivo, 2026-09-18) ─────────────────────────────────
-- `followup_enrollments` é compartilhada pelos dois fluxos: o de follow-up
-- (surface='followup'/'crm_automation', conduzido pelo RELÓGIO) e o de
-- atendimento (surface='atendimento', conduzido pelo TURNO). O claim do relógio
-- e o `aplicar-inbound` NÃO filtravam `surface`, então pegavam também o
-- enrollment de atendimento. Ao processá-lo pelo motor de follow-up, o
-- `service_boundary` estava vencido (aquele enrollment é de OUTRO fluxo) e o
-- enrollment era CANCELADO — "Atendimento encerrado ou substituído".
--
-- Efeito ao vivo: o fluxo de atendimento iniciava (evento `iniciado`, primeira
-- resposta capturada) e morria no turno seguinte, sem fazer as perguntas.
--
-- ─── O que esta migration faz ───────────────────────────────────────────────
-- O claim passa a exigir que o POINTER do enrollment seja de superfície de
-- follow-up. `surface='atendimento'` fica de fora por construção.
--
-- (O filtro equivalente no lado do cliente, `lib/followup/aplicar-inbound.ts`,
-- entra no mesmo commit — o claim SQL e a consulta do inbound são duas portas.)
--
-- `create or replace` de função EXISTENTE; sem função nova em `public` e sem
-- GRANT novo ⇒ itens 8/9 da doutrina de migrations não são acionados. O
-- `revoke`/`grant` originais permanecem (a assinatura não muda).

create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  with orgs as (
    select distinct e.organization_id
      from followup_enrollments e
      join followup_flow_pointers p on p.id = e.pointer_id
     where e.status in ('active','waiting_reply')
       and e.next_eval_at <= now()
       and p.surface <> 'atendimento'
  ),
  fila as (
    select f.id, f.next_eval_at, f.posicao_na_org
      from orgs
      cross join lateral (
        select d.id,
               d.next_eval_at,
               row_number() over (order by d.next_eval_at) as posicao_na_org
          from followup_enrollments d
          join followup_flow_pointers p on p.id = d.pointer_id
         where d.organization_id = orgs.organization_id
           and d.status in ('active','waiting_reply')
           and d.next_eval_at <= now()
           and (d.claimed_until is null or d.claimed_until < now())
           and p.surface <> 'atendimento'
         order by d.next_eval_at
         limit p_limit
      ) f
  ),
  escolhidos as (
    select id from fila order by posicao_na_org, next_eval_at limit p_limit
  ),
  travados as (
    select e.id from followup_enrollments e
     where e.id in (select id from escolhidos)
     for update skip locked
  )
  update followup_enrollments e
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where e.id in (select id from travados)
     and (e.claimed_until is null or e.claimed_until < now())
  returning e.*;
$$;

revoke execute on function fn_claim_due_followup_enrollments(int, int) from public, anon, authenticated;
grant execute on function fn_claim_due_followup_enrollments(int, int) to service_role;

notify pgrst, 'reload schema';
