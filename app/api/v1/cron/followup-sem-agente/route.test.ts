/**
 * O fluxo publicado que não dispara vira aviso — e o aviso some quando o
 * problema some.
 *
 * Os dois casos que mais importam:
 *
 *  • **`manual` e `webhook` ficam de fora.** Eles funcionam sem agente nenhum;
 *    avisar sobre eles seria alarme falso, e alarme falso é o que ensina uma
 *    equipe a ignorar o alarme verdadeiro. Sem este caso, "avisa sobre tudo que
 *    está publicado" passaria.
 *  • **O aviso FECHA sozinho.** Quem consertou não pode ficar com um aviso
 *    permanente pedindo algo já feito. É a metade do laço que costuma faltar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const AGENTE = "33333333-3333-4333-8333-333333333333";

interface Ponteiro {
  id: string;
  organization_id: string;
  name: string;
  trigger_config: unknown;
  active_version_id?: string | null;
}

interface Capturado {
  avisos: Array<Record<string, unknown>>;
  resolvidos: Array<Record<string, unknown>>;
}

/**
 * Client fake das três tabelas que a rota toca. `armados` é o que o gate real
 * leria de `ai_agent_versions` — a rota usa o adaptador de produção, então o
 * formato aqui é o da tabela, não o do gate.
 */
function admin(opts: {
  ponteiros: Ponteiro[];
  followupPorOrg?: Record<string, unknown>;
  avisoAbertoDe?: Set<string>;
  versoes?: Array<{ id: string; graph: unknown }>;
  cap: Capturado;
}) {
  const { ponteiros, followupPorOrg = {}, avisoAbertoDe = new Set<string>(), versoes = [], cap } = opts;
  return {
    from(tabela: string) {
      if (tabela === "followup_flow_pointers") {
        return {
          select: () => ({
            eq: () => ({ limit: async () => ({ data: ponteiros, error: null }) }),
          }),
        };
      }
      if (tabela === "followup_flow_versions") {
        return {
          select: () => ({
            in: async () => ({ data: versoes, error: null }),
          }),
        };
      }
      if (tabela === "ai_agent_versions") {
        const c: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            if (col === "organization_id") {
              c.__org = val;
            }
            return c;
          },
          then: (r: (v: unknown) => unknown) => {
            const followup = followupPorOrg[c.__org as string];
            return Promise.resolve({
              data: followup ? [{ agent_id: AGENTE, followup }] : [],
              error: null,
            }).then(r);
          },
        };
        return { select: () => c };
      }
      // agent_inbox_items
      let refAtual: string | null = null;
      const consulta: Record<string, unknown> = {
        eq: (col: string, val: unknown) => {
          if (col === "ref_id") refAtual = val as string;
          return consulta;
        },
        maybeSingle: async () => ({
          data: refAtual && avisoAbertoDe.has(refAtual) ? { id: `aviso-${refAtual}` } : null,
        }),
      };
      return {
        select: () => consulta,
        insert: async (linha: Record<string, unknown>) => {
          cap.avisos.push(linha);
          return { error: null };
        },
        update: (patch: Record<string, unknown>) => {
          const c: Record<string, unknown> = {
            eq: () => c,
            then: (r: (v: unknown) => unknown) => {
              cap.resolvidos.push(patch);
              return Promise.resolve({ error: null }).then(r);
            },
          };
          return c;
        },
      };
    },
  };
}

