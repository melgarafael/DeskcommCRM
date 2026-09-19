-- =============================================================================
-- 0343 — A AGENDA DOS COLEGAS VIRA OPÇÃO DA ORGANIZAÇÃO (issue #978)
-- Renumerada de 0279 para 0343 em 19/09/2026: a `main` tomou o 0279 (o caso
-- só nasce do motor) enquanto esta branch esperava, e quem não é o primeiro
-- renumera.
--
-- O PEDIDO ORIGINAL: "minha agenda seja só minha". Até aqui, qualquer Atendente
-- cancela e remarca o compromisso de qualquer colega — nem a rota nem o banco
-- perguntavam de quem era o compromisso.
--
-- A DECISÃO DO MANTENEDOR (issue #978, 16/09) NÃO é uma guarda fixa: é uma
-- OPÇÃO POR ORGANIZAÇÃO, LIGADA POR PADRÃO, com rótulo em
-- Configurações › Tipos de agendamento.
--
--   LIGADA   — o padrão de quem já instalou, e o comportamento de sempre:
--              qualquer Atendente mexe na agenda de qualquer colega.
--   DESLIGADA— o Atendente só mexe no compromisso de que é DONO. Gerente e
--              Administrador seguem mexendo em tudo (a decisão diz os dois).
--
-- POR QUE A CHAVE NÃO MORA EM `settings.agenda`
--
--   `fn_agenda_settings` (definição em vigor no baseline) SUBSTITUI o objeto
--   `settings.agenda` inteiro e RECUSA qualquer chave que não sejam as duas que
--   ele conhece — `(p_config - 'atraso_de_confirmacao' - 'protecao_sem_resposta')
--   <> '{}'` termina em `raise exception 'agenda_config_invalida'`. Uma chave
--   nossa ali seria (a) recusada por ele e (b) APAGADA na primeira vez que um
--   Gerente salvasse os prazos da agenda. A migration 0262 enfrentou o mesmo
--   caso com `cliente_pela_agenda` e resolveu do mesmo jeito: chave própria.
--   Esta mora em `settings.colegas_podem_mexer_na_agenda` (topo, booleano),
--   que `updateTenant` preserva — ele grava `{...currentSettings, ...}` — e que
--   nenhuma outra tela reescreve.
--
-- AUSENTE = LIGADO, E ISSO É LITERAL
--
--   Quem instalou antes desta migration não tem a chave. A única forma de
--   desligar é o booleano `false` explícito:
--   `(settings->'colegas_podem_mexer_na_agenda') is distinct from 'false'::jsonb`.
--   Não há backfill, não há reescrita de linha nenhuma, não há DEFAULT novo:
--   quem já instalou não vê mudança nenhuma. A régua é a mesma em TypeScript
--   (`colegasPodemMexerNaAgendaLigado`, `lib/schemas/settings.ts`), para a tela
--   nunca mostrar uma regra que o banco não aplica.
--
-- A REGRA VALE NOS DOIS LUGARES, E PARA QUEM VALE — DECLARADO
--
--   * A ROTA é o aviso antes de tocar no banco:
--     `app/api/v1/agenda/agendamentos/_handler.ts` (`exigeDonoDoCompromisso`),
--     chamada por `cancelarAgendamentoHandler` e por `alterarAgendamentoHandler`,
--     e também na criação quando o responsável resolvido não é quem está
--     pedindo (`marcarAgendamentoHandler`).
--   * O BANCO é a autoridade: `fn_appointment_change_core` recusa com
--     `appointment_do_colega` (42501) a mudança de compromisso alheio.
--   * PESSOA (`auth.uid()` não nulo) com papel efetivo `agent`: recortada por
--     dono quando a opção está desligada.
--   * IA E INTEGRAÇÃO não são "um atendente" e não têm agenda própria — o que
--     as governa continua sendo o papel do token/serviço, que a rota já cobra
--     (`requireRole`), e as regras próprias de cada ferramenta. Esta opção NÃO
--     acrescenta recorte por dono para elas. Um token de integração que aja em
--     nome de uma pessoa (JWT de sessão) herda a regra da pessoa, que é o que
--     se espera.
--   * CANAL REMOTO (`p_remote`, worker do Google) chama com service role:
--     `auth.uid()` é nulo e a regra não se aplica — a reconciliação escreve o
--     que o Google mandou.
--   * COMPROMISSO SEM DONO (`owner_user_id is null`): com a opção desligada o
--     Atendente não mexe, porque não é a agenda dele; Gerente e Administrador
--     resolvem. É o lado conservador da mesma frase.
--
-- A OPÇÃO NÃO É UMA GUARDA FIXA: desligar hoje e religar amanhã volta tudo ao
-- que era, sem migration, sem dado reescrito.
-- =============================================================================

-- ---- 1. A LEITURA DA OPÇÃO --------------------------------------------------
--
-- Uma leitura só, usada pelo núcleo da mudança e pela rota (via RPC com a
-- sessão). Duas leituras inline divergiriam no primeiro ajuste: uma passaria a
-- tratar ausente como desligado e a outra não, e a tela diria uma regra
-- enquanto o banco aplicava outra.
--
-- `stable`: só lê. `security definer` porque a rota precisa responder pela
-- organização ativa mesmo quando o papel de quem está logado não enxerga a
-- linha de `organizations` por RLS — a autorização é do chamador, e quem a faz
-- é `requireRole` na rota / `fn_role_at_least` na porta de escrita.
create or replace function public.fn_colegas_podem_mexer_na_agenda(p_org uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select coalesce(
   (select (o.settings->'colegas_podem_mexer_na_agenda') is distinct from 'false'::jsonb
      from public.organizations o where o.id = p_org),
   true);
$$;

revoke all on function public.fn_colegas_podem_mexer_na_agenda(uuid) from public,anon;
grant execute on function public.fn_colegas_podem_mexer_na_agenda(uuid) to authenticated,service_role;

comment on function public.fn_colegas_podem_mexer_na_agenda(uuid) is
  'A opção "Atendentes podem mexer na agenda dos colegas" desta organização (issue #978). Ausente = ligada: só o booleano false explícito em settings.colegas_podem_mexer_na_agenda desliga.';

-- ---- 2. O NÚCLEO DA MUDANÇA, COM A REGRA NOVA -------------------------------
--
-- Definição EM VIGOR copiada do baseline — a que está RODANDO, com os portões
-- que ela carrega — e com UM bloco novo: a checagem de dono. Nada mais mudou:
-- nem ordem de trava, nem colunas do UPDATE, nem os desfechos, nem o portão de
-- MFA (`appointment_mfa_required`, que a 0229 acrescentou a esta função).
-- ⚠️ Recriar uma função a partir de uma cópia ANTIGA é exatamente como o portão
-- some em silêncio — `create or replace` troca a definição inteira e não avisa o
-- que sumiu. Quem vigia a classe inteira é
-- `tests/unit/mfa-nao-some-em-funcao-recriada.test.ts`, e é por isso que a linha
-- do MFA está aqui, na mesma posição da definição em vigor: quem reescrever este
-- corpo de novo encontra o portão no lugar onde ele estava.
create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid;
begin
 if p_remote and (auth.uid() is not null or (p_patch-'starts_at'-'ends_at'-'time_zone'-'status'-'cancellation_reason')<>'{}'::jsonb or coalesce(p_patch->>'status','cancelled')<>'cancelled') then raise exception 'google_patch_forbidden' using errcode='42501';end if;
 if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 if auth.uid() is not null and not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact or a.revision is distinct from p_revision then raise exception 'appointment_stale' using errcode='40001'; end if;
 -- A AGENDA DO COLEGA É UMA OPÇÃO DA ORGANIZAÇÃO (migration 0343, issue #978).
 -- LIGADA (o padrão de quem já instalou): este bloco não faz nada.
 -- DESLIGADA + sessão de gente + papel abaixo de manager: só o dono mexe.
 -- `auth.uid()` nulo é service role (workers, canal remoto do Google) e a regra
 -- não se aplica — está declarado no cabeçalho desta migration.
 if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager')
    and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    and a.owner_user_id is distinct from auth.uid() then
  raise exception 'appointment_do_colega' using errcode='42501';
 end if;
 if p_remote and a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='40001';end if;
 if a.status='cancelled' then raise exception 'appointment_cancelled' using errcode='22023'; end if;
 if contact is not null then origin:=jsonb_build_object('kind','command','observed',public.fn_service_observe_command(p_org,contact)); end if;
 update public.calendar_appointments set
  google_base_projection=case when p_remote then p_base else google_base_projection end,
  starts_at=case when p_patch?'starts_at' then (p_patch->>'starts_at')::timestamptz else starts_at end,
  ends_at=case when p_patch?'ends_at' then (p_patch->>'ends_at')::timestamptz else ends_at end,
  time_zone=coalesce(p_patch->>'time_zone',time_zone),
  status=coalesce(p_patch->>'status',status),
  cancelled_at=case when p_patch->>'status'='cancelled' then now() else cancelled_at end,
  cancellation_reason=case when p_patch?'cancellation_reason' then p_patch->>'cancellation_reason' else cancellation_reason end,
  notes=case when p_patch?'notes' then p_patch->>'notes' else notes end,
  guest_email=case when p_patch?'guest_email' then p_patch->>'guest_email' else guest_email end,
  outcome_message_id=case when p_patch?'outcome_message_id' then (p_patch->>'outcome_message_id')::uuid else null end,
  confirmation_next_at=case when p_patch?'confirmation_next_at' then (p_patch->>'confirmation_next_at')::timestamptz else confirmation_next_at end
 where organization_id=p_org and id=p_id returning * into a;
 if p_patch?'confirmation_next_at' and (a.confirmation_next_at<=now() or a.confirmation_next_at>now()+interval '24 hours') then raise exception 'appointment_invalid_snooze' using errcode='22023'; end if;
 update public.followup_enrollments set status='cancelled',cancel_reason='O compromisso mudou. Revise o próximo passo.',completed_at=now(),next_eval_at=null,claimed_until=null
  where organization_id=p_org and appointment_id=p_id and appointment_revision<>a.revision and status in ('active','waiting_reply','paused_handoff','paused_manual');
 update public.agent_inbox_items set status='resolved',resolved_at=now()
  where organization_id=p_org and ref_kind='appointment' and ref_id=p_id and status='open'
   and (appointment_revision<>a.revision or a.status in ('completed','no_show','cancelled') or p_patch?'confirmation_next_at');
 if contact is not null and a.status='no_show' and a.outcome_recorded_at is not null and a.revision<>p_revision then
  insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
   values(p_org,'appointment.outcome_confirmed','appointment',p_id,
    jsonb_build_object('appointment_revision',a.revision,'service_origin',origin)) returning id into event_id;
 end if;
 return to_jsonb(a);
end; $$;

-- Repetido do baseline de propósito: esta migration REFAZ a função, e o
-- `create or replace` não mexe em grant. Sem a linha, a varredura de anon do
-- baseline (`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon`)
-- passaria a valer para o corpo NOVO em quem instalou pelo baseline.
revoke all on function public.fn_appointment_change_core(uuid,uuid,bigint,jsonb,boolean,jsonb) from public,anon,authenticated;

-- ---- 3. A PORTA DE ESCRITA DA OPÇÃO -----------------------------------------
--
-- Espelha `fn_definir_cliente_pela_agenda` (migration 0262), com o papel que o
-- assunto pede: aqui é regra da AGENDA, mora na tela que o Gerente já governa
-- (`fn_agenda_settings`, os prazos ao lado), e não reescreve dado nenhum — os
-- dois motivos para o piso ser `manager` e não `admin`, ao contrário daquela.
--
-- Pelo client DA SESSÃO no Server Action: é `auth.uid()` que faz a função
-- reconferir papel, suporte e MFA. Nunca `.from("organizations").update(...)`
-- na action — pela sessão de um Gerente de tenant casa ZERO linhas e devolve
-- sucesso.
create or replace function public.fn_definir_colegas_podem_mexer_na_agenda(p_org uuid,p_ligado boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_atual boolean; v_linhas int;
begin
 if p_ligado is null then raise exception 'agenda_dos_colegas_invalido' using errcode='22023'; end if;
 if auth.uid() is null
    or not public.fn_role_at_least(p_org,'manager')
    or not public.fn_support_write_allowed(p_org) then
  raise exception 'agenda_dos_colegas_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'mfa_required' using errcode='42501'; end if;
 v_atual := public.fn_colegas_podem_mexer_na_agenda(p_org);
 if v_atual is not distinct from p_ligado then
  return jsonb_build_object('ligado',v_atual,'mudou',false);
 end if;
 -- Chave PRÓPRIA de topo (ver cabeçalho): `||` no objeto, nunca `settings.agenda`.
 update public.organizations
    set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('colegas_podem_mexer_na_agenda',to_jsonb(p_ligado))
  where id = p_org;
 get diagnostics v_linhas = row_count;
 if v_linhas = 0 then raise exception 'agenda_dos_colegas_sem_organizacao' using errcode='P0002'; end if;
 return jsonb_build_object('ligado',p_ligado,'mudou',true);
end; $$;

revoke all on function public.fn_definir_colegas_podem_mexer_na_agenda(uuid,boolean) from public,anon;
grant execute on function public.fn_definir_colegas_podem_mexer_na_agenda(uuid,boolean) to authenticated,service_role;

comment on function public.fn_definir_colegas_podem_mexer_na_agenda(uuid,boolean) is
  'Liga/desliga "Atendentes podem mexer na agenda dos colegas" (issue #978). Gerente ou acima, suporte de escrita e MFA comprovado; ela mesma confere pelo auth.uid(). Grava settings.colegas_podem_mexer_na_agenda e devolve {ligado,mudou}.';

notify pgrst, 'reload schema';
