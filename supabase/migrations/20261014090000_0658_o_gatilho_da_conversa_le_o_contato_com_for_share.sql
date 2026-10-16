-- manifest: **A conversa que NASCE lê o contato com `for share` — e só ela (issue #2748).** O `fn_conversa_calcula_trava_do_contato` (0645) lia `contacts` sem lock: um `force_human`/`is_blocked` gravado em paralelo, com a transação ainda aberta, não entrava na conversa que nascia naquele instante — ela ficava em `automatico` até a próxima escrita no contato. Medido num Postgres de verdade (pg15, 16 clientes, pgbench no caminho real `fn_upsert_wa_contact` + `fn_upsert_wa_conversation`): a corrida reproduzida (sessão B criava a conversa em 8,8 ms com o `update … force_human` em voo e o bit nascia falso: `true | false | automatico`); e o custo de fechar a corrida com `for share` INGENUAMENTE, que sai caro por um motivo específico — o BEFORE INSERT do upsert de mensagem roda ANTES de o conflito ser detectado, então a leitura com lock era paga a cada mensagem para um valor que o `DO UPDATE` descarta (espalhado 3275 ⇒ 2932 tps; rajada no mesmo contato 596 ⇒ 474). A versão final pula a leitura quando a conversa JÁ existe (a que vai conflitar não grava o valor; a que existe é mantida pelo gatilho do contato) e mantém o `for share` nas duas ocasiões em que o valor VALE: o INSERT que de fato grava e a troca de contato — com ela o bit nasce certo (B espera o commit: 1479 ms, `true | true | aguardando`) e o custo volta ao da main (espalhado 3275 ⇒ 3201, −2%; rajada 596 ⇒ 593, −0,5%; 16 clientes, pg15). Número `0658`: `0655`–`0657` estão em PRs abertos hoje. Gates: `tests/invariants/conversa-que-nasce-durante-a-trava-do-contato.test.ts` (duas sessões concorrentes; vermelho sem o `for share`) e as medições no PR.

-- 0658: a conversa que nasce lê o contato com `for share` (issue #2748).
--
-- Detalhe completo no cabeçalho do bloco abaixo; o bloco é o MESMO, letra a
-- letra, no apêndice de `supabase/baseline.sql` — é ele que o `update.sh`
-- reaplica a cada atualização, inclusive em quem nunca vai rodar migrations.

-- ---- a conversa que nasce lê o contato com `for share` (migration 0658, issue #2748) ----
-- O gatilho `fn_conversa_calcula_trava_do_contato` lia `contacts` sem lock: um
-- `force_human`/`is_blocked` gravado em paralelo (transação ainda aberta) nascia
-- FORA da conversa nova, e ela ficava em `automatico` até a próxima escrita no
-- contato.
--
-- `for share` fecha a corrida nas DUAS ordens: a conversa que nasce espera o
-- commit do contato; o update do contato espera a conversa nascer.
--
-- E o lock SÓ é pago quando o valor vale: a tentativa de INSERT do upsert de
-- mensagem passa por este gatilho antes de o conflito ser detectado — quando a
-- conversa já existe, o `DO UPDATE` só toca `updated_at` e o valor calculado
-- seria descartado. Sem o pulo abaixo, a leitura com lock entra em toda
-- mensagem e disputa com o UPDATE de contato do próprio ingest (medido na
-- issue #2748: -10% a -20%). A conversa que já existe é mantida pelo gatilho
-- do contato (`fn_contato_atualiza_trava_nas_conversas`).
--
-- O `select` vira `into` porque cláusula de lock (FOR SHARE) não é aceita
-- dentro de subconsulta de expressão, que era a forma da 0645.

create or replace function public.fn_conversa_calcula_trava_do_contato()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_trava boolean;
begin
  -- Vai conflitar (a conversa já existe): o valor desta tentativa é descartado
  -- pelo `DO UPDATE` do upsert — não paga leitura nem lock por ele.
  if tg_op = 'INSERT' and not new.is_group
     and exists (
       select 1
         from public.conversations c
        where c.organization_id = new.organization_id
          and c.contact_id = new.contact_id
          and c.channel_session_id = new.channel_session_id
          and not c.is_group
     )
  then
    return new;
  end if;

  select (ct.force_human or ct.is_blocked)
    into v_trava
    from public.contacts ct
   where ct.id = new.contact_id
     and ct.organization_id = new.organization_id
   for share;
  new.contato_trava_humano := coalesce(v_trava, false);
  return new;
end;
$fn$;
