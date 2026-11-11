-- manifest: **A sincronização de contatos da coexistência pergunta UMA vez por lote quais números do lote foram apagados a pedido (LGPD), em vez de uma pergunta por contato.** Função `fn_titulares_apagados_a_pedido(uuid, text[])` devolve o SUBCONJUNTO dos telefones recebidos que casa com alguma marca da 0750, pela mesma régua da pergunta unitária `fn_titular_apagado_a_pedido` (variantes do nono dígito, HMAC por sal de linha): a agenda do app entrega vários contatos por webhook, e a alternativa — N chamadas — é o N+1 que o caminho de importação do histórico não tem porque processa um número por vez. Nenhuma coluna nova, nenhuma tabela nova; mesma assinatura de permissão da pergunta que já existe (só `service_role` executa). Espelho no apêndice do `supabase/baseline.sql`, ANTES da varredura de `anon` — é `create function`.
--
-- O PROBLEMA. A `smb_app_state_sync` (coexistência) traz o contato que a empresa
-- criou ou renomeou no endereço do app, e o CRM o grava com telefone. Quem pediu
-- apagamento a pedido (LGPD) não pode voltar por aí: a anonimização zera o
-- telefone do cadastro, então o upsert não acha a ficha e INSERE uma nova. A
-- trava existe desde a 0750 e o importador de histórico já a consulta; a
-- sincronização de contatos passou a consultá-la também, uma vez por evento.
--
-- POR QUE UM LOTE. Um webhook da Meta entrega `state_sync[]` com VÁRIOS
-- contatos, e o laço de ingestão chamava a pergunta unitária dentro do laço: um
-- round-trip por contato, para sempre, mesmo quando a organização nunca apagou
-- ninguém. Esta função responde o lote inteiro numa consulta só — e continua
-- respondendo o MESMO que a unitária responderia para cada telefone, porque as
-- duas usam `fn_telefone_variantes` e o mesmo HMAC contra o mesmo sal.
--
-- O QUE ELA NÃO COBRE, de propósito: `lid`. O evento da agenda não traz LID, e
-- responder por um LID que ninguém mandou seria inventar entrada. Quem precisa
-- da pergunta por LID (importação de histórico) continua usando a unitária.

create or replace function public.fn_titulares_apagados_a_pedido(
  p_org uuid,
  p_telefones text[]
)
returns text[] language sql stable
set search_path = public, extensions, pg_temp as $$
  select coalesce(array_agg(t.telefone), '{}'::text[])
    from unnest(coalesce(p_telefones, '{}'::text[])) as t(telefone)
   where t.telefone is not null
     and exists (
       select 1
         from public.lgpd_marcas_de_apagamento m
        where m.organization_id = p_org
          and m.marca_telefone is not null
          and exists (
            select 1
              from unnest(public.fn_telefone_variantes(t.telefone)) as v(digitos)
             where m.marca_telefone = hmac(convert_to(v.digitos, 'UTF8'), m.sal, 'sha256')
          )
     );
$$;
-- AS DUAS ORIGENS DE EXECUTE: a resposta diz QUEM pediu apagamento, então nem
-- `anon` nem `authenticated` a fazem. Mesma negação da unitária.
revoke execute on function public.fn_titulares_apagados_a_pedido(uuid, text[]) from public, anon, authenticated;
grant execute on function public.fn_titulares_apagados_a_pedido(uuid, text[]) to service_role;

notify pgrst, 'reload schema';
