/**
 * ATENDIMENTO CONJUNTO — O CONVIDADO VÊ A CONVERSA, E O DONO NÃO MUDA (issue
 * #2542, migration 0661).
 *
 * ## O que este arquivo prova, e por que não cabe em `rls-isolation`
 *
 * `rls-isolation.test.ts` prova o eixo TENANT (a organização A não lê a linha
 * da organização B) e `rls-completude-varredura` cobra que a tabela nova ganhe
 * uma prova de verdade. Nenhum dos dois mede o eixo que é a RAZÃO desta
 * feature existir:
 *
 *   · o CONVIDADO — um `agent` que a RLS de conversas esconde — passa a VER a
 *     conversa (e as mensagens dela) depois de convidado;
 *   · o DONO da conversa NÃO muda quando alguém entra: entrar não é assumir;
 *   · remover o participante (o `left_at`) TIRA o acesso de novo;
 *   · a linha de participação de OUTRA organização não é lida.
 *
 * As DUAS pontas de cada par importam. Só "o convidado vê" é satisfeito por uma
 * policy sem recorte nenhum; só "o colega não vê" é satisfeito por uma tabela
 * vazia. A régua é a contagem com o JWT simulado, nas duas direções.
 *
 * ## A configuração da medição
 *
 * Organização em `settings.visibility_mode = 'own'` (o modo mais estrito), com a
 * conversa ATRIBUÍDA ao atendente A. É o único modo em que o recorte por
 * atendente aparece: em `all` todo mundo lê, e em `own_and_unassigned` (o
 * default) uma conversa SEM dono é visível a todos — medir no default seria
 * medir o caso em que a policy não faz diferença, e o `or exists` de
 * participante diria nada.
 *
 * ## Sabotagem prevista
 *
 * Remover o ramo `or exists (… conversation_participants …)` de
 * `conversations_select` deixa VERMELHO só o caso "o convidado vê a conversa" (e
 * o da mensagem herdada) — o caso do colega não-participante e o do dono seguem
 * verdes, porque são medidos pela metade `fn_can_view_conversation`, que não se
 * mexe. Trocar o predicado por `true` faria o caso do colega não-participante
 * cair: a outra metade da policy não se mexe.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

// Namespace próprio (25420000-), como nos invariantes das ondas anteriores: a
// semente é idempotente E não colide com a de outro arquivo rodando contra o
// mesmo banco.
const ORG_A = "25420000-0000-4000-8000-000000000001";
const ORG_B = "25420000-0000-4000-8000-000000000002";
/** Dono da conversa. */
const ATENDENTE_A = "25420000-1111-4000-8000-000000000001";
/** Colega, mesmo papel, sem a conversa. É o CONVIDADO. */
const ATENDENTE_B = "25420000-1111-4000-8000-000000000002";
const GESTOR = "25420000-1111-4000-8000-000000000003";
/** Membro `agent` da OUTRA organização — o eixo cross-tenant. */
const ATENDENTE_B_ORG = "25420000-1111-4000-8000-000000000004";
const SESSAO_A = "25420000-2222-4000-8000-000000000001";
const CONTATO_A = "25420000-3333-4000-8000-000000000001";
const CONVERSA_A = "25420000-4444-4000-8000-000000000001";
const MENSAGEM_A = "25420000-5555-4000-8000-000000000001";

/**
 * O prefixo que põe a sessão no mesmo lugar em que o PostgREST põe a de um
 * usuário logado: papel `authenticated` + `request.jwt.claims` — o caminho
 * exato que `auth.uid()` e as policies de produção leem.
 */
