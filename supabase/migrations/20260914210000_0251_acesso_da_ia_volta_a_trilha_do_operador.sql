-- 0241 · O modo de acesso da IA volta atrás junto com o gate (forward-fix da 0218)
--
-- ─── O defeito (issue #602) ────────────────────────────────────────────────
--
-- A RPC da 0218 gravava o literal 'pre_go_live' em `ai_gate_mode` em TODA
-- chamada, inclusive quando o modo escolhido era `open`. O campo nunca voltava
-- atrás: abrir o canal ao público limpava o `ai_gate`, mas deixava o marcador de
-- teste para trás.
--
-- Sozinho isso é inerte — quem discrimina é `ai_gate` primeiro, e o canal aberto
-- segue sendo lido como aberto. O custo aparece na volta: o script CLI
-- `scripts/ativar-gate-elegibilidade-ia.ts` liga o allowlist POR ORIGEM (gate da
-- 0206) e escrevia só `{ai_gate}`. Com o marcador velho ainda no jsonb, o canal
-- reaparecia em PRÉ-GO-LIVE, com a lista de testadores antiga, em vez da
-- autorização por origem que o operador pediu — e o preflight do próprio script
-- relatava o oposto do que o motor executava (`autorizado` no plano,
-- `fora_da_lista_de_teste` no runtime). Falha fechada e silenciosa: a IA para de
-- responder a quem deveria atender e nada acusa erro.
--
-- ─── A correção ────────────────────────────────────────────────────────────
--
-- `ai_gate_mode` recebe o modo REAL da chamada (`p_modo`), no mesmo vocabulário
-- do contrato da tela (`lib/ai/elegibilidade/pre-go-live.ts`,
-- `aiAccessUpdateSchema`: 'open' | 'pre_go_live'). Abrir ao público passa a
-- gravar 'open'; o marcador 'pre_go_live' só existe enquanto o canal está em
-- teste, que é o que a tela mostra e o que `lerModoDeAcessoDaIa` lê.
--
-- ─── Por que a 0218 não foi editada ────────────────────────────────────────
--
-- A 0218 já está aplicada (o kit self-host aplica o baseline e o `update.sh`
-- roda o que é novo). Corrigi-la retroativamente não chegaria em quem instalou:
-- esta migration REPETE a função corrigida — `create or replace`, sem DDL novo,
-- sem backfill.
--
-- Não há backfill de propósito: canal que hoje carrega o marcador velho com
-- `ai_gate='open'` continua lido como aberto (o discriminador é `ai_gate`), e o
-- marcador sai na PRÓXIMA gravação da tela ou do script. Escrever em
-- `channel_sessions` de instalações existentes para consertar um campo cujo
-- estado errado é inerte seria o risco sem o benefício.

create or replace function public.fn_configurar_pre_go_live_canal(
  p_org uuid,
  p_canal uuid,
  p_modo text,
  p_numeros text[]
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_linhas integer;
  v_gate text;
begin
  if p_modo is null or p_modo not in ('open', 'pre_go_live') then
    raise exception 'modo de acesso da IA inválido' using errcode = '22023';
  end if;

  if p_numeros is null or exists (
    select 1
      from unnest(p_numeros) as n(numero)
     where numero is null or numero !~ '^\+[1-9][0-9]{7,14}$'
  ) then
    raise exception 'lista de telefones de teste inválida' using errcode = '22023';
  end if;

  v_gate := case when p_modo = 'pre_go_live' then 'allowlist' else 'open' end;

  update public.channel_sessions
     set metadata = jsonb_set(
       jsonb_set(
         jsonb_set(coalesce(metadata, '{}'::jsonb), '{ai_gate}', to_jsonb(v_gate), true),
         -- O modo REAL, não o literal (o defeito da issue #602).
         '{ai_gate_mode}', to_jsonb(p_modo), true
       ),
       '{ai_test_phone_numbers}', to_jsonb(p_numeros), true
     )
   where organization_id = p_org
     and id = p_canal
     and archived_at is null;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

revoke execute on function public.fn_configurar_pre_go_live_canal(uuid, uuid, text, text[])
  from public, anon, authenticated;
grant execute on function public.fn_configurar_pre_go_live_canal(uuid, uuid, text, text[])
  to service_role;

notify pgrst, 'reload schema';
