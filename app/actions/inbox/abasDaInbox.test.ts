/**
 * AS ABAS DE CADA PESSOA: gravar e ler sem vazar para o colega (#3313, item 2).
 *
 * O mesmo desenho do teste da lateral (`modulosDaLateral.test.ts`, #3008): o
 * dublê do `auth` guarda um metadata por usuário, para que "A não afeta B" seja
 * medido, e não afirmado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ABAS_DA_INBOX, CHAVE_DAS_ABAS, abasPadrao } from "@/lib/inbox/abas-da-inbox";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  supportWriteError: vi.fn(),
  updateUser: vi.fn(),
  revalidatePath: vi.fn(),
  metadata: new Map<string, Record<string, unknown>>(),
  sessao: "11111111-1111-4111-8111-111111111111",
  erroDeUpdate: null as null | { message: string },
  erroDeGet: null as null | { message: string },
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: h.loadAuthUser }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: h.supportWriteError }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      updateUser: async ({ data }: { data: Record<string, unknown> }) => {
        h.updateUser(data);
        if (h.erroDeUpdate) return { data: null, error: h.erroDeUpdate };
        const atual = h.metadata.get(h.sessao) ?? {};
        h.metadata.set(h.sessao, { ...atual, ...data });
        return { data: { user: { id: h.sessao } }, error: null };
      },
      getUser: async () => {
        if (h.erroDeGet) return { data: { user: null }, error: h.erroDeGet };
        return {
          data: { user: { id: h.sessao, user_metadata: h.metadata.get(h.sessao) ?? {} } },
          error: null,
        };
      },
    },
  }),
}));

import { carregarAbasDaInbox, salvarAbasDaInbox } from "./abasDaInbox";

const metadataDe = (id: string) => h.metadata.get(id);

beforeEach(() => {
  vi.clearAllMocks();
  h.metadata.clear();
  h.sessao = A;
  h.erroDeUpdate = null;
  h.erroDeGet = null;
  h.supportWriteError.mockReturnValue(null);
  h.loadAuthUser.mockImplementation(async () => ({ id: h.sessao, support: null }));
});

describe("#3313 — gravar as abas é escrever no metadata de QUEM está logado", () => {
  it("grava a lista NORMALIZADA (completa) e devolve o que foi gravado", async () => {
    const resposta = await salvarAbasDaInbox([{ id: "unassigned", visivel: true }, { id: "all", visivel: false }]);

    expect(resposta.ok).toBe(true);
    if (!resposta.ok) return;
    expect(resposta.abas).toHaveLength(ABAS_DA_INBOX.length);
    expect(resposta.abas.slice(0, 2)).toEqual([
      { id: "unassigned", visivel: true },
      { id: "all", visivel: false },
    ]);

    const gravado = metadataDe(A)?.[CHAVE_DAS_ABAS] as Array<{ id: string; visivel: boolean }>;
    expect(gravado).toEqual(resposta.abas);
    expect(h.revalidatePath).toHaveBeenCalledWith("/app/inbox");
  });

  it("nunca grava uma faixa vazia: todas ocultas viram todas visíveis", async () => {
    const resposta = await salvarAbasDaInbox(ABAS_DA_INBOX.map((id) => ({ id, visivel: false })));

    expect(resposta.ok).toBe(true);
    if (!resposta.ok) return;
    expect(resposta.abas.every((a) => a.visivel)).toBe(true);
  });

  it("preserva o resto do metadata da pessoa (nome, idioma, lateral)", async () => {
    h.metadata.set(A, {
      full_name: "Maria",
      locale: "es",
      modulos_da_lateral: [{ id: "acervo", visivel: false }],
    });

    await salvarAbasDaInbox(abasPadrao());

    const metadata = metadataDe(A)!;
    expect(metadata.full_name).toBe("Maria");
    expect(metadata.locale).toBe("es");
    expect(metadata.modulos_da_lateral).toEqual([{ id: "acervo", visivel: false }]);
    expect(metadata[CHAVE_DAS_ABAS]).toHaveLength(ABAS_DA_INBOX.length);
  });

  it("o audit registra ordem, visíveis e ocultas — e só isso", async () => {
    await salvarAbasDaInbox([
      { id: "mine", visivel: true },
      { id: "archived", visivel: false },
    ]);

    expect(h.audit).toHaveBeenCalledTimes(1);
    const evento = h.audit.mock.calls[0]![0] as {
      action: string;
      actorUserId: string;
      metadata: { visiveis: string[]; ocultas: string[]; ordem: string[] };
    };
    expect(evento.action).toBe("user.inbox_tabs_updated");
    expect(evento.actorUserId).toBe(A);
    expect(evento.metadata.ordem[0]).toBe("mine");
    expect(evento.metadata.ocultas).toEqual(["archived"]);
    expect(evento.metadata.visiveis).not.toContain("archived");
    expect(Object.keys(evento.metadata).sort()).toEqual(["ocultas", "ordem", "visiveis"]);
  });
});

describe("#3313 — as abas de A não mudam as de B", () => {
  it("gravar como A não toca no metadata de B, e B continua vendo a faixa de hoje", async () => {
    h.sessao = A;
    await salvarAbasDaInbox([{ id: "closed", visivel: false }]);

    h.sessao = B;
    const doB = await carregarAbasDaInbox();
    expect(doB).toEqual({ ok: true, abas: abasPadrao() });
    expect(metadataDe(B)).toBeUndefined();

    h.sessao = A;
    const doA = await carregarAbasDaInbox();
    expect(doA.abas[0]).toEqual({ id: "closed", visivel: false });
  });
});

describe("#3313 — nada é gravado quando não se pode gravar", () => {
  it.each([
    ["lista vazia", []],
    ["id que não existe", [{ id: "aba-inventada", visivel: true }]],
    ["sem a flag de visibilidade", [{ id: "mine" }]],
    ["não é lista", "mine"],
  ])("%s → recusa de validação, sem tocar no banco", async (_caso, entrada) => {
    const resposta = await salvarAbasDaInbox(entrada as never);

    expect(resposta).toEqual({ ok: false, erro: "validacao" });
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sem sessão não há onde gravar", async () => {
    h.loadAuthUser.mockResolvedValue(null);

    expect(await salvarAbasDaInbox(abasPadrao())).toEqual({ ok: false, erro: "sessao" });
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("modo somente-leitura (acompanhamento) recusa antes de escrever", async () => {
    h.supportWriteError.mockReturnValue("support_readonly" as never);

    expect(await salvarAbasDaInbox(abasPadrao())).toEqual({ ok: false, erro: "somente_leitura" });
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("falha do GoTrue não vira sucesso nem audit", async () => {
    h.erroDeUpdate = { message: "session_not_found" };

    expect(await salvarAbasDaInbox(abasPadrao())).toEqual({ ok: false, erro: "falha" });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("#3313 — a leitura nunca devolve faixa vazia", () => {
  it("sem sessão: o padrão, e `ok: false`", async () => {
    h.loadAuthUser.mockResolvedValue(null);

    expect(await carregarAbasDaInbox()).toEqual({ ok: false, abas: abasPadrao() });
  });

  it("falha de leitura do GoTrue: o padrão", async () => {
    h.erroDeGet = { message: "network" };

    expect(await carregarAbasDaInbox()).toEqual({ ok: false, abas: abasPadrao() });
  });

  it("metadata com lixo na chave devolve o padrão inteiro", async () => {
    h.metadata.set(A, { [CHAVE_DAS_ABAS]: "Fila primeiro" });

    expect(await carregarAbasDaInbox()).toEqual({ ok: true, abas: abasPadrao() });
  });
});
