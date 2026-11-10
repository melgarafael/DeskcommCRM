/**
 * O convite amplia LEITURA e resposta, sem ampliar o controle da conversa (#2542).
 *
 * Namespace exclusivo 2542abcd: nenhum caso depende dos fixtures compartilhados.
 * Cada sonda abre uma transação e desfaz tanto a preparação quanto a escrita
 * medida. O controle positivo do dono/gestor distingue recusa do convidado de
 * uma policy que simplesmente impede toda escrita.
 *
 * INSERT em messages abaixo prova persistência sob JWT, NÃO envio ao canal.
 * Viewer continua com a leitura org-wide já distribuída e não escreve vínculos
 * de participação. Seu POST HTTP /messages depende de prova da borda: a policy
 * INSERT de messages preexistente não exige agent, e este recorte não a altera.
 * Convite/remoção/reentrada são preparados como postgres porque a tabela é
 * server-only; a autorização e a auditoria das rotas exigem prova própria.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "2542abcd-0000-4000-8000-000000000001";
const ORG_B = "2542abcd-0000-4000-8000-000000000002";
const DONO = "2542abcd-1111-4000-8000-000000000001";
const CONVIDADA = "2542abcd-1111-4000-8000-000000000002";
const VIEWER = "2542abcd-1111-4000-8000-000000000003";
const VIZINHO = "2542abcd-1111-4000-8000-000000000004";
const SEM_CONVITE = "2542abcd-1111-4000-8000-000000000005";
const GESTOR = "2542abcd-1111-4000-8000-000000000006";
const SESSAO_A = "2542abcd-2222-4000-8000-000000000001";
const SESSAO_B = "2542abcd-2222-4000-8000-000000000002";
const CONTATO_A = "2542abcd-3333-4000-8000-000000000001";
const CONTATO_B = "2542abcd-3333-4000-8000-000000000002";
const CONVERSA_A = "2542abcd-4444-4000-8000-000000000001";
const CONVERSA_B = "2542abcd-4444-4000-8000-000000000002";
const MENSAGEM_A = "2542abcd-5555-4000-8000-000000000001";
const RESPOSTA = "2542abcd-5555-4000-8000-000000000002";

const CONVERSA = `select count(*) from public.conversations
  where organization_id = '${ORG_A}' and id = '${CONVERSA_A}'`;
const MENSAGEM = `select count(*) from public.messages
  where organization_id = '${ORG_A}' and id = '${MENSAGEM_A}'`;
const PARTICIPACAO = `select count(*) from public.conversation_participants
  where organization_id = '${ORG_A}' and conversation_id = '${CONVERSA_A}'
    and user_id = '${CONVIDADA}'`;

function como(quem: string): string {
  return `set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${quem}"}', true);`;
}

/** Marcador explícito: tags SET/ROLLBACK do psql nunca viram um zero aparente. */
function numero(saida: string): number {
  const linhas = saida.split("\n").filter((linha) => linha.startsWith("SONDA="));
  if (linhas.length !== 1 || !/^SONDA=\d+$/.test(linhas[0] ?? "")) {
    throw new Error(`sonda sem resultado numérico único: ${saida}`);
  }
  return Number(linhas[0]!.slice("SONDA=".length));
}

function contarComo(quem: string, consulta: string, preparar = ""): number {
  return numero(sql(`begin;
    ${preparar}
    ${como(quem)}
    select 'SONDA=' || (${consulta})::text;
    rollback;`));
}

/** Tanto zero linhas quanto uma recusa explícita de RLS são negação válida. */
function afetarComo(quem: string, comando: string, preparar = ""): number {
  try {
    return numero(sql(`begin;
      ${preparar}
      ${como(quem)}
      with afetadas as (${comando} returning id)
      select 'SONDA=' || count(*)::text from afetadas;
      rollback;`));
  } catch (err) {
    const motivo = motivoDoErro(err);
    // FK, CHECK, sintaxe ou seed quebrada NÃO contam como autorização negada.
    if (!/permission denied|row-level security/i.test(motivo)) throw err;
    return 0;
  }
}

