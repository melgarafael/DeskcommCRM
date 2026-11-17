/**
 * GET /api/v1/agenda/painel-do-dia — a rota do painel do dia (#4029, saída 3).
 *
 * O que este teste protege:
 *
 *  - **200 com o id de requisição**, que é o contrato de toda rota `/api/v1`
 *    (`ok()` põe `X-Request-Id` no header). Sem ele, um erro relatado pela tela
 *    não acha o log.
 *  - **A leitura é só-sessão e com piso `viewer`**, o mesmo da agenda: quando
 *    `requireRole` recusa, a resposta DELE é o que sai — a rota não inventa uma
 *    segunda régua.
 *  - **O recorte é o dia pedido**, e a rota chega ao leitor com o fuso da
 *    ORGANIZAÇÃO (não o do navegador, não UTC).
 *  - **Dia malformado é 422**, antes de qualquer consulta.
 */
// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/agenda/painel-do-dia", () => ({ lerPainelDoDia: vi.fn() }));

import { lerPainelDoDia } from "@/lib/agenda/painel-do-dia";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";

function pedido(url = "http://localhost/api/v1/agenda/painel-do-dia?dia=2026-11-08") {
  return new NextRequest(url);
}

describe("GET /api/v1/agenda/painel-do-dia", () => {
  beforeEach(() => {
    vi.mocked(requireRole).mockReset();
    vi.mocked(createClient).mockReset();
    vi.mocked(lerPainelDoDia).mockReset();

    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: { orgId: ORG, name: "Clínica", role: "viewer", timezone: "America/Sao_Paulo" },
    } as never);
    vi.mocked(createClient).mockResolvedValue({} as never);
    vi.mocked(lerPainelDoDia).mockResolvedValue({
      dia: "2026-11-08",
      fuso: "America/Sao_Paulo",
      linhas: [],
      totais: { turmas: 0, reservas: 0, pessoasEsperadas: 0, confirmadas: 0, capacidade: 0, percentual: null },
      vazio: true,
      truncado: false,
    });
  });

  it("(e) responde 200 com o id de requisição e chama a leitura com o dia e o fuso DA ORGANIZAÇÃO", async () => {
    const resposta = await GET(pedido());

    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const corpo = (await resposta.json()) as { data: { dia: string; vazio: boolean; totais: { percentual: null } } };
    expect(corpo.data).toMatchObject({ dia: "2026-11-08", vazio: true });
    expect(corpo.data.totais.percentual).toBeNull();

    expect(vi.mocked(lerPainelDoDia)).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      "2026-11-08",
      "America/Sao_Paulo",
    );
  });

  it("sem `dia`, o padrão é hoje no fuso da organização", async () => {
    const resposta = await GET(pedido("http://localhost/api/v1/agenda/painel-do-dia"));
    expect(resposta.status).toBe(200);
    const dia = vi.mocked(lerPainelDoDia).mock.calls[0]?.[2] ?? "";
    expect(dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(vi.mocked(lerPainelDoDia).mock.calls[0]?.[3]).toBe("America/Sao_Paulo");
  });

  it("dia malformado é 422 e não consulta nada", async () => {
    const resposta = await GET(pedido("http://localhost/api/v1/agenda/painel-do-dia?dia=08/11/2026"));
    expect(resposta.status).toBe(422);
    const corpo = (await resposta.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("validation_failed");
    expect(vi.mocked(lerPainelDoDia)).not.toHaveBeenCalled();
  });

  it("quando requireRole recusa, a resposta é a dele — sem segunda régua", async () => {
    const negado = new Response(JSON.stringify({ error: { code: "forbidden", message: "sem acesso" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: negado } as never);

    const resposta = await GET(pedido());
    expect(resposta.status).toBe(403);
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
    expect(vi.mocked(lerPainelDoDia)).not.toHaveBeenCalled();
  });
});
