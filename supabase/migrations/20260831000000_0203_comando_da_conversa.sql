-- ---- o banco passa a saber quem manda na conversa (migration 0203) ----
--
-- ## O defeito, medido na VPS do dono em 2026-08-30
--
-- As abas da Inbox descreviam QUEM MANDA lendo `conversations.status` cru. O
-- motor de IA nunca lê essa coluna. Na base real:
--
--     aba "IA"   (?status=ai_handling)              ->  2 conversas
--     aba "Fila" (sem dono + status open|pending)   -> 83 conversas
--     o motor realmente atenderia                   -> 49 conversas
--
-- `ai_handling` só é escrito por UM caminho em produção (a volta pelo botão
-- "Devolver ao automático"), então a aba da IA ficava quase vazia enquanto o robô
-- atendia quase tudo, e a Fila chamava de "aguardando atendente" o que o robô
-- estava atendendo naquele instante.
--
-- ## Por que a regra desce para o banco
--
-- O filtro precisa de `contacts.force_human` e `contacts.is_blocked`, que moram em
-- OUTRA tabela — reescrevê-lo no construtor de query seria a regra em duas
-- encarnações, que é exatamente o defeito que o worker legado acabou de pagar
-- (comparava `new Date('infinity')`, que é NaN, e a guarda nunca disparava).
--
-- Como campo calculado, o predicado vira UM só: a lista, os contadores, o painel
-- do gerente e o "você é o Nº da fila" que o cliente ouve pelo WhatsApp passam a
-- perguntar a mesma coisa ao mesmo lugar, e o cursor de paginação continua
-- intacto (filtrar em memória o quebraria).
--
-- ## O que impede TS e SQL de divergirem
--
-- `tests/invariants/comando-da-conversa-espelha-o-ts.test.ts` — produto cartesiano
-- do espaço de entrada inteiro (o domínio de `status` é lido de `pg_constraint`,
-- não digitado), comparado caso a caso com `comandoDaConversa()` de
-- `lib/inbox/comando-da-conversa.ts`. Status novo no CHECK que o corpus não cubra
-- REPROVA, em vez de sair da conta em silêncio.
--
-- ## Duas funções, e a separação tem motivo
--
-- `fn_comando_da_conversa` é a REGRA: `immutable`, sem tocar em tabela, com
-- `p_agora` como parâmetro — é o que o teste de espelho consegue chamar com um
-- relógio fixo, e sem isso o gate teria dois relógios e falharia de vez em quando
-- sozinho. `comando_da_conversa(conversations)` é a EXPOSIÇÃO: resolve o contato e
-- carimba `now()`; a assinatura de um argumento do tipo da tabela é o que faz o
-- PostgREST publicá-la como campo calculado (medido no PostgREST 14.10: aparece em
-- `?select=` e FILTRA em `?comando_da_conversa=in.(...)`).
create or replace function public.fn_comando_da_conversa(
  p_status                text,
  p_assigned_to_user_id   uuid,
  p_bot_silenced_until    timestamptz,
  p_force_human           boolean,
  p_is_blocked            boolean,
  p_agora                 timestamptz
) returns text
language sql
immutable
set search_path = public
as $fn_comando$
  select case
    -- A ordem é a mesma de `comandoDaConversa`, e ela é o contrato: dono primeiro
    -- (a aba "Fechadas" precisa continuar dizendo QUEM atendeu), encerrada depois,
    -- e só então as travas.
    when p_assigned_to_user_id is not null then 'humano'
    when p_status in ('closed', 'archived', 'resolved') then 'encerrada'
    when p_force_human is true
      or p_is_blocked is true
      or (p_bot_silenced_until is not null and p_bot_silenced_until > p_agora) then 'aguardando'
    else 'automatico'
  end;
$fn_comando$;

comment on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz)
  is 'Quem manda na conversa. Espelho SQL de comandoDaConversa() (lib/inbox/comando-da-conversa.ts); as duas são casadas por tests/invariants/comando-da-conversa-espelha-o-ts.test.ts.';

create or replace function public.comando_da_conversa(c public.conversations)
returns text
language sql
stable
set search_path = public
as $comando$
  select public.fn_comando_da_conversa(
    c.status,
    c.assigned_to_user_id,
    c.bot_silenced_until,
    -- `coalesce` porque `contact_id` é anulável no schema: contato ausente não pode
    -- virar `null` e derrubar a linha inteira para fora de todo filtro — o efeito
    -- seria uma conversa invisível em TODAS as abas.
    coalesce((select ct.force_human from public.contacts ct where ct.id = c.contact_id), false),
    coalesce((select ct.is_blocked  from public.contacts ct where ct.id = c.contact_id), false),
    now()
  );
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). Resolve o contato e carimba now(); a regra em si é fn_comando_da_conversa.';

-- Doutrina de migrations, regra 9: função nova em `public` nasce EXPOSTA, e são
-- DUAS origens de EXECUTE. A varredura auto-curativa no fim deste arquivo NÃO
-- alcança estas duas — o laço dela percorre só `p.prosecdef` (security definer), e
-- estas são invoker de propósito (o campo calculado tem de respeitar a RLS de quem
-- pergunta). Então a revogação é explícita aqui.
revoke execute on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz) from public, anon;
revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz) to authenticated, service_role;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

-- Sem isto o campo existe no banco e o PostgREST segue servindo o schema velho:
-- `?comando_da_conversa=...` volta 400 e a Inbox inteira fica vazia até alguém
-- reiniciar o serviço à mão — que é justamente o passo manual que a doutrina de
-- packaging proíbe pedir a quem opera uma VPS.
notify pgrst, 'reload schema';