function comoMembro(userId: string): string {
  return `set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

function contaComoMembro(userId: string, consulta: string): number {
  const saida = sql(`${comoMembro(userId)}\n${consulta};`).trim();
  const ultima = saida.split("\n").at(-1) ?? "";
  if (!/^\d+$/.test(ultima)) throw new Error(`saída inesperada do psql: ${saida}`);
  return Number(ultima);
}

const CONVERSAS_QUE_VEJO = `select count(*) from public.conversations
   where organization_id = '${ORG_A}' and id = '${CONVERSA_A}'`;
const MENSAGENS_QUE_VEJO = `select count(*) from public.messages
   where organization_id = '${ORG_A}' and id = '${MENSAGEM_A}'`;
const MINHA_PARTICIPACAO = `select count(*) from public.conversation_participants
   where organization_id = '${ORG_A}' and user_id = auth.uid()`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ATENDENTE_A}',     'conjunto-2542-a@invariant.test'),
      ('${ATENDENTE_B}',     'conjunto-2542-b@invariant.test'),
      ('${GESTOR}',          'conjunto-2542-gestor@invariant.test'),
      ('${ATENDENTE_B_ORG}', 'conjunto-2542-b-org@invariant.test')
      on conflict do nothing;

    -- visibility_mode = 'own': o modo mais estrito, e o único em que o recorte
    -- por atendente aparece (ver o cabeçalho).
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG_A}', 'conjunto-2542-a', 'Conjunto 2542 A', 'Conjunto A',
              '{"visibility_mode":"own"}'::jsonb),
             ('${ORG_B}', 'conjunto-2542-b', 'Conjunto 2542 B', 'Conjunto B',
              '{"visibility_mode":"own"}'::jsonb)
      on conflict (id) do update set settings = excluded.settings;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ATENDENTE_A}',     '${ORG_A}', 'agent',   now()),
      ('${ATENDENTE_B}',     '${ORG_A}', 'agent',   now()),
      ('${GESTOR}',          '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_B_ORG}', '${ORG_B}', 'agent',   now())
      on conflict do nothing;

    -- DO + exception (não ON CONFLICT): channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita.
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'conjunto-2542', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_A}', '${ORG_A}', 'Conjunto 2542 Contato')
      on conflict do nothing;

    -- A conversa tem DONO, e é isso que faz a medição existir.
    insert into public.conversations
        (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id)
      values ('${CONVERSA_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}', 'open', '${ATENDENTE_A}')
      on conflict (id) do update set assigned_to_user_id = excluded.assigned_to_user_id;

    insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MENSAGEM_A}', '${ORG_A}', '${CONVERSA_A}', '${SESSAO_A}', '${CONTATO_A}',
              'text', 'inbound', 'conjunto 2542 probe')
      on conflict (id) do nothing;

    -- A participação ATIVA do colega: é ela que faz o convidado ver a conversa.
    insert into public.conversation_participants
        (organization_id, conversation_id, user_id, invited_by, joined_at, left_at)
      values ('${ORG_A}', '${CONVERSA_A}', '${ATENDENTE_B}', '${ATENDENTE_A}', now(), null)
      on conflict (conversation_id, user_id) do update set left_at = null;
  `);
});

