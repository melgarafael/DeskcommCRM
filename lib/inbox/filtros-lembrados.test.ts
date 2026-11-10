import { describe, expect, it } from "vitest";
import { CHAVE_DOS_FILTROS, gravarFiltrosLembrados, lerFiltrosLembrados } from "./filtros-lembrados";

function armazenamento(inicial: Record<string, string> = {}) {
  const dados = { ...inicial };
  return {
    dados,
    getItem: (k: string): string | null => dados[k] ?? null,
    setItem: (k: string, v: string) => {
      dados[k] = v;
    },
  };
}

describe("filtros lembrados do Inbox", () => {
  it("grava e lê número e não lidos por organização, sem misturar", () => {
    const s = armazenamento();
    gravarFiltrosLembrados(s, "org-a", { channel_session_id: "num-a", onlyUnread: true });
    gravarFiltrosLembrados(s, "org-b", { channel_session_id: "num-b" });
    expect(lerFiltrosLembrados(s, "org-a")).toEqual({ channel_session_id: "num-a", onlyUnread: true });
    expect(lerFiltrosLembrados(s, "org-b")).toEqual({ channel_session_id: "num-b" });
    expect(lerFiltrosLembrados(s, "org-c")).toEqual({});
  });

  it("desligar os filtros apaga o que estava lembrado", () => {
    const s = armazenamento();
    gravarFiltrosLembrados(s, "org-a", { channel_session_id: "num", onlyUnread: true });
    gravarFiltrosLembrados(s, "org-a", {});
    expect(lerFiltrosLembrados(s, "org-a")).toEqual({});
  });

  it("lixo no armazenamento ou armazenamento bloqueado não quebram a tela", () => {
    expect(lerFiltrosLembrados(armazenamento({ [CHAVE_DOS_FILTROS]: "{quebrado" }), "org-a")).toEqual({});
    expect(lerFiltrosLembrados(armazenamento({ [CHAVE_DOS_FILTROS]: '{"org-a":{"onlyUnread":"sim"}}' }), "org-a")).toEqual({});
    expect(lerFiltrosLembrados(null, "org-a")).toEqual({});
    const cheio = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(() => gravarFiltrosLembrados(cheio, "org-a", { onlyUnread: true })).not.toThrow();
  });
});
