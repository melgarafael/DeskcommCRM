/**
 * A LATERAL DE CADA PESSOA: gravar e ler sem vazar para o colega (#3008).
 *
 * ─── O que a issue promete, e o que este arquivo mede ───────────────────────
 *
 *   - "salvar as preferências individualmente para cada usuário": a gravação
 *     vai para o metadata de QUEM ESTÁ LOGADO (da sessão, nunca do argumento) e
 *     NÃO toca no metadata de mais ninguém — o teste troca de sessão e lê as
 *     duas laterais;
 *   - "manter a organização nos próximos acessos": a leitura devolve o que foi
 *     gravado, normalizado pela MESMA régua da tela;
 *   - e os controles que a tela depende: sem sessão, somente-leitura, entrada
 *     inválida e falha do GoTrue não podem virar escrita silenciosa nem lista
 *     vazia.
 *
 * O dublê do `auth` é stateful (um `Map` por usuário) justamente para que "A
 * não afeta B" seja medido, e não afirmado: uma implementação que gravasse no
 * usuário errado passaria num dublê sem estado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAVE_DOS_MODULOS, MODULOS_DA_LATERAL, modulosPadrao } from "@/lib/inbox/modulos-da-lateral";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  supportWriteError: vi.fn(),
  updateUser: vi.fn(),
  revalidatePath: vi.fn(),
  /** O "banco" do auth: metadata por usuário — é o que a leitura devolve. */
  metadata: new Map<string, Record<string, unknown>>(),
  /** De quem é a sessão desta chamada. */
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

import { carregarModulosDaLateral, salvarModulosDaLateral } from "./modulosDaLateral";

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

describe("#3008 — gravar a lateral é escrever no metadata de QUEM está logado", () => {
  it("grava a lista NORMALIZADA (completa) e devolve o que foi gravado", async () => {
    // A tela pode mandar um recorte; o metadata guarda a lista inteira, porque
    // ela é a única fonte da ordem — um recorte apagaria a posição dos outros.
    const resposta = await salvarModulosDaLateral([{ id: "acervo", visivel: false }]);

    expect(resposta.ok).toBe(true);
    if (!resposta.ok) return;
    expect(resposta.modulos).toHaveLength(MODULOS_DA_LATERAL.length);
    expect(resposta.modulos[0]).toEqual({ id: "acervo", visivel: false });

    const gravado = metadataDe(A)?.[CHAVE_DOS_MODULOS] as Array<{ id: string; visivel: boolean }>;
    expect(gravado).toHaveLength(MODULOS_DA_LATERAL.length);
    expect(gravado[0]).toEqual({ id: "acervo", visivel: false });
    expect(h.revalidatePath).toHaveBeenCalledWith("/app/inbox");
  });

  it("preserva o resto do metadata da pessoa (nome, idioma, lembretes)", async () => {
    h.metadata.set(A, {
      full_name: "Maria",
      locale: "es",
      lembretes_de_tarefa: { task_due: true, task_overdue: false },
    });

    await salvarModulosDaLateral(modulosPadrao());

    const metadata = metadataDe(A)!;
    expect(metadata.full_name).toBe("Maria");
    expect(metadata.locale).toBe("es");
    expect(metadata.lembretes_de_tarefa).toEqual({ task_due: true, task_overdue: false });
    expect(metadata[CHAVE_DOS_MODULOS]).toHaveLength(MODULOS_DA_LATERAL.length);
  });

  it("o audit registra ordem e visibilidade — e só isso", async () => {
    await salvarModulosDaLateral([
      { id: "acervo", visivel: true },
      { id: "atividade", visivel: false },
    ]);

    expect(h.audit).toHaveBeenCalledTimes(1);
    const evento = h.audit.mock.calls[0]![0] as {
      action: string;
      actorUserId: string;
      metadata: { visiveis: string[]; escondidos: string[]; ordem: string[] };
    };
    expect(evento.action).toBe("user.inbox_modules_updated");
    expect(evento.actorUserId).toBe(A);
    expect(evento.metadata.ordem[0]).toBe("acervo");
    expect(evento.metadata.escondidos).toEqual(["atividade"]);
    expect(evento.metadata.visiveis).not.toContain("atividade");
  });
});

