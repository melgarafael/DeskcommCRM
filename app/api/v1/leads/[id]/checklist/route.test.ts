/**
 * GET /api/v1/leads/[id]/checklist — o checklist só aparece para quem VÊ o
 * negócio. A leitura da lib usa a porta da aplicação, que não passa pela régua
 * de visibilidade da sessão; por isso a rota pergunta antes (`negocioVisivel`).
 */
// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/cadencias/visibilidade", () => ({ negocioVisivel: vi.fn() }));
vi.mock("@/lib/db", () => ({ portaDaAplicacao: vi.fn(() => ({})) }));
vi.mock("@/lib/tarefas/checklist", () => ({ lerChecklistDoNegocio: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { negocioVisivel } from "@/lib/cadencias/visibilidade";
import { lerChecklistDoNegocio } from "@/lib/tarefas/checklist";

import { GET } from "./route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function chamar() {
  return GET(new NextRequest(`http://localhost/api/v1/leads/${LEAD}/checklist`), {
    params: Promise.resolve({ id: LEAD }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(lerChecklistDoNegocio).mockResolvedValue({ ok: true, checklist: null });
});

describe("GET checklist do card", () => {
  it("sessão que não vê o negócio recebe 404 e nada é lido", async () => {
    vi.mocked(negocioVisivel).mockResolvedValue(false);
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(negocioVisivel).toHaveBeenCalledWith(ORG, LEAD);
    expect(lerChecklistDoNegocio).not.toHaveBeenCalled();
  });

  it("falha ao conferir a visibilidade é 500, não lista", async () => {
    vi.mocked(negocioVisivel).mockResolvedValue("erro");
    const res = await chamar();
    expect(res.status).toBe(500);
    expect(lerChecklistDoNegocio).not.toHaveBeenCalled();
  });

  it("sessão que vê o negócio recebe o checklist", async () => {
    vi.mocked(negocioVisivel).mockResolvedValue(true);
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(lerChecklistDoNegocio).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, leadId: LEAD });
  });
});