describe("0661 — atendimento conjunto: o convidado vê, o dono não muda", () => {
  it("CONTROLE DE VACUIDADE: a conversa e a participação existem no banco", () => {
    // Sem isto, uma semente que não entrou faria TODAS as contagens abaixo
    // devolverem 0 — e o caso do convidado passaria afirmando "vê" sobre nada.
    const conv = sql(`select count(*) from public.conversations where id = '${CONVERSA_A}';`)
      .trim()
      .split("\n")
      .at(-1);
    const parte = sql(
      `select count(*) from public.conversation_participants
        where conversation_id = '${CONVERSA_A}' and user_id = '${ATENDENTE_B}';`,
    )
      .trim()
      .split("\n")
      .at(-1);
    expect(Number(conv), "a semente da conversa não entrou").toBe(1);
    expect(Number(parte), "a semente da participação não entrou").toBe(1);
  });

  it("o DONO vê a conversa (o controle positivo que a feature não pode quebrar)", () => {
    expect(contaComoMembro(ATENDENTE_A, CONVERSAS_QUE_VEJO)).toBe(1);
  });

  it("o CONVIDADO vê a conversa — o ramo de participante da policy", () => {
    // ATENDENTE_B não é o dono e a org está em 'own': sem a participação ele
    // veria 0 (o caso abaixo prova a direção negativa). Com participação ativa,
    // o `or exists (…)` de `conversations_select` o deixa entrar.
    expect(
      contaComoMembro(ATENDENTE_B, CONVERSAS_QUE_VEJO),
      "o convidado não vê a conversa para a qual foi convidado",
    ).toBe(1);
  });

  it("o CONVIDADO vê as MENSAGENS da conversa (herança pela policy de conversations)", () => {
    // `messages_select` é `exists (select 1 from conversations c where
    // c.id = messages.conversation_id)` — a subconsulta roda sob a RLS de
    // `conversations`, então a porta do participante alcança as mensagens sem
    // ramo próprio. Este caso prova que a herança funciona para o convidado.
    expect(
      contaComoMembro(ATENDENTE_B, MENSAGENS_QUE_VEJO),
      "o convidado vê a conversa mas não as mensagens dela",
    ).toBe(1);
  });

  it("o GESTOR vê a conversa — por desenho, não por acidente", () => {
    // `fn_can_view_conversation` devolve `true` para manager/admin. A decisão é
    // do dono do produto e está declarada.
    expect(contaComoMembro(GESTOR, CONVERSAS_QUE_VEJO)).toBe(1);
  });

  it("REMOVER o participante tira o acesso (left_at)", () => {
    // Marca a saída e mede de novo. O `exists` da policy filtra `left_at is
    // null`: a participação encerrada deixa de conceder a visão.
    sql(`update public.conversation_participants set left_at = now()
          where conversation_id = '${CONVERSA_A}' and user_id = '${ATENDENTE_B}';
         select pg_sleep(0);`);
    expect(
      contaComoMembro(ATENDENTE_B, CONVERSAS_QUE_VEJO),
      "o acesso sobrevive à remoção do participante",
    ).toBe(0);
    // Restaura para os casos seguintes (ordem do arquivo é estável).
    sql(`update public.conversation_participants set left_at = null
          where conversation_id = '${CONVERSA_A}' and user_id = '${ATENDENTE_B}';`);
    expect(contaComoMembro(ATENDENTE_B, CONVERSAS_QUE_VEJO)).toBe(1);
  });

  it("membro REVOGADO com participação ativa deixa de ver a conversa", () => {
    // A participação não sobrevive à saída da organização: o `exists` de
    // `conversations_select` lê `conversation_participants` sob a RLS dela, que
    // exige `fn_user_org_ids` — quem foi revogado some dali. Sem esse recorte,
    // um ex-funcionário seguiria lendo a conversa enquanto ninguém o removesse.
    sql(`update public.user_organizations set revoked_at = now()
          where user_id = '${ATENDENTE_B}' and organization_id = '${ORG_A}';`);
    try {
      expect(
        contaComoMembro(ATENDENTE_B, CONVERSAS_QUE_VEJO),
        "o membro revogado continua vendo a conversa pela participação",
      ).toBe(0);
    } finally {
      sql(`update public.user_organizations set revoked_at = null
            where user_id = '${ATENDENTE_B}' and organization_id = '${ORG_A}';`);
    }
    expect(contaComoMembro(ATENDENTE_B, CONVERSAS_QUE_VEJO)).toBe(1);
  });

  it("membro REBAIXADO a viewer não lê a própria participação", () => {
    // `fn_role_at_least(…, 'agent')` na policy de participantes: `viewer` não
    // carrega vínculo de atendimento, mesmo que a linha continue ativa.
    sql(`update public.user_organizations set role = 'viewer'
          where user_id = '${ATENDENTE_B}' and organization_id = '${ORG_A}';`);
    try {
      expect(
        contaComoMembro(ATENDENTE_B, MINHA_PARTICIPACAO),
        "o viewer lê o vínculo de participação",
      ).toBe(0);
    } finally {
      sql(`update public.user_organizations set role = 'agent'
            where user_id = '${ATENDENTE_B}' and organization_id = '${ORG_A}';`);
    }
    expect(contaComoMembro(ATENDENTE_B, MINHA_PARTICIPACAO)).toBe(1);
  });

  it("CONVIDAR não muda o DONO da conversa (entrar não é assumir)", () => {
    // A linha de `conversations.assigned_to_user_id` continua sendo A depois de
    // o colega entrar. É a invariante que separa esta feature da transferência.
    const dono = sql(
      `select assigned_to_user_id from public.conversations where id = '${CONVERSA_A}';`,
    )
      .trim()
      .split("\n")
      .at(-1);
    expect(dono, "o dono da conversa mudou ao convidar").toBe(ATENDENTE_A);
  });

  it("o CONVIDADO lê a PRÓPRIA linha de participação", () => {
    expect(contaComoMembro(ATENDENTE_B, MINHA_PARTICIPACAO)).toBe(1);
  });

  it("o DONO não lê a linha de participação alheia pela RLS (a tela usa o servidor)", () => {
    // A policy de `conversation_participants` NÃO cita `conversations` (senão
    // haveria recursão de policy): cada um vê a PRÓPRIA linha. Quem lista os
    // participantes de uma conversa é a rota, pelo service role, com papel e
    // organização revalidados. Este caso documenta o desenho — trocá-lo seria
    // uma edição VISÍVEL.
    expect(contaComoMembro(ATENDENTE_A, MINHA_PARTICIPACAO)).toBe(0);
  });

  it("a organização VIZINHA não vê a conversa nem a participação", () => {
    // Eixo TENANT nas duas tabelas. `CONVERSAS_QUE_VEJO` filtra ORG_A: o membro
    // da org B não tem membership em A, então `fn_can_view_conversation` é
    // false e o `or exists` não acha linha dele.
    expect(contaComoMembro(ATENDENTE_B_ORG, CONVERSAS_QUE_VEJO)).toBe(0);
    expect(
      contaComoMembro(ATENDENTE_B_ORG, MINHA_PARTICIPACAO),
      "um membro de outra organização leu o vínculo de participação",
    ).toBe(0);
  });

  it("nenhum membro INSERE na tabela de participantes — quem escreve é o servidor", () => {
    // O `revoke all … from authenticated`. Sem ele, qualquer membro forjaria um
    // vínculo pelo PostgREST — e um vínculo inventado diz que alguém foi
    // convidado para uma conversa que o dono nunca dividiu.
    for (const quem of [ATENDENTE_A, ATENDENTE_B, GESTOR]) {
      let erro: string | null = null;
      try {
        sql(`${comoMembro(quem)}
          insert into public.conversation_participants
            (organization_id, conversation_id, user_id, invited_by)
          values ('${ORG_A}', '${CONVERSA_A}', '${quem}', '${ATENDENTE_A}');`);
      } catch (err) {
        erro = motivoDoErro(err);
      }
      expect(erro, `${quem} inseriu na tabela SEM erro — a escrita está exposta`).not.toBeNull();
      expect(erro).toContain("permission denied");
    }
  });
});
