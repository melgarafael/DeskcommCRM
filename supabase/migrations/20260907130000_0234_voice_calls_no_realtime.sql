-- Forward-fix da 0206 (chamada de voz WaCalls): a migration criou
-- `voice_calls` mas esqueceu de ligá-la na publicação `supabase_realtime`.
--
-- Sem isto, `ActiveCallPanel`/`IncomingCallBanner` (hooks/voice/useVoiceCallSession.ts)
-- nunca recebem o INSERT/UPDATE que o worker grava — a chamada toca de
-- verdade, o banco registra certinho (`voice_calls.status = 'ringing'`), e a
-- tela não mostra nada. Achado testando ao vivo: ligação real chegou, tocou
-- 46s, encerrou sem resposta, e o navegador ficou mudo o tempo todo.
--
-- Idempotente: só adiciona se ainda não estiver na publicação.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'voice_calls'
  ) then
    execute 'alter publication supabase_realtime add table public.voice_calls';
  end if;
end $$;
