import { describe, expect, it } from "vitest";

import { resumirBase } from "@/components/ai/StatusDaBase";

/**
 * O cartão "Estado da base de conhecimento" (recorte do #1130, de @vgamkt) conta
 * a partir da lista de materiais que a tela do acervo já tem — sem rota própria.
 * Arquivado não conta: não é consultado por assistente nenhum.
 */
describe("resumirBase", () => {
  it("conta prontos, preparando e com erro — e ignora arquivados", () => {
    expect(
      resumirBase([
        { status: "ready", last_index_status: "success" },
        { status: "ready", last_index_status: "indexando" },
        { status: "ready", last_index_status: "failed" },
        { status: "ready", last_index_status: "partial" },
        { status: "ready", last_index_status: null },
        { status: "archived", last_index_status: "failed" },
      ]),
    ).toEqual({ total: 5, prontos: 1, preparando: 1, comErro: 2 });
  });
});
