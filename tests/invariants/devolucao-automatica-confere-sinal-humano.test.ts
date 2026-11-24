import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * A DEVOLUÇÃO AUTOMÁTICA SOLTA O DONO SÓ SE A CONVERSA AINDA ESTIVER PARADA
 * (migration 9472, `fn_conversation_release_if_idle`).
 *
 * O cron `handoff-devolucao` decide sobre a leitura da varredura e escreve
 * depois. A função confere, sob o lock da linha e na mesma transação do
 * release, o dono lido e que nenhum sinal humano é posterior ao corte. Aqui ela
 * roda no Postgres do harness, com o `fn_conversation_assign` de verdade.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *   - tirar a linha de `last_outbound_at` do `where` da função: o caso
 *     "respondeu depois do corte" solta o dono e fica vermelho.
 *   - tirar a de `assigned_at`: fica vermelho "assumiu de novo depois do corte".
 *   - tirar a de `last_handoff_at`: fica vermelho "nova passagem depois do corte".
 */

const CONTATO = "cccccccc-3333-4000-8000-000000009472";
const CONVERSA = "cccccccc-4444-4000-8000-000000009472";
const CORTE = "now() - interval '1 hour'";

const HA_3_HORAS = "now() - interval '3 hours'";

/**
 * A conversa com dono A e a última saída quando o caso mandar. Atribuição e
 * passagem ficam há 3 h, a menos que o caso mova uma delas para depois do corte.
 */
function conversaComDono(
  ultimaSaida: string,
  { assumidaEm = HA_3_HORAS, passagemEm = HA_3_HORAS }: { assumidaEm?: string; passagemEm?: string } = {},
): void {
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${GOV_ORG}', 'Invariante 9472')
      on conflict do nothing;
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status,
       assigned_to_user_id, assignee_kind, assigned_at, last_handoff_at, last_outbound_at,
       bot_silenced_until)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'claimed',
              '${GOV_AGENT_A}', 'user', ${assumidaEm}, ${passagemEm},
              ${ultimaSaida}, 'infinity')
      on conflict (id) do update set
        status = excluded.status,
        assigned_to_user_id = excluded.assigned_to_user_id,
        assignee_kind = excluded.assignee_kind,
        assigned_at = excluded.assigned_at,
        last_handoff_at = excluded.last_handoff_at,
        last_outbound_at = excluded.last_outbound_at,
        bot_silenced_until = excluded.bot_silenced_until;
  `);
}

function soltar(esperado: string): string {
  return lastLine(
    sql(`select public.fn_conversation_release_if_idle(
           '${GOV_ORG}', '${CONVERSA}', '${esperado}', ${CORTE});`),
  );
}

const donoAtual = (): string =>
  lastLine(sql(`select coalesce(assigned_to_user_id::text, 'nenhum') from public.conversations where id = '${CONVERSA}';`));

beforeAll(() => {
  seedGov();
});

describe("fn_conversation_release_if_idle", () => {
  it("parada desde antes do corte, mesmo dono: solta", () => {
    conversaComDono("now() - interval '2 hours'");
    expect(soltar(GOV_AGENT_A)).toBe("t");
    expect(donoAtual()).toBe("nenhum");
  });

  it("o atendente respondeu depois do corte: não solta, o dono fica", () => {
    conversaComDono("now() - interval '1 minute'");
    expect(soltar(GOV_AGENT_A)).toBe("f");
    expect(donoAtual()).toBe(GOV_AGENT_A);
  });

  it("assumiu de novo depois do corte: não solta, o dono fica", () => {
    conversaComDono("now() - interval '2 hours'", { assumidaEm: "now() - interval '1 minute'" });
    expect(soltar(GOV_AGENT_A)).toBe("f");
    expect(donoAtual()).toBe(GOV_AGENT_A);
  });

  it("nova passagem depois do corte: não solta, o dono fica", () => {
    conversaComDono("now() - interval '2 hours'", { passagemEm: "now() - interval '1 minute'" });
    expect(soltar(GOV_AGENT_A)).toBe("f");
    expect(donoAtual()).toBe(GOV_AGENT_A);
  });

  it("outro atendente é o dono agora: não solta", () => {
    conversaComDono("now() - interval '2 hours'");
    expect(soltar(GOV_AGENT_B)).toBe("f");
    expect(donoAtual()).toBe(GOV_AGENT_A);
  });

  it("só o service_role executa", () => {
    const sig = "public.fn_conversation_release_if_idle(uuid, uuid, uuid, timestamptz)";
    expect(
      lastLine(
        sql(`select has_function_privilege('anon', '${sig}', 'execute')::text || ','
                 || has_function_privilege('authenticated', '${sig}', 'execute')::text || ','
                 || has_function_privilege('service_role', '${sig}', 'execute')::text;`),
      ),
    ).toBe("false,false,true");
  });
});
