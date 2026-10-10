-- 0190 — o mesmo `state` do OAuth do Google valia duas vezes
--
-- O QUÊ: tabela `public.calendar_oauth_nonces`, onde o callback QUEIMA o nonce
-- do `state` no primeiro uso.
--
-- POR QUÊ: o `state` é assinado com HMAC e tem prazo de dez minutos, e dentro
-- desse prazo ele valia quantas vezes fosse apresentado — o nonce era emitido e
-- jogado fora. A dívida estava declarada em `lib/agenda/google/estado.ts` desde
-- que aquele arquivo nasceu, e o cético a provou POR EXECUÇÃO.
--
-- TABELA E NÃO REDIS, e a razão é falhar fechado. Postgres é o único
-- armazenamento garantido em TODA instalação; o Upstash é opcional no
-- self-host. Uma propriedade de segurança que degrada em silêncio onde a
-- dependência opcional falta é pior que propriedade nenhuma — a instalação sem
-- Redis PARECERIA protegida.
--
-- ⚠️ ISTO FECHA REPLAY, E SÓ. A outra porta — o callback aceitar um `state`
-- válido apresentado por OUTRA pessoa — é fechada pela leitura da sessão, que já
-- está no callback. São portas diferentes, e a distinção importa: durante horas
-- a dívida do nonce deu a impressão de cobrir as duas.
--
-- A LIMPEZA JÁ TEM DONO: o cron `data-retention`, que hoje poda fila, auditoria
-- e o espelho da agenda. Esta é a quarta poda, e a função abaixo é a que ele
-- chama. Sem ela a tabela cresceria para sempre — uma linha por conexão
-- tentada, para sempre, num produto que se instala e ninguém monitora.

create table if not exists public.calendar_oauth_nonces (
  nonce text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- O prazo do próprio `state`. Depois dele a linha não serve para mais nada:
  -- um `state` vencido já é recusado pela assinatura, antes de chegar aqui.
  expira_em timestamptz not null,
  usado_em timestamptz not null default now()
);

comment on table public.calendar_oauth_nonces is
  'Nonces de state do OAuth do Google já usados. A chave primária é o próprio nonce: a segunda tentativa viola a unicidade, e é assim que o replay é recusado.';

create index if not exists calendar_oauth_nonces_expiracao_idx
  on public.calendar_oauth_nonces (expira_em);

alter table public.calendar_oauth_nonces enable row level security;

-- Sem policy nenhuma, e é deliberado: quem escreve é o callback do OAuth, com
-- service role, e ninguém precisa LER isto pela API. Policy aqui só abriria
-- caminho para enumerar tentativas de conexão pelo PostgREST.
revoke all on public.calendar_oauth_nonces from anon, authenticated;

-- A quarta poda do `data-retention`. Assinatura idêntica às três irmãs
-- (`p_dias`, `p_lote`) para o mesmo laço de lotes servir sem caso especial.
create or replace function public.fn_expurgar_nonces_de_oauth(p_dias int, p_lote int default 500)
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
  if p_dias is null or p_dias < 1 then
    p_dias := 1;
  end if;

  with alvo as (
    select nonce
      from public.calendar_oauth_nonces
     where expira_em < now() - make_interval(days => p_dias)
     limit greatest(p_lote, 1)
  )
  delete from public.calendar_oauth_nonces n
   using alvo
   where n.nonce = alvo.nonce;

  get diagnostics v_removidas = row_count;
  return v_removidas;
end$$;

-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE.
revoke execute on function public.fn_expurgar_nonces_de_oauth(int, int) from public, anon;
grant execute on function public.fn_expurgar_nonces_de_oauth(int, int) to service_role;
