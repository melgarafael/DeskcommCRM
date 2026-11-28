-- manifest: **A rotina de retenção poda as chaves de idempotência vencidas (#1613, item B).** `fn_expurgar_chaves_de_idempotencia_vencidas(p_retencao_dias, p_limite)` apaga, em lotes, as linhas de `idempotency_keys` vencidas há mais de 1 dia (piso no corpo), com a linha travada e o vencimento reconferido no `delete`, e sem tocar no recibo da aprovação LGPD; o cron `data-retention` a chama todo dia, como a poda dos nonces de OAuth. EXECUTE só para a service role. Sem mudança de tabela.
-- Sem tabela temporária, sem BEGIN/COMMIT, sem id de tenant, psql puro, idempotente.

-- A rotina de retenção não apagava NENHUMA linha de `idempotency_keys` (#1613,
-- item B): o #4850 fez o `expires_at` valer na leitura e deixou a limpeza para
-- depois — "a tabela só cresce". Cada envio com chave (REST e as ferramentas de
-- envio do MCP) deixa uma linha com o recibo da resposta (`response_body`)
-- dentro, e depois de 24 h ninguém a lê: `lib/api/idempotency.ts` e
-- `fn_create_tenant_with_owner` só aceitam `expires_at > now()`.
--
-- A folga de 1 dia depois do vencimento é a mesma da poda dos nonces de OAuth
-- (`fn_expurgar_nonces_de_oauth`): a reserva vale 60 s e o recibo 24 h, e uma
-- linha recém-vencida pode ser a de um envio que ainda grava o recibo — a
-- leitura a reescreve no lugar (o `expires_at` é o bilhete), e é ela que não
-- pode sumir no meio. Vencida há mais de um dia, ninguém mais a alcança. Se
-- sumir no meio mesmo assim, `lib/api/idempotency.ts` já trata o caso
-- ("expurgo de expirados no meio do caminho": responde em curso e a
-- retentativa refaz a reserva).
--
-- Piso no CORPO, como as irmãs: um chamador que passe 0 ou nulo não apaga o que
-- acabou de vencer. Lote por `p_limite`, para o cron fechar a transação a cada
-- rodada (`idx_idem_expiry` já cobre o filtro).
create or replace function public.fn_expurgar_chaves_de_idempotencia_vencidas(
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
  if p_retencao_dias is null or p_retencao_dias < 1 then
    p_retencao_dias := 1;
  end if;

  -- `for update skip locked` + o vencimento conferido DE NOVO no `delete`: uma
  -- requisição pode estar reescrevendo esta mesma linha vencida como reserva
  -- nova (`lib/api/idempotency.ts` mantém o `id` e renova o `expires_at`). Se
  -- ela chegou primeiro, a linha está travada e fica para outra rodada; se
  -- renovou entre a escolha e o `delete`, o vencimento não confere e ela fica.
  -- A recíproca (a poda chegou primeiro) a própria leitura já trata.
  --
  -- O recibo da aprovação de pedido LGPD fica fora: aquela rota lê a chave SEM
  -- olhar `expires_at`, e o pedido pode voltar a `received` quando o worker
  -- falha — sem o recibo, a mesma requisição repetida aprovaria de novo.
  with alvo as (
    select id
      from public.idempotency_keys
     where expires_at < now() - make_interval(days => p_retencao_dias)
       and endpoint not like '/api/v1/lgpd/%'
     limit greatest(coalesce(p_limite, 1000), 1)
     for update skip locked
  )
  delete from public.idempotency_keys k
   using alvo
   where k.id = alvo.id
     and k.expires_at < now() - make_interval(days => p_retencao_dias);

  get diagnostics v_removidas = row_count;
  return v_removidas;
end$$;

-- Função nova em `public` nasce EXPOSTA (as duas origens de EXECUTE, ver a
-- 0192): só o cron, pela service role, apaga.
revoke execute on function public.fn_expurgar_chaves_de_idempotencia_vencidas(int, int) from public, anon, authenticated;
grant execute on function public.fn_expurgar_chaves_de_idempotencia_vencidas(int, int) to service_role;
