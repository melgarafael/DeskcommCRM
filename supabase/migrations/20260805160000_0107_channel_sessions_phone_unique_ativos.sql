-- 0107 — a trava de número único passa a ignorar canal ARQUIVADO
--
-- `channel_sessions_phone_per_org_unique UNIQUE (organization_id, phone_number)`
-- é do snapshot original e nasceu antes de existir arquivamento (0106): ela não
-- sabe o que é um canal arquivado, então a linha arquivada continua ocupando o
-- par (organização, número) para sempre.
--
-- O efeito é exatamente o contrário do que a tela promete ("Para voltar a usar
-- este número, será preciso conectar e escanear o QR de novo"): o usuário exclui
-- o canal, pareia o MESMO número de novo, e a primeira gravação do telefone na
-- linha NOVA colide com a linha ARQUIVADA (23505). O canal fica sem número.
--
-- O invariante que a trava protege é "um número vive em UM canal ATIVO" — e
-- canal arquivado não é ativo. Por isso ela vira um ÍNDICE ÚNICO PARCIAL
-- `where archived_at is null`, com o MESMO NOME. O nome é preservado de
-- propósito: `tests/invariants/channel-provider-schema.test.ts` cobra o nome da
-- trava DENTRO da mensagem de erro do INSERT recusado (sem o nome, "rejeitou"
-- não distingue esta trava de um NOT NULL, de uma FK ou da RLS). Mantendo o
-- nome, o invariante continua cobrando o mesmo comportamento para os dois canais
-- ativos, que é o caso que ele descreve.
--
-- ─── O deferimento que se perde, e a medição que autoriza perdê-lo ──────────
-- A constraint era DEFERRABLE INITIALLY DEFERRED e índice parcial não pode ser
-- deferível. O registro de 0087 justificava não mexer nela dizendo que uma trava
-- não-deferível "quebraria no meio qualquer transação que hoje troca números
-- entre duas sessões". Medido nesta árvore: essa transação NÃO existe. Os únicos
-- escritores de `channel_sessions.phone_number` são o health check
-- (`app/api/v1/channel-sessions/[id]/route.ts`) e a conexão do canal oficial
-- (`app/api/v1/channels/official/route.ts`), e ambos fazem UM update/insert de
-- UMA linha via PostgREST — nenhum precisa de violação transitória. O
-- deferimento cobria um caso hipotético; o custo dele era real e diário.
--
-- ─── Backfill: nenhum, por construção e não por sorte ───────────────────────
-- A constraint antiga é ESTRITAMENTE mais forte que o índice novo (ela olha
-- todas as linhas; o índice olha um subconjunto delas). Nenhum banco que a
-- satisfazia pode violar o índice — vale para qualquer clone, não só para este.

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.channel_sessions'::regclass
       and conname = 'channel_sessions_phone_per_org_unique'
  ) then
    alter table public.channel_sessions
      drop constraint channel_sessions_phone_per_org_unique;
  end if;
end $$;

create unique index if not exists channel_sessions_phone_per_org_unique
  on public.channel_sessions (organization_id, phone_number)
  where archived_at is null;
