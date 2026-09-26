-- 0415 · TETO DE TOKENS ATIVOS POR ORGANIZAÇÃO (issue #1448)
--
-- O que a issue mediu: `api_tokens` tem `revoked_at`/`expires_at`/`scopes`,
-- mas nada — sem CHECK, sem trigger, sem índice — limita QUANTOS tokens
-- ATIVOS uma organização mantém. O teto por token (60/min, Spec 11 §7) é
-- multiplicável por quem já está dentro: dois tokens são 120/min, dez são
-- 600/min, e o teto de ESCRITA (30/min — o que protege o número de WhatsApp)
-- não tem agregado nenhum. O teto agregado por organização do PR #1446
-- (600/min) segura a leitura, mas a própria issue diz: mitigar não é fechar.
--
-- 1 · A TRAVA É DO BANCO: um trigger BEFORE INSERT, único caminho de emissão
--     que não se contorna — rota da tela, PostgREST direto e o mint do runtime
--     passam todos por ele, e nenhum cliente precisa conhecer o limite para
--     ser recusado.
--
-- 2 · A contagem olha só o que está VIVO: `revoked_at is null` e (sem
--     `expires_at` ou ainda não vencido). Sem esse recorte a rotação legítima —
--     revogar o antigo, emitir o novo — bateria no teto, e é justamente o
--     movimento que a trava tem de deixar passar. Revogar e expirar LIBERAM
--     espaço, sempre; a própria mensagem do erro diz isso a quem lê.
--
-- 3 · O ERRO é mensagem própria em PT-BR com o limite escrito e o caminho
--     para liberar espaço (revogar um token não utilizado), SQLSTATE `PT409`
--     no mesmo desenho do `PT404`/`PT422` da 0403: a rota de emissão
--     reconhece o código e devolve 409 com ESTA mensagem, em vez de um 500
--     genérico que não diz o que fazer.
--
-- 4 · Quem já está ACIMA do teto não é afetado: o gatilho recusa SÓ inserção,
--     então a instalação que hoje mantém mais tokens do que o teto segue
--     funcionando e emitindo nada de novo — a pergunta 3 da issue ("não pode
--     quebrar quem está em produção") é respondida por recusar a dianteira,
--     não por apagar linha de ninguém.
--
-- 5 · Contar e gravar não é atômico: duas emissões simultâneas podem passar
--     juntas e deixar o teto estourado por um. Teto de segurança, não cota
--     faturável — a janela não muda ninguém de lado, e uma fila por
--     organização custaria um bloqueio em troca de nada.
--
-- Sem coluna nova, sem backfill, sem policy nova: a RLS por organização já
-- existe (0015) e a tabela é a mesma de sempre.

create or replace function public.fn_teto_de_tokens_ativos() returns trigger
    language plpgsql security definer
    set search_path = ''
as $$
declare
  v_teto   constant integer := 50;
  v_ativos integer;
begin
  select count(*)
    into v_ativos
    from public.api_tokens
   where organization_id = new.organization_id
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  if v_ativos >= v_teto then
    raise exception
      'Teto de tokens ativos por organização atingido: % de %. Revogue um token que não esteja mais em uso (Configurações → Tokens de API → Revogar) para liberar espaço — tokens revogados ou expirados não contam — e tente criar outro.',
      v_ativos, v_teto
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

-- Security definer com search_path fixo: a contagem precisa ver a tabela
-- inteira da organização, seja qual for o papel que insere. Os dois donos do
-- grant viram revoke — a função não é RPC, é gatilho, e o EXECUTE dela não é
-- chamado por ninguém pela REST (mesma conta da 0403).
revoke execute on function public.fn_teto_de_tokens_ativos() from public, anon, authenticated;

comment on function public.fn_teto_de_tokens_ativos() is
  'Gatilho de api_tokens (migration 0415, issue #1448): recusa a INSERÇÃO quando a organização já tem o teto de tokens ATIVOS (sem revoked_at e não expirados). Mensagem própria em PT-BR com o limite e como revogar; SQLSTATE PT409, que a rota de emissão devolve como 409.';

drop trigger if exists trg_teto_de_tokens_ativos on public.api_tokens;

create trigger trg_teto_de_tokens_ativos
    before insert on public.api_tokens
    for each row
    execute function public.fn_teto_de_tokens_ativos();