const REABRIR_PARTICIPACAO = `insert into public.conversation_participants
  (organization_id, conversation_id, user_id, invited_by, joined_at, left_at)
  values ('${ORG_A}', '${CONVERSA_A}', '${CONVIDADA}', '${DONO}', now(), null)
  on conflict (conversation_id, user_id) do update set left_at = null`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${DONO}', 'controle-conjunto-dono@invariant.test'),
      ('${CONVIDADA}', 'controle-conjunto-convidada@invariant.test'),
      ('${VIEWER}', 'controle-conjunto-viewer@invariant.test'),
      ('${VIZINHO}', 'controle-conjunto-vizinho@invariant.test'),
      ('${SEM_CONVITE}', 'controle-conjunto-sem-convite@invariant.test'),
      ('${GESTOR}', 'controle-conjunto-gestor@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG_A}', 'controle-conjunto-a', 'Controle Conjunto A', 'Conjunto A',
              '{"visibility_mode":"own"}'::jsonb),
             ('${ORG_B}', 'controle-conjunto-b', 'Controle Conjunto B', 'Conjunto B',
              '{"visibility_mode":"own"}'::jsonb)
      on conflict (id) do update set settings = excluded.settings;

    insert into public.user_organizations
      (user_id, organization_id, role, accepted_at, revoked_at) values
      ('${DONO}', '${ORG_A}', 'agent', now(), null),
      ('${CONVIDADA}', '${ORG_A}', 'agent', now(), null),
      ('${VIEWER}', '${ORG_A}', 'viewer', now(), null),
      ('${SEM_CONVITE}', '${ORG_A}', 'agent', now(), null),
      ('${GESTOR}', '${ORG_A}', 'manager', now(), null),
      ('${VIZINHO}', '${ORG_B}', 'agent', now(), null)
      on conflict (user_id, organization_id) do update
        set role = excluded.role, accepted_at = excluded.accepted_at, revoked_at = null;

    -- Arbiter explícito: a outra unique de channel_sessions é DEFERRABLE.
    insert into public.channel_sessions
      (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESSAO_A}', '${ORG_A}', 'controle-conjunto-a', '\\x00'::bytea),
      ('${SESSAO_B}', '${ORG_B}', 'controle-conjunto-b', '\\x00'::bytea)
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Contato Sintético A'),
      ('${CONTATO_B}', '${ORG_B}', 'Contato Sintético B')
      on conflict (id) do nothing;

    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status,
       assigned_to_user_id, assignee_kind) values
      ('${CONVERSA_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}', 'open', '${DONO}', 'user'),
      ('${CONVERSA_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}', 'open', '${VIZINHO}', 'user')
      on conflict (id) do update
        set status = 'open', assigned_to_user_id = excluded.assigned_to_user_id,
            assignee_kind = 'user';

    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, body) values
      ('${MENSAGEM_A}', '${ORG_A}', '${CONVERSA_A}', '${SESSAO_A}', '${CONTATO_A}',
       'text', 'inbound', 'Mensagem sintética de controle')
      on conflict (id) do nothing;

    ${REABRIR_PARTICIPACAO};
  `);
});

describe("participação não herda o controle da conversa", () => {
  it("CONTROLE: conversa, mensagem e vínculo existem, e o dono lê a conversa", () => {
    expect(numero(sql(`select 'SONDA=' || (${CONVERSA})::text;`))).toBe(1);
    expect(numero(sql(`select 'SONDA=' || (${MENSAGEM})::text;`))).toBe(1);
    expect(numero(sql(`select 'SONDA=' || (${PARTICIPACAO})::text;`))).toBe(1);
    expect(contarComo(DONO, CONVERSA)).toBe(1);
  });

  it("antes do convite, a atendente não lê a conversa nem a mensagem", () => {
    const semVinculo = `delete from public.conversation_participants
      where organization_id = '${ORG_A}' and conversation_id = '${CONVERSA_A}'
        and user_id = '${CONVIDADA}';`;
    expect(contarComo(CONVIDADA, CONVERSA, semVinculo)).toBe(0);
    expect(contarComo(CONVIDADA, MENSAGEM, semVinculo)).toBe(0);
  });

  it("o convite ativo libera a conversa e a mensagem, mas não o colega sem convite", () => {
    expect(contarComo(CONVIDADA, CONVERSA)).toBe(1);
    expect(contarComo(CONVIDADA, MENSAGEM)).toBe(1);
    expect(contarComo(SEM_CONVITE, CONVERSA)).toBe(0);
    expect(contarComo(SEM_CONVITE, MENSAGEM)).toBe(0);
  });

  it("a convidada pode persistir uma resposta sob seu JWT, sem enviar ao canal", () => {
    expect(afetarComo(CONVIDADA, `insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_by_user_id)
      values ('${RESPOSTA}', '${ORG_A}', '${CONVERSA_A}', '${SESSAO_A}', '${CONTATO_A}',
              'text', 'outbound', 'queued', 'Resposta sintética', 'user', '${CONVIDADA}')`))
      .toBe(1);
  });

  it("a convidada não edita o corpo de uma mensagem alheia", () => {
    const editar = `update public.messages set body = 'Texto alterado pela convidada'
      where organization_id = '${ORG_A}' and id = '${MENSAGEM_A}'`;
    expect(afetarComo(CONVIDADA, editar)).toBe(0);
    // Também a fala de OUTRO atendente: barrar só inbound não prova autoria.
    const falaDoDono = `update public.messages set direction = 'outbound',
      sent_via = 'user', sent_by_user_id = '${DONO}'
      where organization_id = '${ORG_A}' and id = '${MENSAGEM_A}';`;
    expect(afetarComo(CONVIDADA, editar, falaDoDono)).toBe(0);
  });

  it("a convidada não apaga a mensagem alheia que passou a ler", () => {
    expect(afetarComo(CONVIDADA, `delete from public.messages
      where organization_id = '${ORG_A}' and id = '${MENSAGEM_A}'`)).toBe(0);
    expect(contarComo(CONVIDADA, MENSAGEM)).toBe(1);
  });

  it("a convidada edita a própria resposta, mas não ganha hard delete", () => {
    // Preparação server-side de uma mensagem já persistida. A escrita medida
    // acontece depois de assumir o JWT da autora, em transação própria, e não
    // chama a API nem o canal. A persistência pelo JWT tem caso próprio acima.
    const respostaPersistida = `insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_by_user_id)
      values ('${RESPOSTA}', '${ORG_A}', '${CONVERSA_A}', '${SESSAO_A}', '${CONTATO_A}',
              'text', 'outbound', 'queued', 'Resposta sintética', 'user', '${CONVIDADA}');`;
    expect(afetarComo(CONVIDADA, `update public.messages set body = 'Minha resposta revisada'
      where organization_id = '${ORG_A}' and id = '${RESPOSTA}'`, respostaPersistida)).toBe(1);
    expect(afetarComo(CONVIDADA, `delete from public.messages
      where organization_id = '${ORG_A}' and id = '${RESPOSTA}'`, respostaPersistida)).toBe(0);
  });

  it("marcar o contato como pessoal retira só o acesso concedido pelo convite", () => {
    const marcarPessoal = `update public.contacts set is_personal = true
      where organization_id = '${ORG_A}' and id = '${CONTATO_A}';`;
    expect(contarComo(CONVIDADA, CONVERSA, marcarPessoal)).toBe(0);
    expect(contarComo(CONVIDADA, MENSAGEM, marcarPessoal)).toBe(0);
    // A visão raw RLS anterior do dono é preservada: a API é quem a oculta.
    expect(contarComo(DONO, CONVERSA, marcarPessoal)).toBe(1);
  });

  it("a convidada não troca o dono por UPDATE direto", () => {
    expect(afetarComo(CONVIDADA, `update public.conversations
      set assigned_to_user_id = '${CONVIDADA}'
      where organization_id = '${ORG_A}' and id = '${CONVERSA_A}'`)).toBe(0);
  });

  it("a convidada não fecha a conversa por UPDATE direto", () => {
    expect(afetarComo(CONVIDADA, `update public.conversations set status = 'closed'
      where organization_id = '${ORG_A}' and id = '${CONVERSA_A}'`)).toBe(0);
  });

  it("a convidada não apaga a conversa por DELETE direto", () => {
    expect(afetarComo(CONVIDADA, `delete from public.conversations
      where organization_id = '${ORG_A}' and id = '${CONVERSA_A}'`)).toBe(0);
    expect(contarComo(CONVIDADA, CONVERSA)).toBe(1);
  });

  it("CONTROLE: o dono e o gestor preservam a escrita que já tinham", () => {
    for (const quem of [DONO, GESTOR]) {
      expect(afetarComo(quem, `update public.conversations set status = 'closed'
        where organization_id = '${ORG_A}' and id = '${CONVERSA_A}'`)).toBe(1);
    }
  });

  it("viewer preserva a leitura usual, mas não escreve a tabela server-only", () => {
    expect(contarComo(VIEWER, CONVERSA)).toBe(1);
    expect(contarComo(VIEWER, MENSAGEM)).toBe(1);
    expect(contarComo(VIEWER, PARTICIPACAO)).toBe(0);
    expect(afetarComo(VIEWER, `insert into public.conversation_participants
      (organization_id, conversation_id, user_id, invited_by)
      values ('${ORG_A}', '${CONVERSA_A}', '${VIEWER}', '${DONO}')`)).toBe(0);
  });

  it("a revogação do membro retira leitura mesmo com participação ativa", () => {
    const revogar = `update public.user_organizations set revoked_at = now()
      where organization_id = '${ORG_A}' and user_id = '${CONVIDADA}';`;
    expect(contarComo(CONVIDADA, CONVERSA, revogar)).toBe(0);
    expect(contarComo(CONVIDADA, MENSAGEM, revogar)).toBe(0);
    expect(contarComo(CONVIDADA, PARTICIPACAO, revogar)).toBe(0);
    expect(contarComo(CONVIDADA, CONVERSA)).toBe(1);
  });

  it("sair retira acesso; reentrar duas vezes restaura sem duplicar o vínculo", () => {
    const sair = `update public.conversation_participants set left_at = now()
      where organization_id = '${ORG_A}' and conversation_id = '${CONVERSA_A}'
        and user_id = '${CONVIDADA}';`;
    expect(contarComo(CONVIDADA, CONVERSA, sair)).toBe(0);
    expect(contarComo(CONVIDADA, MENSAGEM, sair)).toBe(0);
    const reentrar = `${sair}\n${REABRIR_PARTICIPACAO};\n${REABRIR_PARTICIPACAO};`;
    expect(contarComo(CONVIDADA, CONVERSA, reentrar)).toBe(1);
    expect(contarComo(CONVIDADA, PARTICIPACAO, reentrar)).toBe(1);
  });

  it("um vínculo forjado pelo servidor não atravessa organizações, nos dois sentidos", () => {
    const vinculoDeFora = `insert into public.conversation_participants
      (organization_id, conversation_id, user_id, invited_by)
      values ('${ORG_A}', '${CONVERSA_A}', '${VIZINHO}', '${DONO}');`;
    expect(contarComo(VIZINHO, CONVERSA, vinculoDeFora)).toBe(0);
    expect(contarComo(VIZINHO, MENSAGEM, vinculoDeFora)).toBe(0);
    const vinculoNaVizinha = `insert into public.conversation_participants
      (organization_id, conversation_id, user_id, invited_by)
      values ('${ORG_B}', '${CONVERSA_B}', '${CONVIDADA}', '${VIZINHO}');`;
    expect(contarComo(CONVIDADA, `select count(*) from public.conversations
      where organization_id = '${ORG_B}' and id = '${CONVERSA_B}'`, vinculoNaVizinha))
      .toBe(0);
    expect(contarComo(CONVIDADA, `select count(*) from public.conversation_participants
      where organization_id = '${ORG_B}' and conversation_id = '${CONVERSA_B}'`, vinculoNaVizinha))
      .toBe(0);
  });
});
