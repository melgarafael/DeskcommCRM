-- manifest: A caixa Hostinger deduplica pela identidade RFC da mensagem, além do cursor IMAP, para uma restauração de UIDVALIDITY não duplicar conversas já vistas.

create unique index if not exists messages_email_rfc_id_unique
  on public.messages (
    organization_id,
    channel_session_id,
    lower(metadata->>'email_message_id_key')
  )
  where nullif(metadata->>'email_message_id_key', '') is not null;

notify pgrst, 'reload schema';
