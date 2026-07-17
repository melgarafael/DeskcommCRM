import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_CLAIM,
  seedGov,
  tableExists,
  writeCountAs,
} from "./gov-helpers";

/**
 * Eixo 3 — Transferência (spec 13 §1; fase que fecha: G3).
 * docs/specs/13-spec-governanca-atendimento.md — dor: "assumir/transferir com
 * erro, sem auditoria". Claim atômico já especificado na spec 04 §9; auditoria
 * de mudança de dono é a tabela conversation_assignment_events (spec 13 §3).
 */

beforeAll(() => {
  seedGov();
});

describe("eixo 3 — transferência", () => {
  it("claim atômico: UPDATE condicional atribui 1x; segundo claim concorrente perde (0 rows)", () => {
    // Spec 04 §9: claim = UPDATE ... where assigned_to_user_id is null (o
    // perdedor recebe 0 rows e a rota devolve 409).
    const first = writeCountAs(
      GOV_AGENT_A,
      `update public.conversations
         set assigned_to_user_id = '${GOV_AGENT_A}', assigned_at = now(), status = 'claimed'
         where id = '${GOV_CONV_CLAIM}' and assigned_to_user_id is null`,
    );
    expect(first).toBe(1);

    const second = writeCountAs(
      GOV_AGENT_B,
      `update public.conversations
         set assigned_to_user_id = '${GOV_AGENT_B}', assigned_at = now(), status = 'claimed'
         where id = '${GOV_CONV_CLAIM}' and assigned_to_user_id is null`,
    );
    expect(second).toBe(0);
  });

  // GAP(G3): transferência não gera evento de auditoria — a tabela
  // conversation_assignment_events (spec 13 §3: org_id, conversation_id,
  // from/to, changed_by, reason claim|transfer|release|routing|handoff)
  // ainda não existe.
  it.fails("transferência é auditada: tabela conversation_assignment_events existe (spec 13 §3)", () => {
    expect(tableExists("conversation_assignment_events")).toBe(true);
  });
});
