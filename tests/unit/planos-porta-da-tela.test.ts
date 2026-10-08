/**
 * A PORTA dos planos de tarefa (#1752) — rota + tela + entrada no menu.
 *
 * O que este arquivo prova, e o que ele NÃO prova:
 *
 *   1. a tela `/app/tasks/planos` está no REGISTRO e aparece nas projeções que
 *      desenham o menu (hub do CRM e ⌘K) — sem a entrada em
 *      `lib/navigation/catalogo.ts` o registry deriva nada e a tela fica órfã;
 *   2. a rota `settings/task-plans` RESPONDE: GET devolve os planos gravados e
 *      PATCH grava pelo MESMO `planosSchema` do motor, recusando com 422 o que
 *      o motor não aplicaria — e sem escrever nada na recusa.
 *
 * NÃO prova o formulário da tela (o editor é medida em
 * `tests/unit/apply-task-plan-no-editor.test.ts`) nem o merge destrutivo do
 * jsonb: as demais chaves de `settings` sobrevivem ao PATCH, que é o que a
 * recusa do `settings/campanhas` já cobra lá.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { hubSections, searchable } from "@/lib/navigation/registry";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const { requireRole } = await import("@/lib/auth/require-role");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { GET, PATCH } = await import("@/app/api/v1/settings/task-plans/route");

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER = "99999999-0000-4000-8000-000000000009";

const PLANO = {
  id: "proposta-enviada",
  nome: "Proposta enviada",
  descricao: null,
  passos: [
    { ordem: 1, titulo: "Ligar em 2 dias", vence_em_dias: 2, prioridade: "medium", atribuir_a: "dono_do_lead" },
  ],
};

const escritas: Array<{
  tabela: string;
  payload: Record<string, unknown>;
  filtro: [string, unknown];
}> = [];

function adminCom(settings: unknown) {
  return {
    from(tabela: string) {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { settings }, error: null }) }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (coluna: string, valor: unknown) => {
            escritas.push({ tabela, payload, filtro: [coluna, valor] });
            return { error: null };
          },
        }),
      };
    },
  };
}

function requisicao(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/settings/task-plans", {
    method: "PATCH",
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  escritas.length = 0;
  vi.mocked(requireRole).mockReset();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: USER, idioma: "pt-BR" },
  } as never);
  vi.mocked(createAdminClient).mockReset();
});

describe("a tela Tarefas › Planos aparece no menu", () => {
  it("está no registro e nas projeções do hub do CRM e do ⌘K", () => {
    const HREF = "/app/tasks/planos";

    const noBuscador = searchable(false, "manager");
    expect(
      noBuscador.map((d) => d.href),
      "sem a entrada em lib/navigation/catalogo.ts o registry deriva nada",
    ).toContain(HREF);

    const secoes = hubSections("crm", false, "manager");
    const destino = secoes.flatMap((s) => s.items).find((d) => d.href === HREF);
    expect(destino, "destino ausente do hub do CRM").toBeDefined();
    expect(destino!.section).toBe("O dia a dia da venda");
    // É cadastro, não uso diário: cabe no hub, não ganha um pixel de sidebar.
    expect(destino!.sidebar).toBeUndefined();
  });
});

describe("GET /api/v1/settings/task-plans", () => {
  it("devolve os planos que o motor lê", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminCom({ task_plans: [PLANO] }) as never);

    const res = await GET();
    const corpo = (await res.json()) as { data: { planos: Array<{ id: string }> } };

    expect(res.status).toBe(200);
    expect(corpo.data.planos.map((p) => p.id)).toEqual(["proposta-enviada"]);
  });
});

describe("PATCH /api/v1/settings/task-plans", () => {
  it("grava pelo MESMO planoSchema do motor e preserva as demais chaves de settings", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminCom({ campanhas: { intervalo_segundos: 60 }, task_plans: [] }) as never,
    );

    const res = await PATCH(requisicao({ planos: [PLANO] }));
    const corpo = (await res.json()) as { data: { planos: Array<{ id: string }> } };

    expect(res.status).toBe(200);
    expect(corpo.data.planos.map((p) => p.id)).toEqual(["proposta-enviada"]);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.payload).toEqual({
      settings: {
        campanhas: { intervalo_segundos: 60 },
        task_plans: [PLANO],
      },
    });
  });

  it("recusa com 422 um plano que o motor não aplicaria — e NÃO escreve nada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminCom({ task_plans: [] }) as never);

    const torto = { ...PLANO, passos: [{ titulo: "Sem prazo" }] };
    const res = await PATCH(requisicao({ planos: [torto] }));
    const corpo = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("validation_failed");
    expect(escritas, "a recusa tem de vir ANTES da escrita").toHaveLength(0);
  });

  it("só grava com manager+ e só na organização da sessão", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminCom({ task_plans: [] }) as never);

    const res = await PATCH(requisicao({ planos: [PLANO] }));

    expect(res.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
    expect(escritas.map((e) => [e.tabela, e.filtro])).toEqual([["organizations", ["id", ORG]]]);
  });

  it("papel abaixo de manager é recusado ANTES de qualquer escrita", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminCom({ task_plans: [] }) as never);
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);

    const res = await PATCH(requisicao({ planos: [PLANO] }));

    expect(res.status).toBe(403);
    expect(escritas).toHaveLength(0);
  });

  it("recusa corpo que não é lista de planos", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminCom({ task_plans: [] }) as never);

    const res = await PATCH(requisicao({ planos: "lixo" }));
    expect(res.status).toBe(422);
    expect(escritas).toHaveLength(0);
  });
});
