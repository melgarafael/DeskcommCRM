-- ═══════════════════════════════════════════════════════════════════════════
-- 0408 — os candidatos da prospecção nativa ganham prazo, e o CRON é quem aplica.
--
-- ─── O que não existia ────────────────────────────────────────────────────
-- A tabela nasce na 0369 sem dono de expurgo: nome, telefone, endereço e
-- identificador de lugar de pessoas que NUNCA falaram com a empresa ficavam
-- para sempre com `status='new'`. Uma campanha montada, pesquisada e
-- abandonada deixava o dado de centenas de pessoas parado sem nenhum evento
-- que o expirasse (issue #1313).
--
-- A declaração de prazo em `lib/retencao/politica.ts` sozinha não fecha a
-- issue — é decorativa, e o teste de guarda diz isso com todas as letras.
-- Quem APLICA é esta função, chamada em lotes pelo cron
-- `app/api/v1/cron/data-retention`, como as outras sete podas da casa.
--
-- ─── Os 365/90 são decisão do dono, não sugestão ──────────────────────────
-- Padrão 365 dias (um ano), piso 90 — alinhado ao horizonte da conversa do
-- caso (0281) e da captação. Decidido pelo dono do projeto em 24/09/2026 no
-- PR #1577 ("São 365 dias, com mínimo de 90"). O piso mora DENTRO do corpo
-- (`greatest(...)`), porque só assim ele vale para QUALQUER chamador,
-- inclusive um `psql` na mão — mesma razão das sete irmãs.
--
-- ─── O relógio é coalesce(attempted_at, created_at) ───────────────────────
-- Nunca contatado conta da CRIAÇÃO (o caso da issue: pesquisado e não
-- abordado). Contatado conta da ÚLTIMA TENTATIVA, para que uma linha antiga
-- com contato recente não seja apagada no meio do funil — o `attempted_at` é
-- gravado pelo worker antes de cada envio (`lib/prospecting/worker.ts`).
--
-- ─── As DUAS guardas que não são idade ────────────────────────────────────
--   • `status not in ('queued','sending')`: trabalho vivo nunca entra no
--     expurgo, em NENHUMA idade. Um envio em andamento é minutos, não anos,
--     mas a guarda é incondicional de propósito — apagar no meio do envio é
--     pior do que a tabela crescer;
--   • `suppression_salt is null`: o tombstone de LGPD (0370) sobrevive para
--     SEMPRE — é ele que faz o trigger `prospecting_refuse_erased` barrar a
--     reimportação de quem pediu exclusão. Expurgar o tombstone reabriria a
--     porta que a anonimização fechou. Este é o caso que a issue aponta como
--     o mais caro: alcançar de menos em expurgo é violação, não é apagamento.
--
-- ─── Reaplicação ──────────────────────────────────────────────────────────
-- `create or replace` + `create index if not exists` + revoke idempotente —
-- o `update.sh` de um clone re-executa sem erro.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.fn_expurgar_prospeccao_vencida(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 365 = um ano, o horizonte decidido pelo dono (0408, issue #1313). O piso
  -- de 90 impede que o knob vire apagador de rastro recente — e mora AQUI,
  -- no corpo, para valer contra qualquer chamador.
  v_dias int := greatest(coalesce(p_retencao_dias, 365), 90);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidos as (
    select c.id from public.prospecting_candidates c
     where c.status not in ('queued','sending')
       and c.suppression_salt is null
       and coalesce(c.attempted_at, c.created_at)
           < now() - make_interval(days => v_dias)
     order by coalesce(c.attempted_at, c.created_at)
     limit v_limite
  )
  delete from public.prospecting_candidates c using vencidos v where c.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
-- As DUAS origens de EXECUTE: o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
-- FUNCTIONS TO anon` do baseline (que `revoke from public` não remove) e o
-- grant implícito a PUBLIC que o Postgres dá a toda função ao criá-la (que
-- `revoke from anon` não remove). Fechar uma só deixa a função exposta com o
-- gate verde — mesmas duas linhas das sete irmãs.
revoke all    on function public.fn_expurgar_prospeccao_vencida(int,int) from public;
revoke execute on function public.fn_expurgar_prospeccao_vencida(int,int) from anon;
revoke execute on function public.fn_expurgar_prospeccao_vencida(int,int) from authenticated;
grant  execute on function public.fn_expurgar_prospeccao_vencida(int,int) to service_role;

-- Índice dedicado ao predicado do expurgo (desenho da 0174): PARCIAL porque
-- só as linhas elegíveis interessam, e em EXPRESSÃO porque o relógio é um
-- coalesce — um índice em `created_at` puro prometeria ordem que a query não
-- pede. Sem ele a poda diária varre a tabela inteira desde a primeira
-- instalação que cria campanha.
create index if not exists prospecting_candidates_expira_idx
  on public.prospecting_candidates ((coalesce(attempted_at, created_at)))
  where status not in ('queued','sending') and suppression_salt is null;
