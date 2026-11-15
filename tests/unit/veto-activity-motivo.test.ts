import { describe, expect, it } from "vitest";

import { vetoReason } from "@/lib/leads/veto-activity";

describe("vetoReason — a frase da linha 'Não enviei'", () => {
  it("trava comercial com trecho cita o trecho", () => {
    expect(vetoReason("commercial_restriction", "commercial_requires_human", "sem custo")).toBe(
      'Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe (o texto tinha "sem custo")',
    );
  });

  it("trava comercial sem trecho não inventa parênteses", () => {
    expect(vetoReason("commercial_restriction", "commercial_requires_human", null)).toBe(
      "Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe",
    );
    expect(vetoReason("commercial_restriction", "commercial_requires_human")).toBe(
      "Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe",
    );
  });

  it("conversa com a equipe não é pedido para parar", () => {
    expect(vetoReason("stop", "atendimento_com_humano")).toBe("Não enviei: a conversa está com a equipe");
  });

  it("os outros motivos seguem como eram", () => {
    expect(vetoReason("stop", "opted_out")).toBe("Não enviei: o contato pediu para parar de receber mensagens");
    expect(vetoReason("gate_novo", "cod_x")).toBe('Não enviei: bloqueado pela regra "gate_novo" (cod_x)');
  });
});
