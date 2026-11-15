/**
 * #3945 (fatia 2) — O NOME DO RESPONSÁVEL HUMANO NO CARD DO FUNIL, por quadro.
 *
 * Na rota de verdade (dublê que APLICA os filtros), com o admin client trocado
 * por um que imita `fn_nomes_dos_membros` (só quem tem vínculo com a `p_org`
 * pedida ganha linha — a regra real é provada no banco por
 * `tests/invariants/nomes-dos-membros.test.ts`) e `user_organizations`.
 *
 *  1. o card do dono humano traz `owner_user_name`;
 *  2. **contagem**: 2 e 12 negócios custam as MESMAS leituras — uma chamada à
 *     função e uma aos vínculos, nunca uma por card nem por dono;
 *  3. **isolamento**: a organização pedida é a do funil, e o nome de quem só
 *     tem vínculo com OUTRA organização não aparece; e-mail nunca aparece;
 *  4. **saiu da equipe**: o nome fica e o card ganha `owner_user_removed`;
 *  5. **sem responsável** / sem service role / falha: nada quebra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    idioma: "pt-BR",
  })),
}));

interface Membro {
  org: string;
  user_id: string;
  full_name: string | null;
  revoked_at: string | null;
}

const admin = vi.hoisted(() => ({
  membros: [] as Membro[],
  chamadas: [] as string[],
  falhar: false,
  comChave: true,
}));

vi.mock("@/lib/audit", async (original) => ({
  ...((await original()) as object),
  isServiceRoleConfigured: () => admin.comChave,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: async (fn: string, args: { p_org: string; p_ids: string[] }) => {
      admin.chamadas.push(`rpc:${fn}:${args.p_org}`);
      if (admin.falhar) return { data: null, error: { message: "boom" } };
      const linhas = admin.membros
        .filter((m) => m.org === args.p_org && args.p_ids.includes(m.user_id))
        .map((m) => ({ user_id: m.user_id, full_name: m.full_name, email: `${m.user_id}@exemplo.com` }));
      return { data: linhas, error: null };
    },
    from: (tabela: string) => {
      let org = "";
      const q = {
        select: () => q,
        eq: (col: string, valor: string) => {
          if (col === "organization_id") org = valor;
          return q;
        },
        in: async (_col: string, ids: string[]) => {
          admin.chamadas.push(`from:${tabela}:${org}`);
          if (admin.falhar) return { data: null, error: { message: "boom" } };
          return {
            data: admin.membros
              .filter((m) => m.org === org && ids.includes(m.user_id))
              .map((m) => ({ user_id: m.user_id, revoked_at: m.revoked_at })),
            error: null,
          };
        },
      };
      return q;
    },
  })),
}));

import { resolveLeadOwner } from "@/lib/kanban/owner";
import type { Lead } from "@/lib/types/leads";
import {
  ORG_ID,
  OUTRA_ORG,
  PIPE,
  etapa,
  funilRow,
  makeDb,
  negocio,
  type LeadRow,
  type Registro,
} from "@/tests/helpers/stages-db-double";

const STAGE = "e1";

/** Negócio ABERTO com dono humano (o quadro lê com `.neq("status", "archived")`). */
function doDono(id: string, userId: string, position: number): LeadRow {
  return negocio(id, STAGE, {
    status: "open",
    owner_kind: "user",
    owner_user_id: userId,
    position_in_stage: position,
  });
}

const membro = (user_id: string, full_name: string | null, over: Partial<Membro> = {}): Membro => ({
  org: ORG_ID,
  user_id,
  full_name,
  revoked_at: null,
  ...over,
});

function dbDoQuadro(leads: LeadRow[]): Registro {
  return makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: { fields: [], lost_reasons: [] } })],
    stages: [etapa({ id: STAGE, name: "Novo" })],
    leads,
  });
}

type LeadDoCorpo = { id: string; owner_user_name?: string | null; owner_user_removed?: boolean };