const vazio = (): Capturado => ({ avisos: [], resolvidos: [] });
const req = () => new NextRequest("http://localhost/x", { headers: { authorization: "Bearer segredo" } });
const fluxo = (id: string, kind: string, org = ORG, name = `Fluxo ${id}`): Ponteiro => ({
  id,
  organization_id: org,
  name,
  trigger_config: kind === "stage_change" ? { kind, params: { stage_id: id } } : { kind },
});
/** O que o gate real lê quando um agente publicado arma estes ponteiros. */
const arma = (...ids: string[]) => ({ enabled: true, flow_pointer_ids: ids });

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/cron/followup-sem-agente", () => {
  it("abre aviso para o fluxo automático que nenhum agente arma", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({ ponteiros: [fluxo("f1", "silence", ORG, "Consulta · retomar quem sumiu")], cap }) as never,
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ examinados: 1, abertos: 1, fechados: 0 });

    expect(cap.avisos).toHaveLength(1);
    expect(cap.avisos[0]).toMatchObject({
      organization_id: ORG,
      kind: "followup_sem_agente",
      severity: "warn",
      ref_kind: "followup_flow",
      ref_id: "f1",
    });
    // O aviso NOMEIA o fluxo e diz quando ele dispararia: sem isso, quem tem
    // quatro modelos instalados não sabe qual está parado.
    expect(cap.avisos[0]!.title).toContain("Consulta · retomar quem sumiu");
    expect(cap.avisos[0]!.body).toContain("sem o contato responder");
    expect(cap.avisos[0]!.body).toContain("follow-ups que arma");
  });

  it.each([
    ["stage_change", "entra numa etapa do funil"],
    ["case_opened", "atendimento é aberto"],
    ["appointment_no_show", "não compareceu"],
    ["inbound_after_silence", "volta a escrever"],
  ])("também vigia o gatilho %s, e diz em português quando ele dispararia", async (kind, frase) => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({ ponteiros: [fluxo("f1", kind)], cap }) as never,
    );

    await GET(req());
    expect(cap.avisos).toHaveLength(1);
    expect(cap.avisos[0]!.body).toContain(frase);
  });

  it.each(["manual", "webhook"])(
    "NÃO avisa sobre o fluxo %s — ele funciona sem agente, e o alarme seria falso",
    async (kind) => {
      const cap = vazio();
      vi.mocked(createAdminClient).mockReturnValue(
        admin({ ponteiros: [fluxo("f1", kind)], cap }) as never,
      );

      const res = await GET(req());
      expect((await res.json()).data).toMatchObject({ examinados: 0, abertos: 0 });
      expect(cap.avisos).toEqual([]);
    },
  );

  it("não avisa quando um agente publicado arma o fluxo", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({
        ponteiros: [fluxo("f1", "silence")],
        followupPorOrg: { [ORG]: arma("f1") },
        cap,
      }) as never,
    );

    const res = await GET(req());
    expect((await res.json()).data).toMatchObject({ abertos: 0, fechados: 0 });
    expect(cap.avisos).toEqual([]);
  });

  it("NÃO avisa sobre o fluxo automático cujo grafo é só texto fixo — ele dispara sem agente", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({
        ponteiros: [{ ...fluxo("f1", "silence", ORG, "Resposta automática"), active_version_id: "v1" }],
        versoes: [
          {
            id: "v1",
            graph: {
              nodes: [
                { id: "t1", type: "trigger" },
                { id: "a1", type: "action", config: { mode: "text" } },
              ],
            },
          },
        ],
        cap,
      }) as never,
    );

    const res = await GET(req());
    expect((await res.json()).data).toMatchObject({ examinados: 1, abertos: 0 });
    expect(cap.avisos).toEqual([]);
  });

  it("FECHA o aviso quando o grafo passa a ser só texto fixo", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({
        ponteiros: [{ ...fluxo("f1", "silence"), active_version_id: "v1" }],
        versoes: [
          {
            id: "v1",
            graph: {
              nodes: [
                { id: "t1", type: "trigger" },
                { id: "a1", type: "action", config: { mode: "text" } },
              ],
            },
          },
        ],
        avisoAbertoDe: new Set(["f1"]),
        cap,
      }) as never,
    );

    const res = await GET(req());
    expect((await res.json()).data).toMatchObject({ abertos: 0, fechados: 1 });
    expect(cap.resolvidos).toEqual([{ status: "resolved" }]);
  });

  it("FECHA o aviso quando o vínculo com o agente aparece — o laço se completa", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({
        ponteiros: [fluxo("f1", "silence")],
        followupPorOrg: { [ORG]: arma("f1") },
        avisoAbertoDe: new Set(["f1"]),
        cap,
      }) as never,
    );

    const res = await GET(req());
    expect((await res.json()).data).toMatchObject({ abertos: 0, fechados: 1 });
    expect(cap.resolvidos).toEqual([{ status: "resolved" }]);
  });

  it("não abre um segundo aviso enquanto o primeiro está aberto", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({ ponteiros: [fluxo("f1", "silence")], avisoAbertoDe: new Set(["f1"]), cap }) as never,
    );

    const res = await GET(req());
    expect((await res.json()).data).toMatchObject({ abertos: 0, ja_abertos: 1 });
    expect(cap.avisos).toEqual([]);
  });

  it("o agente de uma organização não arma o fluxo de outra", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({
        ponteiros: [fluxo("f1", "silence", OUTRA_ORG)],
        // O vínculo existe, mas na organização errada.
        followupPorOrg: { [ORG]: arma("f1") },
        cap,
      }) as never,
    );

    await GET(req());
    expect(cap.avisos).toHaveLength(1);
    expect(cap.avisos[0]).toMatchObject({ organization_id: OUTRA_ORG, ref_id: "f1" });
  });

  it("rodada que não mexeu em nada NÃO audita", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      admin({
        ponteiros: [fluxo("f1", "silence")],
        followupPorOrg: { [ORG]: arma("f1") },
        cap: vazio(),
      }) as never,
    );

    await GET(req());
    expect(audit).not.toHaveBeenCalled();
  });

  it("rodada que abriu ou fechou aviso audita com os dois números", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      admin({ ponteiros: [fluxo("f1", "silence")], cap: vazio() }) as never,
    );

    await GET(req());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.followup_sem_agente_reconciliado",
        metadata: expect.objectContaining({ abertos: 1, fechados: 0 }),
      }),
    );
  });

  it("sem o segredo do cron, 403 e nenhuma leitura", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(admin({ ponteiros: [], cap }) as never);

    const res = await GET(new NextRequest("http://localhost/x"));
    expect(res.status).toBe(403);
    expect(cap.avisos).toEqual([]);
  });
});
