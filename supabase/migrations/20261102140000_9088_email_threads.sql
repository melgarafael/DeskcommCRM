-- manifest: E-mails do mesmo contato deixam de compartilhar a mesma conversa; o fio RFC mantém respostas no tópico correto sem mudar a identidade das conversas dos outros canais.

update public.conversations c
   set metadata = coalesce(c.metadata, '{}'::jsonb)
       || jsonb_build_object(
         'email_thread_root_id',
         coalesce(
           nullif(c.metadata->>'email_thread_root_id', ''),
           (
             select lower(btrim(reference.value))
               from jsonb_array_elements_text(
                 case
                   when jsonb_typeof(c.metadata->'email_references') = 'array'
                     then c.metadata->'email_references'
                   else '[]'::jsonb
                 end
               ) with ordinality as reference(value, position)
              where reference.value like '<%>'
                and length(reference.value) <= 998
              order by reference.position
              limit 1
           ),
           lower(nullif(btrim(c.provider_conversation_id), '')),
           'legacy:' || c.contact_id::text
         )
       )
 where c.channel = 'email'
   and c.is_group = false
   and not (coalesce(c.metadata, '{}'::jsonb) ? 'email_thread_root_id');

-- The old 1:1 index remains the global guard for non-email channels. Email now
-- has its own identity: organization + sender + mailbox + RFC thread root.
do $email_conversation_index$
declare
  v_index regclass := to_regclass('public.uniq_conversations_1to1_per_contact_session');
  v_definition text;
begin
  if v_index is not null then
    v_definition := pg_get_indexdef(v_index);
    if position('is distinct from' in lower(v_definition)) = 0
       or position('email' in lower(v_definition)) = 0 then
      drop index public.uniq_conversations_1to1_per_contact_session;
    end if;
  end if;
end
$email_conversation_index$;

create unique index if not exists uniq_conversations_1to1_per_contact_session
  on public.conversations (organization_id, contact_id, channel_session_id)
  where is_group = false and channel is distinct from 'email';

create unique index if not exists uniq_conversations_email_thread_per_contact
  on public.conversations (
    organization_id,
    contact_id,
    channel_session_id,
    (metadata->>'email_thread_root_id')
  )
  where channel = 'email'
    and is_group = false
    and nullif(metadata->>'email_thread_root_id', '') is not null;

create index if not exists conversations_email_references_gin
  on public.conversations using gin (metadata jsonb_path_ops)
  where channel = 'email' and is_group = false;

create index if not exists conversations_email_provider_message_id_idx
  on public.conversations (organization_id, contact_id, channel_session_id, provider_conversation_id)
  where channel = 'email'
    and is_group = false
    and provider_conversation_id is not null;

notify pgrst, 'reload schema';
