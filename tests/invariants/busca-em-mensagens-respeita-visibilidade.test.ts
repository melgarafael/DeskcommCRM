import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONTACT_1,
  GOV_CONTACT_2,
  GOV_CONV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  countAs,
  indexExists,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * A BUSCA NO TEXTO DAS MENSAGENS RESPEITA A VISIBILIDADE DA CONVERSA (#1355).
 *
 * ─── Por que contra o banco, e não só contra a rota ─────────────────────────
 * O teste de unidade prova a FORMA do filtro que o handler monta. Ele não prova
 * o que interessa a quem atende: que buscar um termo não devolva conversa que a
 * pessoa não pode abrir. Essa conclusão é sobre a RLS, e RLS se mede no Postgres.
 *
 * ─── A régua NÃO é uma cópia ────────────────────────────────────────────────
 * `messages_select` (migration 0035) é
 * `exists (select 1 from public.conversations c where c.id = messages.conversation_id)`
 * — a policy delega para a de `conversations`, que é
 * `fn_can_view_conversation(organization_id, assigned_to_user_id)`. É a MESMA
 * função que decide o que a lista do Inbox mostra. Ou seja: a busca no corpo
 * herda a régua em vez de reescrevê-la — e é isso que os pares abaixo medem,
 * com um atendente que NÃO é o dono da conversa (o discriminador).
 *
 * ─── O índice ───────────────────────────────────────────────────────────────
 * Sem ele a busca é seq scan (77 ms por 200.000 mensagens, medido no PR). Aqui
 * se prova que ele existe no schema que o `pnpm test:db` instala — o que o gate
 * do baseline cobra — e que é GIN de trigrama sobre `body`, e não outro índice
 * com nome parecido.
 */

const TERMO = "xilofone-lunar-1355";

const MENSAGEM_DO_B = "e5e5e5e5-1355-4000-8000-000000000001";
const MENSAGEM_LIVRE = "e5e5e5e5-1355-4000-8000-000000000002";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
    values
      ('${MENSAGEM_DO_B}', '${GOV_ORG}', '${GOV_CONV_AGENT_B}', '${GOV_SESSION}', '${GOV_CONTACT_2}', 'text', 'inbound', 'so falo disso com o dono: ${TERMO}'),
      ('${MENSAGEM_LIVRE}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'text', 'inbound', 'a fila tambem fala de ${TERMO}')
    on conflict (id) do nothing;
  `);
});

/** A consulta que a busca do Inbox faz no corpo — o mesmo predicado, sem PostgREST. */
const busca = `select count(*) from public.messages where body ilike '%${TERMO}%';`;

describe("busca no texto das mensagens respeita a visibilidade da conversa", () => {
  it("o atendente NÃO acha o termo da conversa de outro atendente (own_and_unassigned)", () => {
    // GOV_AGENT_A é agent da MESMA organização e do MESMO papel: só não vê a
    // conversa porque ela é do GOV_AGENT_B. É o par que discrimina.
    expect(countAs(GOV_AGENT_A, busca)).toBe(1);
  });

  it("o dono da conversa acha a própria mensagem — controle positivo", () => {
    expect(countAs(GOV_AGENT_B, busca)).toBe(2);
  });

  it("quem lê org-wide (manager) acha as duas — controle do outro lado", () => {
    expect(countAs(GOV_MANAGER, busca)).toBe(2);
  });

  it("a mensagem da conversa alheia continua existindo no banco (o teste não mede zero por engano)", () => {
    const total = sql(
      `select count(*) from public.messages where id = '${MENSAGEM_DO_B}' and body ilike '%${TERMO}%';`,
    );
    expect(total).toBe("1");
  });

  it("o índice de trigrama em messages.body existe e é GIN de gin_trgm_ops", () => {
    expect(indexExists("idx_messages_body_trgm")).toBe(true);
    const definicao = sql(
      `select pg_get_indexdef('public.idx_messages_body_trgm'::regclass);`,
    );
    expect(definicao).toContain("USING gin");
    expect(definicao).toContain("gin_trgm_ops");
    expect(definicao).toContain("body");
  });
});