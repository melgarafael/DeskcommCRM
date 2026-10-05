-- manifest: **Canal desativado pelo operador (`channel_sessions.metadata.disabled`) com gravação atômica.** O toggle da tela precisa trocar só a chave `disabled` sem sobrescrever as demais (`ai_gate`, `ai_gate_mode`, `ai_test_phone_numbers`, `social_webhook_id`) — leitura-modificação-escrita no app perderia corrida contra o `fn_configurar_pre_go_live_canal`. Espelha a 0251: valida, `jsonb_set` com `create_missing=true`, `where archived_at is null` (arquivado não se pausa, se exclui), devolve linhas afetadas. Amplia o CHECK de `entregas_de_aviso_de_caso.erro_codigo` com `canal_desativado`: o aviso de caso não sai pela conexão pausada. Sem backfill (ausente = ligado, o comportamento de hoje).
-- 0545: o toggle de canal desativado grava só a chave disabled no metadata
--
-- ─── O defeito ───────────────────────────────────────────────────────────────
--
-- Não existia "desligado" por canal: `status` é do transporte (o health-check
-- sobrescreve) e `archived_at` é exclusão (some da UI, desloga, revoga). Sem
-- escrita atômica, o toggle da tela teria de ler o `metadata` inteiro e
-- reescrevê-lo — e uma gravação concorrente do acesso da IA no meio apagaria a
-- outra. A 0218/0251 já resolveram a mesma corrida para o pré-go-live com RPC;
-- esta repete o desenho para o `disabled`.
--
-- Sem backfill de propósito: `metadata->>'disabled'` ausente, nulo ou qualquer
-- valor não-booleano é lido como canal LIGADO (o comportamento de hoje), então
-- instalações existentes não mudam nada até alguém desligar pela tela.

create or replace function public.fn_definir_canal_desativado(
  p_org uuid,
  p_canal uuid,
  p_desativado boolean
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_linhas integer;
begin
  if p_desativado is null then
    raise exception 'estado do canal inválido' using errcode = '22023';
  end if;

  update public.channel_sessions
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb),
       '{disabled}',
       to_jsonb(p_desativado),
       true
     )
   where organization_id = p_org
     and id = p_canal
     and archived_at is null;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

revoke execute on function public.fn_definir_canal_desativado(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.fn_definir_canal_desativado(uuid, uuid, boolean)
  to service_role;

-- ─── O aviso à equipe também respeita a pausa ───────────────────────────────
--
-- O aviso de caso sai pela conexão da CONFIGURAÇÃO da organização, não pela da
-- conversa. Se ela está pausada, o motor recusa com `canal_desativado` (esperar
-- não resolve, só retomar). Código novo sem CHECK seria `23514` no UPDATE que
-- registra a recusa. Reconstrói o bloco da 0292/0439 com o vocabulário inteiro.

alter table public.entregas_de_aviso_de_caso
  drop constraint if exists entregas_de_aviso_de_caso_erro_codigo_check;
alter table public.entregas_de_aviso_de_caso
  add constraint entregas_de_aviso_de_caso_erro_codigo_check
  check (erro_codigo is null or erro_codigo in (
    'canal_desconectado',
    'canal_arquivado',
    'canal_nao_aceita_aviso_livre',
    'transporte_ausente',
    'destino_invalido',
    'teto_diario_do_numero',
    'sem_endereco_publico',
    'titular_anonimizado',
    'expirou',
    'falha_no_envio',
    'indeterminado',
    'destino_da_propria_organizacao',
    'canal_desativado'));

notify pgrst, 'reload schema';
