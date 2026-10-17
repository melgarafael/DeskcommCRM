import { describe, expect, it } from "vitest";

import { caseEventLabel } from "./case-copy";

describe("caseEventLabel — quem respondeu", () => {
  it("resposta pelo WhatsApp de avisos não é atribuída a quem olha a tela", () => {
    for (const human_action of ["resolved", "need_lead_info"] as const) {
      expect(
        caseEventLabel({ kind: "human_replied", actor_kind: "human", human_action, source: "whatsapp" }),
      ).toBe("A equipe respondeu pelo WhatsApp");
    }
  });

  it("resposta pela tela continua na segunda pessoa", () => {
    expect(
      caseEventLabel({ kind: "human_replied", actor_kind: "human", human_action: "resolved", source: null }),
    ).toBe("Você concluiu o caso");
    expect(caseEventLabel({ kind: "human_replied", actor_kind: "human", human_action: "resolved" })).toBe(
      "Você concluiu o caso",
    );
  });
});
