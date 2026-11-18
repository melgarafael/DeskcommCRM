/**
 * POST /api/v1/leads/[id]/checklist/[tarefaId] — marcar um item segue a régua
 * da SESSÃO nas duas pontas: só quem vê o negócio chega à lib, e a escrita do
 * status vai pelo client da sessão (a mesma permissão de escrita em tarefa do
 * PATCH de `/tasks/[id]`). Recusa da escrita é "não gravou", nunca sucesso.
 */
// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/cadencias/visibilidade", () => ({ negocioVisivel: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/db", () => ({ portaDaAplicacao: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/tarefas/checklist", () => ({ marcarItemDoChecklist: vi.fn() }));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { negocioVisivel } from "@/lib/cadencias/visibilidade";
import { createClient } from "@/lib/supabase/server";
import { marcarItemDoChecklist, type GravarSituacao } from "@/lib/tarefas/checklist";

import { POST } from "./route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TAREFA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Client de sessão de mentira: registra o update e devolve o que a RLS deixaria. */
function sessao(linhaQueVolta: { id: string } | null) {
  const filtros: Array<[string, unknown]> = [];
  const update = vi.fn();
  const cadeia = {
    update: (valores: unknown) => (update(valores), cadeia),
    eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), cadeia),
    select: () => cadeia,
    maybeSingle: async () => ({ data: linhaQueVolta, error: null }),
  };
  const from = vi.fn(() => cadeia);
  vi.mocked(createClient).mockResolvedValue({ from } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { from, update, filtros };
}

function chamar(concluido = true) {
  return POST(
    new NextRequest(`http://localhost/api/v1/leads/${LEAD}/checklist/${TAREFA}`, {
      method: "POST",
      body: JSON.stringify({ concluido }),
    }),
    { params: Promise.resolve({ id: LEAD, tarefaId: TAREFA }) },
  );
}

function sucesso(anterior: "pending" | "done", status: "pending" | "done") {
  const item = { tarefa_id: TAREFA, status };
  return { ok: true as const, anterior, item, checklist: { itens: [item] } } as unknown as Awaited<
    ReturnType<typeof marcarItemDoChecklist>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(negocioVisivel).mockResolvedValue(true);
});

describe("POST marcar item do checklist", () => {
  it("sessão que não vê o negócio recebe 404 e a lib não é chamada", async () => {
    vi.mocked(negocioVisivel).mockResolvedValue(false);
    sessao(null);
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(negocioVisivel).toHaveBeenCalledWith(ORG, LEAD);
    expect(marcarItemDoChecklist).not.toHaveBeenCalled();
  });

  it("a escrita do status vai pelo client da sessão e a recusa dela é 'não gravou'", async () => {
    const s = sessao(null); // a régua de escrita da sessão recusou: zero linhas
    vi.mocked(marcarItemDoChecklist).mockResolvedValue(sucesso("pending", "done"));
    await chamar();

    const gravar = vi.mocked(marcarItemDoChecklist).mock.calls[0]![2] as GravarSituacao;
    expect(await gravar(TAREFA, "done")).toBe(false);
    expect(s.from).toHaveBeenCalledWith("crm_tasks");
    expect(s.update).toHaveBeenCalledWith({ status: "done" });
    expect(s.filtros).toEqual(
      expect.arrayContaining([
        ["id", TAREFA],
        ["organization_id", ORG],
        ["lead_id", LEAD],
      ]),
    );
  });

  it("sessão que pode escrever na tarefa grava", async () => {
    sessao({ id: TAREFA });
    vi.mocked(marcarItemDoChecklist).mockResolvedValue(sucesso("pending", "done"));
    await chamar();
    const gravar = vi.mocked(marcarItemDoChecklist).mock.calls[0]![2] as GravarSituacao;
    expect(await gravar(TAREFA, "done")).toBe(true);
  });

  it("audita com de/para quando o status mudou", async () => {
    sessao({ id: TAREFA });
    vi.mocked(marcarItemDoChecklist).mockResolvedValue(sucesso("pending", "done"));
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ de: "pending", para: "done" }) }),
    );
  });

  it("clicar no que já estava marcado não audita", async () => {
    sessao({ id: TAREFA });
    vi.mocked(marcarItemDoChecklist).mockResolvedValue(sucesso("done", "done"));
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
});
