-- manifest: **O comando da conversa passa a perguntar se a ORGANIZACAO tem atendimento automatico de pe (issue #4012).** `comando_da_conversa(c)` devolvia `automatico` para toda conversa sem dono e sem trava, sem perguntar se existe agente atendendo; o TypeScript ja perguntava (`comandoDaConversa` com `automaticoDaOrg === false` devolve `ninguem`, `lib/inbox/comando-da-conversa.ts:249`), e as funcoes do banco que decidem pelo comando — `fn_definir_carteira_do_cliente` (#3642), adocao e `fn_conversation_assign` — confiavam no SQL e pulavam a conversa. Entram `fn_org_tem_automatico(uuid)` (espelho linha a linha de `agenteAtende` em `lib/ai/agents/no-ar.ts`: arquivado, pausado e sem versao publicada nao atendem; `stable`, invoker, `EXECUTE` so para `service_role`) e o wrapper que rebaixa `automatico` para `ninguem`. O vocabulario do banco ganha `ninguem` (5 valores). A Fila passa a pedir `ninguem` sempre (`comandosDaFila`), mantendo `automatico` apenas pela janela entre este deploy e a migration aplicada. A parte 2 da issue (o comando responder pelo AGENTE e nao pelo numero da conversa) segue aberta. Idempotente: `create or replace`; apendice igual no fim do `baseline.sql`, antes da VARREDURA anon (0116).

-- ---- o comando da conversa sabe se a ORGANIZAÇÃO tem agente no ar (migration 9330, issue #4012) ----
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
--
-- `comando_da_conversa(c)` devolvia `automatico` para TODA conversa sem dono e
-- sem trava, sem perguntar se a organização tem atendimento automático de pé. O
-- TypeScript pergunta (`comandoDaConversa`, `automaticoDaOrg === false` →
-- `ninguem`, lib/inbox/comando-da-conversa.ts:249), e a Fila compensava no
-- SERVIDOR (`comandosDaFila` pedia `aguardando` E `automatico`). As funções do
-- BANCO que decidem pelo comando, não: `fn_definir_carteira_do_cliente` (#3642),
-- `fn_conversa_que_continua` e a adoção de `fn_conversation_assign` filtram
-- `comando_da_conversa(c) <> 'automatico'`. Numa instalação sem IA no ar, passar
-- o cliente para um vendedor não levava conversa nenhuma — a escolha 3-B do Doc
-- 237 ("a conversa da IA fica com a IA") aplicada onde não há IA.
--
-- ─── Onde a régua passa a ser UMA ──────────────────────────────────────────
--
-- `fn_org_tem_automatico` é o espelho SQL de `agenteAtende`
-- (lib/ai/agents/no-ar.ts) — a MESMA função que `/api/v1/ai/automatico-ativo` e
-- `orgTemAutomatico` usam para o fato org-wide — e o wrapper rebaixa `automatico`
-- para `ninguem` quando ela diz que não. `ninguem` entra no vocabulário do banco
-- (era renomeação só de TS justamente porque o SQL não sabia responder); o lado
-- do TS não muda de resposta.
--
-- ─── Por que no BANCO, e não passando o fato por parâmetro ─────────────────
--
-- Quem decide com o comando são funções PL/pgSQL chamadas por service role
-- (`fn_definir_carteira_do_cliente` é `revoke ... from authenticated`): um
-- parâmetro a mais seria uma segunda régua em cada call site, e o call site que
-- esquecesse de passá-lo voltaria a aplicar a regra de onde não há IA.
--
-- A função é `stable` e INVOKER de propósito: chamada de dentro do wrapper
-- (definer) ela roda com o dono; fora dele ninguém tem EXECUTE, porque com o org
-- por argumento ela responderia "esta organização tem agente?" a qualquer sessão
-- — o mesmo motivo que fez `comando_da_conversa` nascer com parâmetro SEM NOME.
--
-- ─── LIMITE DECLARADO (a parte 2 da issue, NÃO fechada aqui) ────────────────
--
-- Isto responde pelo AGENTE na organização, não pelo NÚMERO da conversa. O
-- portão do dreno (`haQuemAtendaASessao`, lib/ai/agents/quem-atende-a-sessao.ts)
-- também pergunta se a versão publicada é DA SESSÃO da conversa e se o canal está
-- liberado no pré-go-live. Um agente publicado no número A com a conversa no
-- número B ainda diz `automatico` aqui.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- Idempotente: `create or replace` nas duas funções; os grants vêm logo abaixo.

create or replace function public.fn_org_tem_automatico(p_organization_id uuid)
returns boolean
language sql
stable
set search_path = public
as $fn$
  -- Espelho linha a linha de `agenteAtende`: arquivado não atende, pausado não
  -- atende, e agente sem versão publicada nunca esteve no ar. É `exists` e não
  -- contagem porque a pergunta é "há alguém?", e uma contagem responderia a mesma
  -- coisa com mais trabalho.
  select exists (
    select 1
      from public.ai_agents a
     where a.organization_id = p_organization_id
       and a.archived_at is null
       and a.paused_at is null
       and a.published_version_id is not null
  );
$fn$;

comment on function public.fn_org_tem_automatico(uuid)
  is 'A organização tem atendimento automático de pé? Espelho SQL de agenteAtende() (lib/ai/agents/no-ar.ts): arquivado, pausado e agente sem versão publicada não atendem. Único lugar do BANCO que responde o fato org-wide do comando (issue #4012); casado por tests/invariants/comando-da-conversa-com-agente-no-ar.test.ts. Responde pelo AGENTE, não pelo número da conversa (a parte 2 da issue segue aberta).';

-- O campo calculado: mesma assinatura, mesmo definer, parâmetro sem nome e o
-- MESMO bit de trava do contato da 0645 — o que muda é só o rebaixamento de
-- `automatico` para `ninguem`. `create or replace`, e não `drop` + `create`: a
-- assinatura e o parâmetro sem nome já são os da 0645, e o `update.sh` roda sem
-- ON_ERROR_STOP — um `create` que falhasse depois do `drop` deixaria a Inbox
-- sem o campo calculado. O replace também preserva a ACL (reafirmada abaixo).
create or replace function public.comando_da_conversa(public.conversations)
returns text
language sql
stable
security definer
set search_path = public
as $comando$
  select case
           -- Dono, fim e trava decidem ANTES (`fn_comando_da_conversa`) e não
           -- passam por aqui: a pergunta da organização só alcança o `automatico`,
           -- que é o único comando que promete alguém respondendo.
           when base.comando = 'automatico'
                and not public.fn_org_tem_automatico($1.organization_id) then 'ninguem'
           else base.comando
         end
    from (
      select public.fn_comando_da_conversa(
        $1.status,
        $1.assigned_to_user_id,
        $1.bot_silenced_until,
        -- O bit consolida `force_human OR is_blocked`; entra no primeiro parâmetro
        -- de trava e o segundo vai `false` (migration 0645, issue #2739).
        $1.contato_trava_humano,
        false,
        now(),
        coalesce($1.is_group, false)
      ) as comando
    ) as base;
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). A trava do contato vem da COLUNA contato_trava_humano (issue #2739); o prazo do silêncio é avaliado NA CONSULTA com now() de verdade; e `automatico` vira `ninguem` quando a organização não tem agente no ar (issue #4012: fn_org_tem_automatico). SECURITY DEFINER e parâmetro SEM NOME desde a 0404 (issue #1571). A regra em si é fn_comando_da_conversa.';

revoke execute on function public.fn_org_tem_automatico(uuid) from public, anon, authenticated;
revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.fn_org_tem_automatico(uuid) to service_role;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

notify pgrst, 'reload schema';
