-- 0494 — a CASCATA DO BANCO alcança lead_notes, tool_calls, lead_state e social_identity (issue #1964)
--
-- Follow-up do #1958 (@webtecnica). O #1958 levou essas quatro fontes para a
-- cascata DA APLICAÇÃO (`lib/lgpd/cascata.ts`): a RPC `fn_lgpd_cascade_redact_contact`
-- e os gatilhos instalados em `contacts` não tocam `lead_notes`,
-- `ai_agent_runs.tool_calls`, `lead_state` nem `contacts.social_identity`.
-- Então o pedido formal só fica completo se a camada de app rodar. Se a virada
-- de `is_anonymized` acontecer por OUTRO caminho — um `update` direto, ou um
-- erro entre as duas etapas —, as quatro fontes ficam com o texto da pessoa:
--
--   lead_notes.headline / body                          memória da IA sobre o contato
--   ai_agent_runs.tool_calls                            argumentos das ferramentas
--   lead_state.next_action / qualification              texto livre sobre o negócio
--   contacts.social_identity                            perfil social (jsonb)
--
-- ── O desenho ────────────────────────────────────────────────────────────────
-- O conserto vive na MESMA porta do desenho da 0391: o gatilho da virada de
-- `is_anonymized` (`trg_redigir_conversas_ao_anonimizar` →
-- `fn_redigir_conversas_ao_anonimizar`), que é o caminho que os DOIS fluxos de
-- anonimização (o pedido formal e o botão da ficha) cruzam por construção —
-- a cascata canônica é alcançada na mesma transação da virada. Estender a
-- função do gatilho em vez de a RPC nomeada deixa a cobertura atrás de QUANDO
-- o `is_anonymized` muda, não de QUEM mudou: qualquer caminho que chegue lá —
-- inclusive um `update` direto no banco — passa por estas linhas.
--
-- ── Idempotência ────────────────────────────────────────────────────────────
-- O gatilho dispara UMA vez por contato (guard `when (new.is_anonymized and
-- not old.is_anonymized)`), e cada passo de escrita guarda o marcador que a
-- app já usa (o mesmo da #1958), para a varredura diária não reescrever dado
-- já redigido:
--   lead_notes    → NOTA_REDIGIDA `(anonimizado)` em headline/body
--   tool_calls    → `redacted = true` em TODO passo (o `[]` de nascença não
--                   tem passo, logo nunca é tocado — mesma régua de
--                   `toolCallsPendentes` da cascata de app)
--   lead_state    → marca de "vazio" (`next_action is null`) no guard de WHERE
--   social_identity → o próprio `is not null` no guard
-- Os WHERE também filtram organização E contato — a mesma disciplina que a
-- cascata de app usa (`organizationId` filtrado à mão em toda query; a RLS não
-- segura o service role).
--
-- ── Reaplicável ──────────────────────────────────────────────────────────────
-- `create or replace function` (mantém ACL), `drop trigger if exists` +
-- `create trigger` idem. O apêndice do `baseline.sql` entra ANTES do bloco da
-- VARREDURA anon (0116), que proíbe `create function` depois dela.

create or replace function public.fn_redigir_conversas_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_variantes text[];
  v_lid text;
  v_msgs_de_grupo uuid[];
begin
  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select distinct new.organization_id, 'whatsapp-media', m.media_storage_path
    from public.messages m
   where m.organization_id = new.organization_id
     and m.conversation_id in (
       select c.id from public.conversations c
        where c.contact_id = new.id and c.organization_id = new.organization_id)
     and m.media_storage_path is not null
     and length(m.media_storage_path) > 0
  on conflict (bucket, object_path) do nothing;

  update public.messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and conversation_id in (
      select c.id from public.conversations c
       where c.contact_id = new.id and c.organization_id = new.organization_id);

  update public.conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = new.id and organization_id = new.organization_id;

  update public.lead_checkpoints set
    rolling_summary = '[resumo anonimizado]',
    commitments = '[]'::jsonb,
    objections = '[]'::jsonb,
    next_action = null,
    declaracao = null
  where contact_id = new.id and organization_id = new.organization_id;

  -- ── issue #1964 — lead_notes: a memória do agente sobre o contato ─────────
  update public.lead_notes set
    headline = '(anonimizado)',
    body = '(anonimizado)',
    embedding = null,
    updated_at = now()
  where organization_id = new.organization_id
    and contact_id = new.id
    and (headline is distinct from '(anonimizado)'
         or body is distinct from '(anonimizado)'
         or embedding is not null);

  -- ── issue #1964 — ai_agent_runs.tool_calls: preserva o nome e redige o resto
  -- A transformação espelha `redigirToolCalls` (lib/lgpd/cascata.ts): cada
  -- passo vira `{ step?, tool_name?, redacted: true, tool_calls: [{ tool_name }] }`.
  -- Fica QUAIS ferramentas rodaram e em que passo; sai o texto do modelo, os
  -- argumentos e os resultados. Guard no WHERE: só corre quando há passo sem
  -- `redacted`, então o `[]` de nascença e a run já redigida não são tocados.
  update public.ai_agent_runs set
    tool_calls = public.fn_lgpd_redigir_tool_calls(ai_agent_runs.tool_calls)
  where ai_agent_runs.organization_id = new.organization_id
    and ai_agent_runs.contact_id = new.id
    and exists (
      select 1 from jsonb_array_elements(ai_agent_runs.tool_calls) s
       where coalesce(s->>'redacted', 'false')::boolean is not true
    );

  -- ── issue #1964 — lead_state: a próxima ação e a qualificação da lead ─────
  update public.lead_state set
    next_action = null,
    qualification = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and contact_id = new.id
    and (next_action is not null
         or coalesce(qualification, '{}'::jsonb) <> '{}'::jsonb);

  -- ── issue #1964 — contacts.social_identity ───────────────────────────────
  -- O índice único parcial `where social_identity is not null` torna anular
  -- seguro (a linha sai do índice sem violar unicidade). Guard no WHERE para a
  -- varredura não reescrever o que já está anonimizado.
  update public.contacts set
    social_identity = null,
    updated_at = now()
  where id = new.id
    and organization_id = new.organization_id
    and social_identity is not null;

  -- Mensagens de grupo escritas pelo titular (0482, ver o cabeçalho daquele bloco).
  v_variantes := coalesce(public.fn_telefone_variantes(coalesce(old.phone_number, new.phone_number)), '{}');
  v_lid := coalesce(old.wa_lid, new.wa_lid);

  select coalesce(array_agg(m.id), '{}')
    into v_msgs_de_grupo
    from public.messages m
   where m.organization_id = new.organization_id
     and m.metadata ? 'group_sender'
     and (
       regexp_replace(coalesce(m.metadata->'group_sender'->>'phone', ''), '\D', '', 'g') = any(v_variantes)
       or (v_lid is not null and m.metadata->'group_sender'->>'lid' = v_lid)
     );

  if cardinality(v_msgs_de_grupo) > 0 then
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct new.organization_id, 'whatsapp-media', m.media_storage_path
      from public.messages m
     where m.organization_id = new.organization_id
       and m.id = any(v_msgs_de_grupo)
       and m.media_storage_path is not null
       and length(m.media_storage_path) > 0
    on conflict (bucket, object_path) do nothing;

    update public.conversations set
      last_message_preview = null,
      updated_at = now()
    where organization_id = new.organization_id
      and id in (select m.conversation_id from public.messages m
                  where m.organization_id = new.organization_id and m.id = any(v_msgs_de_grupo));

    update public.messages set
      body = '[mensagem anonimizada]',
      media_url = null,
      media_mime = null,
      media_size_bytes = null,
      media_storage_path = null,
      metadata = '{}'::jsonb,
      updated_at = now()
    where organization_id = new.organization_id
      and id = any(v_msgs_de_grupo);
  end if;

  return new;
end
$f$;

-- As DUAS origens de EXECUTE (item 9 do CLAUDE.md): o grant a PUBLIC da criação
-- e o grant nominal a anon do ALTER DEFAULT PRIVILEGES do baseline.
revoke all on function public.fn_redigir_conversas_ao_anonimizar() from public;
revoke execute on function public.fn_redigir_conversas_ao_anonimizar() from anon;
revoke execute on function public.fn_redigir_conversas_ao_anonimizar() from authenticated;

drop trigger if exists trg_redigir_conversas_ao_anonimizar on public.contacts;
create trigger trg_redigir_conversas_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_redigir_conversas_ao_anonimizar();

-- +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
-- + Variável de estado auxiliar redigindo tool_calls (issue #1964)            +
-- +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
-- Transforma `tool_calls` (jsonb) espelhando `redigirToolCalls` da cascata de
-- app. `immutable` e `security definer`-livre (é só uma transformação pura);
-- revogado de anon/authenticated porque o único chamador é o gatilho acima
-- (`security definer` de dono postgres já tem privilégio de chamá-la).
create or replace function public.fn_lgpd_redigir_tool_calls(p_tool_calls jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $t$
  select coalesce(jsonb_agg(t.step_json order by t.ord), '[]'::jsonb)
    from (
      select jsonb_strip_nulls(jsonb_build_object(
               'step', case when jsonb_typeof(s.step -> 'step') = 'number'
                            then (s.step ->> 'step')::jsonb end,
               'tool_name', case when jsonb_typeof(s.step -> 'tool_name') = 'string'
                                 then to_jsonb(s.step ->> 'tool_name') end,
               'redacted', true,
               'tool_calls', coalesce((
                 select jsonb_agg(jsonb_build_object('tool_name', coalesce(c ->> 'tool_name', 'unknown')))
                   from jsonb_array_elements(s.step -> 'tool_calls') c
               ), '[]'::jsonb)
             )) as step_json,
             s.ord
        from jsonb_array_elements(coalesce(p_tool_calls, '[]'::jsonb)) with ordinality s(step, ord)
    ) t;
$t$;


revoke execute on function public.fn_lgpd_redigir_tool_calls(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';