-- ---- anonimizar pela tela também redige conversas, mensagens e resumos (migration 0391) ----
--
-- Há dois caminhos que anonimizam um contato, e só um redigia a conversa:
--
--   fn_lgpd_cascade_redact_contact   o pedido formal (redact)    redigia mensagens e conversas
--   fn_lgpd_anonymize_contact        o botão da ficha do contato  só o contato
--                                    + lib/lgpd/cascata.ts        (leads, atividades, régua)
--
-- Pelo botão, o nome e o CPF que a pessoa escreveu continuavam no corpo das
-- mensagens, no `last_message_preview` da conversa (o cabeçalho da ficha
-- anonimizada) e no resumo que o agente guarda por contato (`lead_checkpoints`)
-- — o "anonimizado" da tela era mentira sobre o que mais importa.
--
-- O conserto é no ESTADO, não num dos caminhos: um gatilho na virada de
-- `is_anonymized`, o mesmo desenho de `trg_contacts_anonimizado_limpa_custom_fields`
-- e dos outros seis gatilhos de redação deste schema. Assim os dois caminhos — e
-- qualquer um que venha — passam pelo mesmo lugar, na mesma transação da virada.
-- Os comandos de mensagens e conversas são os MESMOS da cascata formal; ela os
-- repete depois, sem efeito novo.
--
-- `lead_checkpoints` não estava em NENHUM dos dois caminhos: o resumo corrido,
-- os compromissos, as objeções, a próxima ação e a declaração do turno são texto
-- escrito por modelo sobre a conversa, e nomeiam a pessoa.
--
-- A mídia das mensagens vai para `storage_redaction_queue` ANTES de a coluna
-- ser zerada: zerar primeiro perderia o único ponteiro para o arquivo, que
-- ficaria no bucket para sempre. `request_id` fica nulo — no caminho do botão não
-- há pedido, e no formal a fila já é idempotente por (bucket, object_path).
create or replace function public.fn_redigir_conversas_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  return new;
end
$$;

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

-- Cura: contatos que JÁ foram anonimizados pelo botão antes deste gatilho. O
-- gatilho só dispara na virada, e para eles a virada já passou. Cada comando só
-- alcança o que existia ATÉ `anonymized_at`: um contato anonimizado que volta a
-- escrever (religado pelo LID) tem conversa NOVA, e reaplicar o baseline no
-- update.sh não pode redigi-la nem mandar a mídia dela para o apagamento.
insert into public.storage_redaction_queue (organization_id, bucket, object_path)
select distinct m.organization_id, 'whatsapp-media', m.media_storage_path
  from public.messages m
  join public.conversations c on c.id = m.conversation_id and c.organization_id = m.organization_id
  join public.contacts k on k.id = c.contact_id and k.organization_id = c.organization_id
 where k.is_anonymized
   and m.created_at <= k.anonymized_at
   and m.media_storage_path is not null
   and length(m.media_storage_path) > 0
on conflict (bucket, object_path) do nothing;

update public.messages m set
  body = '[mensagem anonimizada]',
  media_url = null,
  media_mime = null,
  media_size_bytes = null,
  media_storage_path = null,
  metadata = '{}'::jsonb,
  updated_at = now()
  from public.conversations c
  join public.contacts k on k.id = c.contact_id and k.organization_id = c.organization_id
 where c.id = m.conversation_id
   and c.organization_id = m.organization_id
   and k.is_anonymized
   and m.created_at <= k.anonymized_at
   and (m.body is distinct from '[mensagem anonimizada]'
        or m.media_url is not null
        or m.media_storage_path is not null
        or m.metadata <> '{}'::jsonb);

update public.conversations c set
  metadata = '{}'::jsonb,
  last_message_preview = null,
  last_handoff_reason = null,
  updated_at = now()
  from public.contacts k
 where k.id = c.contact_id
   and k.organization_id = c.organization_id
   and k.is_anonymized
   and coalesce(c.last_message_at, c.created_at) <= k.anonymized_at
   and (c.metadata <> '{}'::jsonb
        or c.last_message_preview is not null
        or c.last_handoff_reason is not null);

update public.lead_checkpoints l set
  rolling_summary = '[resumo anonimizado]',
  commitments = '[]'::jsonb,
  objections = '[]'::jsonb,
  next_action = null,
  declaracao = null
  from public.contacts k
 where k.id = l.contact_id
   and k.organization_id = l.organization_id
   and k.is_anonymized
   and l.created_at <= k.anonymized_at
   and (l.rolling_summary is distinct from '[resumo anonimizado]'
        or l.commitments <> '[]'::jsonb
        or l.objections <> '[]'::jsonb
        or l.next_action is not null
        or l.declaracao is not null);
