import { describe, expect, it } from "vitest";

import { composerBloqueadoAteAssumir } from "@/lib/inbox/bloqueio-ate-assumir";

describe("o convite libera a resposta sem tomar o atendimento (#2542)", () => {
  const entrada = { ligada: true, donoDaConversa: "dona", atendenteId: "colega" };

  it("participação ativa permite responder com o bloqueio até assumir ligado", () => {
    expect(composerBloqueadoAteAssumir({ ...entrada, participanteAtivo: true })).toBe(false);
  });

  it("sem convite ou depois da remoção, a conversa de outra pessoa segue travada", () => {
    expect(composerBloqueadoAteAssumir({ ...entrada, participanteAtivo: false })).toBe(true);
    expect(composerBloqueadoAteAssumir(entrada)).toBe(true);
  });
});
