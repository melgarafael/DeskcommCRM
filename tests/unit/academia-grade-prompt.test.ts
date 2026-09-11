import { describe, expect, it } from "vitest";

import { ACADEMIA_GRADE_SYSTEM_BLOCK } from "@/lib/agent-engine/agent/academia-grade-prompt";

describe("instrução residente da grade da academia", () => {
  it("obriga resposta direta e completa sem perguntas comerciais não solicitadas", () => {
    expect(ACADEMIA_GRADE_SYSTEM_BLOCK).toContain("resumo_para_resposta");
    expect(ACADEMIA_GRADE_SYSTEM_BLOCK).toMatch(
      /dia, in[ií]cio, fim, dura[cç][aã]o, p[uú]blico, professor e ambiente/i,
    );
    expect(ACADEMIA_GRADE_SYSTEM_BLOCK).toMatch(
      /n[aã]o pergunte sobre idade, vaga, reserva ou aula experimental/i,
    );
  });
});
