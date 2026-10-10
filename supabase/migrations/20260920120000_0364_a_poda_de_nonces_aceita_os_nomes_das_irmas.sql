-- 0364 — A poda de nonces de OAuth aceita os nomes das irmãs — e a
-- ATUALIZAÇÃO recebe o conserto porque a assinatura antiga é derrubada antes.
--
-- ── O defeito, medido ────────────────────────────────────────────────────────
--
-- O cron `app/api/v1/cron/data-retention/route.ts` drena TODAS as podas pelo
-- MESMO laço de lotes (linha 163), mandando sempre o mesmo objeto:
--
--     db.rpc(nome, { p_retencao_dias: dias, p_limite: TAMANHO_DO_LOTE })
--
-- O PostgREST resolve a sobrecarga pelo NOME do argumento — não pela posição.
-- `public.fn_expurgar_nonces_de_oauth` nasceu na 0190 com `(p_dias int,
-- p_lote int default 500)`: recebe os mesmos dois `int`, na mesma ordem, mas
-- com outros nomes. Para o PostgREST isso é outra função, e nenhuma sobrecarga
-- casa. O resultado não é erro silencioso: é `PGRST202` todo dia, a poda de
-- nonces não apaga nada, e `public.calendar_oauth_nonces` — a tabela que
-- impede reuso do `state` do login Google — cresce para sempre.
--
-- As outras seis funções que o mesmo laço chama já falam `p_retencao_dias` /
-- `p_limite` (`fn_podar_fila_de_jobs`, `fn_expurgar_auditoria_vencida`,
-- `fn_expurgar_espelho_da_agenda`, `fn_expurgar_conversa_do_caso_vencida`,
-- `fn_expurgar_passagens_vencidas`, `fn_expurgar_avisos_de_caso_vencidos`).
-- Esta é a SÉTIMA, e era a única fora do vocabulário.
--
-- ── O efeito colateral que ninguém tinha medido ──────────────────────────────
--
-- No mesmo bloco do cron, a varredura de anonimizações LGPD interrompidas
-- (`route.ts:271`) roda DEPOIS das podas. Enquanto a poda de nonces lançava, o
-- bloco não chegava lá: o defeito de uma linha de SQL suspendia, todos os dias,
-- a retomada de anonimização de quem pediu exclusão. Consertar a assinatura
-- reabre esse caminho sem tocar nele.
--
-- ── Por que a assinatura antiga é DERRUBADA, e não substituída ──────────────
--
-- `create or replace` NÃO troca nome de parâmetro de entrada. O Postgres
-- recusa a troca com "cannot change name of input parameter", porque o nome do
-- parâmetro faz parte da identidade da função para quem chama por nome — que é
-- exatamente o caso do PostgREST. Sem o `drop` abaixo, numa instalação que já
-- existe esta migration termina sem efeito: a função antiga continua lá, o
-- `create` nem chega a ser tentado com os nomes novos de forma útil, e a issue
-- não fecha. Por isso o `drop function if exists` vem ANTES do `create`, aqui
-- E no trecho correspondente do `supabase/baseline.sql` — que o `update.sh`
-- reaplica inteiro, e é o caminho por onde a instalação existente é consertada.
--
-- A assinatura `(int, int)` é a mesma: muda só o NOME. O `drop` leva os ACLs
-- junto, então o `revoke`/`grant` da 0192 é reaplicado logo abaixo — sem isso a
-- função voltaria com o EXECUTE que o `alter default privileges` do baseline dá
-- a `anon`, que é o buraco que a 0192 fechou.
--
-- ── O default do lote ───────────────────────────────────────────────────────
--
-- `p_limite` passa a ser `default null` como nas seis irmãs, e o 500 que a 0190
-- declarava continua valendo no CORPO (`coalesce(p_limite, 500)`): quem chama
-- sem o argumento — ninguém hoje, o cron sempre manda — segue apagando 500 por
-- lote, e a forma declarada fica idêntica à das irmãs. O piso de 1 dia em
-- `p_retencao_dias` também continua no corpo, como antes.
--
-- Nenhum dado é tocado por esta migration, e não há backfill: ela só troca o
-- NOME dos parâmetros de uma função. Os nonces que venceram enquanto o cron
-- falhava são apagados pelo primeiro lote bem-sucedido, que agora acontece.

drop function if exists public.fn_expurgar_nonces_de_oauth(int, int);

create or replace function public.fn_expurgar_nonces_de_oauth(
  p_retencao_dias int default null,
  p_limite int default null
)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_removidas int;
begin
  -- Piso no CORPO, como as irmãs: um chamador que passe 0 não apaga nonce que
  -- ainda protege. O prazo do state é de 10 minutos, então um dia já é folga
  -- de duas ordens de grandeza.
  if p_retencao_dias is null or p_retencao_dias < 1 then
    p_retencao_dias := 1;
  end if;

  with alvo as (
    select nonce
      from public.calendar_oauth_nonces
     where expira_em < now() - make_interval(days => p_retencao_dias)
     -- 500 era o default DECLARADO na 0190; agora mora no corpo, como nas
     -- irmãs, e o efeito de quem omite o argumento é o mesmo.
     limit greatest(coalesce(p_limite, 500), 1)
  )
  delete from public.calendar_oauth_nonces n
   using alvo
   where n.nonce = alvo.nonce;

  get diagnostics v_removidas = row_count;
  return v_removidas;
end$$;

-- O `drop` acima derrubou a função COM os ACLs dela, então este par não é
-- redundância com a 0192: é o que repoõe o estado que aquela migration deixou.
-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE (o
-- `alter default privileges` do baseline para `anon`, e o grant implícito ao
-- dono) —, e `authenticated` entra pela 0192 pelo mesmo motivo das irmãs.
revoke execute on function public.fn_expurgar_nonces_de_oauth(int, int) from public, anon, authenticated;
grant execute on function public.fn_expurgar_nonces_de_oauth(int, int) to service_role;

notify pgrst, 'reload schema';
