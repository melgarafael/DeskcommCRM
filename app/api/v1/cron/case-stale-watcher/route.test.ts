/**
 * O caso parado volta a pedir passagem — e para de pedir na hora certa.
 *
 * O caso 4 é o que mais importa e o menos óbvio: a cobrança NÃO pode mexer em
 * `updated_at`. A consulta usa `updated_at` para saber se alguém encostou no
 * caso; se o próprio aviso o atualizasse, o watcher adiaria a si mesmo por mais
 * 24h a cada rodada — sabotagem silenciosa, que só apareceria como "a segunda
 * cobrança nunca chega".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const hAtras = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

interface Capturado {
  filtros: Array<{ col: string; val: unknown; op: string }>;
  avisos: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

function admin(casos: Array<Record<string, unknown>>, jaTemAviso: boolean, cap: Capturado) {
  return {
    from(tabela: string) {
      if (tabela === "agent_cases") {
        return {
          select: () => {
            const chain: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                cap.filtros.push({ col, val, op: "eq" });
                return chain;
              },
              lt: (col: string, val: unknown) => {
                cap.filtros.push({ col, val, op: "lt" });
                return chain;
              },
              order: () => chain,
              limit: async () => ({ data: casos, error: null }),
            };
            return chain;
          },
          update: (patch: Record<string, unknown>) => {
            cap.updates.push(patch);
            const c: Record<string, unknown> = { eq: () => c, then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) };
            return c;
          },
        };
      }
      // agent_inbox_items
      return {
        select: () => {
          const c: Record<string, unknown> = {
            eq: () => c,
            maybeSingle: async () => ({ data: jaTemAviso ? { id: "aviso-1" } : null }),
          };
          return c;
        },
        insert: async (linha: Record<string, unknown>) => {
          cap.avisos.push(linha);
          return { error: null };
        },
      };
    },
  };
}

const vazio = (): Capturado => ({ filtros: [], avisos: [], updates: [] });
const req = () => new NextRequest("http://localhost/x", { headers: { authorization: "Bearer segredo" } });

beforeEach(() => vi.clearAllMocks());

describe("case-stale-watcher", () => {
  it("abre o aviso apontando para o caso, com o kind e a referência certos", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [{ id: "c1", organization_id: ORG, title: "Liberar acesso", opened_at: hAtras(50), updated_at: hAtras(50), followup_attempts: 0 }],
        false,
        cap,
      ) as never,
    );

    const { POST } = await import("./route");
    const body = (await (await POST(req())).json()) as { data: Record<string, number> };

    expect(body.data).toMatchObject({ examinados: 1, avisados: 1 });
    expect(cap.avisos[0]).toMatchObject({
      organization_id: ORG,
      kind: "case_stale",
      severity: "warn",
      ref_kind: "agent_case",
      ref_id: "c1",
    });
    // O título fala de quem espera, não da idade de uma linha.
    expect(String(cap.avisos[0]!.title)).toContain("espera decisão");
  });

  it("a consulta filtra por awaiting_human, pelo silêncio e pelo teto", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(admin([], false, cap) as never);

    const { POST } = await import("./route");
    await POST(req());

    expect(cap.filtros).toContainEqual({ col: "status", val: "awaiting_human", op: "eq" });
    // `updated_at`, não `opened_at`: qualquer mexida no caso conta como
    // "alguém encostou", e cobrar por idade absoluta avisaria de novo sobre um
    // caso que a equipe está tratando agora.
    expect(cap.filtros.some((f) => f.col === "updated_at" && f.op === "lt")).toBe(true);
    expect(cap.filtros.some((f) => f.col === "followup_attempts" && f.op === "lt")).toBe(true);
  });

  it("não abre um segundo aviso enquanto o primeiro está aberto", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [{ id: "c1", organization_id: ORG, title: "x", opened_at: hAtras(50), updated_at: hAtras(50), followup_attempts: 1 }],
        true, // já existe aviso aberto
        cap,
      ) as never,
    );

    const { POST } = await import("./route");
    const body = (await (await POST(req())).json()) as { data: Record<string, number> };

    expect(body.data).toMatchObject({ avisados: 0, ja_avisados: 1 });
    expect(cap.avisos).toHaveLength(0);
    // E o contador NÃO sobe: senão o teto se esgotaria sem nunca ter avisado.
    expect(cap.updates).toHaveLength(0);
  });

  it("⚠️ a cobrança NÃO mexe em updated_at — senão o watcher adia a si mesmo", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [{ id: "c1", organization_id: ORG, title: "x", opened_at: hAtras(50), updated_at: hAtras(50), followup_attempts: 0 }],
        false,
        cap,
      ) as never,
    );

    const { POST } = await import("./route");
    await POST(req());

    expect(cap.updates).toHaveLength(1);
    expect(cap.updates[0]).toEqual({ followup_attempts: 1 });
    expect(Object.keys(cap.updates[0]!)).not.toContain("updated_at");
  });

  it("o último aviso diz que é o último", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [{ id: "c1", organization_id: ORG, title: "x", opened_at: hAtras(80), updated_at: hAtras(30), followup_attempts: 2 }],
        false,
        cap,
      ) as never,
    );

    const { POST } = await import("./route");
    await POST(req());

    expect(String(cap.avisos[0]!.body)).toContain("último aviso");
    expect(cap.updates[0]).toEqual({ followup_attempts: 3 });
  });

  it("rodada sem ninguém a cobrar não audita", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin([], false, vazio()) as never);
    const { POST } = await import("./route");
    await POST(req());
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem o segredo, 403 e não lê nada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin([], false, vazio()) as never);
    const { POST } = await import("./route");
    expect((await POST(new NextRequest("http://localhost/x"))).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