async function leQuadro(): Promise<{ status: number; leads: LeadDoCorpo[] }> {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board`), {
    params: Promise.resolve({ id: PIPE }),
  });
  const body = (await res.json()) as { data?: { leads: LeadDoCorpo[] } };
  return { status: res.status, leads: body.data?.leads ?? [] };
}

const doCard = (leads: LeadDoCorpo[], id: string) => leads.find((l) => l.id === id);

beforeEach(() => {
  admin.membros = [];
  admin.chamadas = [];
  admin.falhar = false;
  admin.comChave = true;
});

describe("GET /board — o nome do responsável humano (#3945, fatia 2)", () => {
  it("⭐ o card do dono humano traz o NOME no payload — resolvido no servidor", async () => {
    admin.membros = [membro("u-ana", "Ana   Souza"), membro("u-beto", "Beto Lima")];
    dbDoQuadro([doDono("n-1", "u-ana", 10), doDono("n-2", "u-beto", 20)]);

    const { status, leads } = await leQuadro();

    expect(status).toBe(200);
    expect(doCard(leads, "n-1")?.owner_user_name).toBe("Ana Souza");
    expect(doCard(leads, "n-2")?.owner_user_name).toBe("Beto Lima");
    expect(doCard(leads, "n-1")?.owner_user_removed).toBeUndefined();
  });

  it("⭐ 2 e 12 negócios custam as MESMAS leituras (sem N+1)", async () => {
    admin.membros = Array.from({ length: 12 }, (_, i) => membro(`u-${i + 1}`, `Pessoa ${i + 1}`));
    const dois = [doDono("n-1", "u-1", 10), doDono("n-2", "u-2", 20)];
    const doze = Array.from({ length: 12 }, (_, i) => doDono(`n-${i + 1}`, `u-${i + 1}`, (i + 1) * 10));

    const pequeno = dbDoQuadro(dois);
    await leQuadro();
    const chamadasPequeno = [...admin.chamadas];
    admin.chamadas = [];
    const grande = dbDoQuadro(doze);
    const { leads } = await leQuadro();

    expect(doCard(leads, "n-12")?.owner_user_name).toBe("Pessoa 12");
    expect(grande.leituras.length).toBe(pequeno.leituras.length);
    expect(admin.chamadas).toEqual(chamadasPequeno);
    expect(admin.chamadas).toHaveLength(2);
  });

  it("⭐ o nome de OUTRA organização não aparece, e e-mail nunca aparece", async () => {
    admin.membros = [
      // Só tem vínculo com a outra organização.
      membro("u-carla", "Carla Externa", { org: OUTRA_ORG }),
      // O controle.
      membro("u-duda", "Duda Real"),
    ];
    dbDoQuadro([doDono("n-carla", "u-carla", 10), doDono("n-duda", "u-duda", 20)]);

    const { status, leads } = await leQuadro();

    expect(status).toBe(200);
    expect(doCard(leads, "n-duda")?.owner_user_name).toBe("Duda Real");
    expect(doCard(leads, "n-carla")?.owner_user_name).toBeNull();
    // A organização pedida é a do funil — nunca outra.
    expect(admin.chamadas.every((c) => c.endsWith(`:${ORG_ID}`))).toBe(true);
    expect(JSON.stringify(leads)).not.toContain("Carla Externa");
    expect(JSON.stringify(leads)).not.toContain("@exemplo.com");
  });

  it("⭐ quem saiu da equipe: o nome fica e o card avisa; sem vínculo nenhum, idem sem nome", async () => {
    admin.membros = [membro("u-bia", "Bia Antiga", { revoked_at: "2026-10-01T00:00:00Z" })];
    dbDoQuadro([doDono("n-bia", "u-bia", 10), doDono("n-sumiu", "u-sumiu", 20)]);

    const { status, leads } = await leQuadro();

    expect(status).toBe(200);
    expect(doCard(leads, "n-bia")).toMatchObject({ owner_user_name: "Bia Antiga", owner_user_removed: true });
    expect(doCard(leads, "n-sumiu")).toMatchObject({ owner_user_name: null, owner_user_removed: true });
    const card = resolveLeadOwner(doCard(leads, "n-bia") as unknown as Lead, undefined);
    expect(card).toEqual({ kind: "user", name: "Bia Antiga", agentVersion: null, foraDaEquipe: true });
  });

  it("⭐ sem nome utilizável: `null` e o card cai no rótulo anterior — nunca undefined", async () => {
    admin.membros = [membro("u-carla", null), membro("u-eva", "eva@exemplo.com")];
    dbDoQuadro([doDono("n-1", "u-carla", 10), doDono("n-2", "u-eva", 20)]);

    const { leads } = await leQuadro();

    expect(doCard(leads, "n-1")?.owner_user_name).toBeNull();
    expect(doCard(leads, "n-2")?.owner_user_name).toBeNull();
    expect(JSON.stringify(leads)).not.toContain("eva@exemplo.com");
    const semNome = doCard(leads, "n-1") as unknown as Lead;
    expect(resolveLeadOwner(semNome, new Map([["u-carla", "Carla Dias"]])).name).toBe("Carla Dias");
    expect(resolveLeadOwner(semNome, undefined).name).toBeNull();
  });

  it("quadro sem dono humano não consulta nome nenhum", async () => {
    makeDb({
      pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: { fields: [], lost_reasons: [] } })],
      stages: [etapa({ id: STAGE, name: "Novo" })],
      leads: [negocio("n-1", STAGE, { status: "open", position_in_stage: 10 })],
    });

    const { status } = await leQuadro();

    expect(status).toBe(200);
    expect(admin.chamadas).toEqual([]);
  });

  it("sem service role: nenhuma chamada, o campo não vem e o quadro abre", async () => {
    admin.comChave = false;
    admin.membros = [membro("u-ana", "Ana Souza")];
    dbDoQuadro([doDono("n-1", "u-ana", 10)]);

    const { status, leads } = await leQuadro();

    expect(status).toBe(200);
    expect(admin.chamadas).toEqual([]);
    expect(doCard(leads, "n-1")?.owner_user_name).toBeUndefined();
  });

  it("falha das leituras não derruba o quadro nem marca ninguém como fora da equipe", async () => {
    admin.falhar = true;
    admin.membros = [membro("u-ana", "Ana Souza")];
    dbDoQuadro([doDono("n-1", "u-ana", 10)]);

    const { status, leads } = await leQuadro();

    expect(status).toBe(200);
    expect(doCard(leads, "n-1")?.owner_user_name).toBeNull();
    expect(doCard(leads, "n-1")?.owner_user_removed).toBeUndefined();
  });
});