describe("#3008 — a preferência do usuário A não afeta a do B", () => {
  it("gravar como A não muda o metadata de B, e B continua vendo a lateral de hoje", async () => {
    h.sessao = A;
    await salvarModulosDaLateral([{ id: "acervo", visivel: false }]);

    // Ninguém gravou nada para B: a leitura dele é o PADRÃO.
    h.sessao = B;
    const doB = await carregarModulosDaLateral();
    expect(doB.ok).toBe(true);
    expect(doB.modulos).toEqual(modulosPadrao());
    expect(metadataDe(B)).toBeUndefined();

    // E a de A continua a que ele escolheu.
    h.sessao = A;
    const doA = await carregarModulosDaLateral();
    expect(doA.modulos[0]).toEqual({ id: "acervo", visivel: false });
  });

  it("cada um grava a própria: as duas laterais convivem no mesmo banco", async () => {
    h.sessao = A;
    await salvarModulosDaLateral([
      { id: "acervo", visivel: true },
      { id: "atividade", visivel: false },
    ]);

    h.sessao = B;
    await salvarModulosDaLateral([
      { id: "acervo", visivel: false },
      { id: "atividade", visivel: true },
    ]);

    h.sessao = A;
    const doA = await carregarModulosDaLateral();
    h.sessao = B;
    const doB = await carregarModulosDaLateral();

    const visivel = (modulos: typeof doA.modulos, id: string) =>
      modulos.find((m) => m.id === id)?.visivel;

    expect(visivel(doA.modulos, "acervo")).toBe(true);
    expect(visivel(doA.modulos, "atividade")).toBe(false);
    expect(visivel(doB.modulos, "acervo")).toBe(false);
    expect(visivel(doB.modulos, "atividade")).toBe(true);
    // O metadata de B não é o de A, e vice-versa.
    expect(metadataDe(A)).not.toEqual(metadataDe(B));
  });
});

describe("#3008 — nada é gravado quando não se pode gravar", () => {
  it.each([
    ["lista vazia", []],
    ["id que não existe", [{ id: "modulo-inventado", visivel: true }]],
    ["sem a flag de visibilidade", [{ id: "acervo" }]],
    ["não é lista", "acervo"],
  ])("%s → recusa de validação, sem tocar no banco", async (_caso, entrada) => {
    const resposta = await salvarModulosDaLateral(entrada as never);

    expect(resposta).toEqual({ ok: false, erro: "validacao" });
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sem sessão não há onde gravar", async () => {
    h.loadAuthUser.mockResolvedValue(null);

    expect(await salvarModulosDaLateral(modulosPadrao())).toEqual({ ok: false, erro: "sessao" });
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("modo somente-leitura (acompanhamento) recusa antes de escrever", async () => {
    h.supportWriteError.mockReturnValue("support_readonly" as never);

    expect(await salvarModulosDaLateral(modulosPadrao())).toEqual({
      ok: false,
      erro: "somente_leitura",
    });
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("falha do GoTrue não vira sucesso nem audit", async () => {
    h.erroDeUpdate = { message: "session_not_found" };

    expect(await salvarModulosDaLateral(modulosPadrao())).toEqual({ ok: false, erro: "falha" });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("#3008 — a leitura da lateral nunca devolve lista vazia", () => {
  it("sem sessão: o padrão, e `ok: false` para a tela saber que não leu", async () => {
    h.loadAuthUser.mockResolvedValue(null);

    expect(await carregarModulosDaLateral()).toEqual({ ok: false, modulos: modulosPadrao() });
  });

  it("falha de leitura do GoTrue: o padrão, nunca uma lateral sem módulo", async () => {
    // Falhar aqui não pode esvaziar a lateral: a tela tem de desenhar ALGUMA
    // coisa, e o padrão é a lateral de hoje — não uma pilha vazia de `<aside>`.
    h.erroDeGet = { message: "network" };

    const resposta = await carregarModulosDaLateral();

    expect(resposta.ok).toBe(false);
    expect(resposta.modulos).toEqual(modulosPadrao());
  });

  it("metadata com lixo na chave devolve o padrão inteiro", async () => {
    h.metadata.set(A, { [CHAVE_DOS_MODULOS]: "acervo primeiro" });

    expect(await carregarModulosDaLateral()).toEqual({ ok: true, modulos: modulosPadrao() });
  });
});
