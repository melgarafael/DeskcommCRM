/**
 * SKILLS POR AGENTE: O QUE ENTRA NA VERSÃO É CONFERIDO (frente F3, 9107).
 *
 * `skill_names` é escopo da versão como funis e materiais. Um nome que não existe
 * publicado sem erro seria a configuração MUDA de `escopo.ts`: a tela mostra a
 * marcação, o agente não tem a skill, e ninguém vê erro. Então:
 *
 *  - o schema aceita `null` (todas, o padrão) e `[]` (nenhuma), limita o tamanho
 *    e junta repetidos;
 *  - `validarEscopoDaVersao` confere os nomes contra as skills da organização E
 *    as de plataforma (que valem sem instalar);
 *  - o PATCH da API repassa o campo para a conferência e grava;
 *  - a criação canônica (`createMcpAgentDraft`, usada pela prospecção) confere
 *    também — ela não passa por `validarEscopoDaVersao`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import { versionCreateSchema, versionPatchSchema } from "@/lib/ai/agents/validation";
import { createMcpAgentDraft } from "@/lib/ai/agents/create-draft";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENTE = "33333333-3333-4333-8333-333333333333";
const VERSAO = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;

/** Ponteiros: um da org, um de plataforma (null) e um de OUTRA org. */
const PONTEIROS: Linha[] = [
  { organization_id: ORG, name: "visita-ao-imovel" },
  { organization_id: null, name: "agendamento" },
  { organization_id: OUTRA_ORG, name: "so-da-vizinha" },
];

/** Banco de mentira que filtra como o PostgREST: `eq`, `in` e o `or` de organização. */
function bancoFalso(escritas: Array<{ tabela: string; valor: Linha }>) {
  const tabelas: Record<string, Linha[]> = {
    skill_pointers: PONTEIROS,
    ai_agent_versions: [{ id: VERSAO, organization_id: ORG, agent_id: AGENTE, status: "draft", followup: {} }],
  };
  return {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      let carga: Linha | null = null;
      const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
        or: (expr: string) => {
          const m = /^organization_id\.eq\.([^,]+),organization_id\.is\.null$/.exec(expr);
          if (!m) throw new Error(`filtro or inesperado: ${expr}`);
          filtros.push((l) => l.organization_id === m[1] || l.organization_id === null);
          return q;
        },
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        single: async () => ({ data: { ...(linhas()[0] ?? {}), ...(carga ?? {}) }, error: null }),
        update: (v: Linha) => ((carga = v), escritas.push({ tabela, valor: v }), q),
        then: (r: (x: unknown) => unknown) => r({ data: linhas(), error: null }),
      };
      return q;
    },
  };
}

const escritas: Array<{ tabela: string; valor: Linha }> = [];

beforeEach(() => {
  escritas.length = 0;
  vi.mocked(createAdminClient).mockReturnValue(bancoFalso(escritas) as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
});

const BASE = {
  system_prompt: "Você é um atendente de testes.",
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  credential_id: null,
  channel_session_id: null,
};

describe("schema da versão", () => {
  it("sem o campo, o padrão é null = todas (o comportamento de antes)", () => {
    const v = versionCreateSchema.parse(BASE);
    expect(v.skill_names).toBeNull();
  });

  it("[] passa (nenhuma) e repetidos viram um", () => {
    expect(versionCreateSchema.parse({ ...BASE, skill_names: [] }).skill_names).toEqual([]);
    expect(
      versionCreateSchema.parse({ ...BASE, skill_names: ["agendamento", " agendamento "] }).skill_names,
    ).toEqual(["agendamento"]);
  });

  it("mais de 100 nomes, ou nome vazio, é recusado", () => {
    const muitos = Array.from({ length: 101 }, (_, i) => `s${i}`);
    expect(versionCreateSchema.safeParse({ ...BASE, skill_names: muitos }).success).toBe(false);
    expect(versionCreateSchema.safeParse({ ...BASE, skill_names: ["  "] }).success).toBe(false);
  });

  it("o PATCH sem o campo não o toca (não vira null por default)", () => {
    expect(versionPatchSchema.parse({ max_steps: 5 })).not.toHaveProperty("skill_names");
  });
});

describe("validarEscopoDaVersao — skill_names", () => {
  const db = () => bancoFalso([]) as never;

  it("null e [] passam sem consulta de nome", async () => {
    expect(await validarEscopoDaVersao(db(), ORG, { skill_names: null })).toEqual({ ok: true });
    expect(await validarEscopoDaVersao(db(), ORG, { skill_names: [] })).toEqual({ ok: true });
  });

  it("skill da org e skill de plataforma (não instalada) passam", async () => {
    expect(
      await validarEscopoDaVersao(db(), ORG, { skill_names: ["visita-ao-imovel", "agendamento"] }),
    ).toEqual({ ok: true });
  });

  it("nome inexistente, ou de OUTRA organização, é recusado com o campo e os ausentes", async () => {
    const r = await validarEscopoDaVersao(db(), ORG, {
      skill_names: ["agendamneto", "so-da-vizinha", "agendamento"],
    });
    expect(r).toEqual({ ok: false, campo: "skill_names", ausentes: ["agendamneto", "so-da-vizinha"] });
    if (r.ok) return;
    expect(mensagemDoEscopo(r)).toContain("skills marcadas não existe mais");
  });
});

describe("PATCH /ai/agents/:id/versions/:vid — skill_names", () => {
  async function patch(corpo: Linha) {
    const { PATCH } = await import("@/app/api/v1/ai/agents/[id]/versions/[vid]/route");
    return PATCH(
      new NextRequest("http://localhost/api/v1/ai/agents/x/versions/y", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      }),
      { params: Promise.resolve({ id: AGENTE, vid: VERSAO }) },
    );
  }

  it("grava a lista quando os nomes existem", async () => {
    const r = await patch({ skill_names: ["agendamento"] });
    expect(r.status).toBe(200);
    expect(escritas).toEqual([{ tabela: "ai_agent_versions", valor: { skill_names: ["agendamento"] } }]);
  });

  it("grava null (voltar a todas)", async () => {
    const r = await patch({ skill_names: null });
    expect(r.status).toBe(200);
    expect(escritas).toEqual([{ tabela: "ai_agent_versions", valor: { skill_names: null } }]);
  });

  it("recusa nome inexistente com 422 validation_failed, sem gravar nada", async () => {
    const r = await patch({ skill_names: ["agendamneto"] });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("validation_failed");
    expect(escritas).toEqual([]);
  });
});

describe("createMcpAgentDraft — a criação canônica também confere", () => {
  function dbFalso(skillsQueExistem: string[]) {
    const sqls: string[] = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      sqls.push(sql);
      if (sql.includes("from skill_pointers")) {
        const pedidos = params[1] as string[];
        return { rows: pedidos.filter((n) => skillsQueExistem.includes(n)).map((name) => ({ name })) };
      }
      if (sql.startsWith("insert into ai_agents")) return { rows: [{ id: "a" }] };
      if (sql.startsWith("insert into ai_agent_versions")) return { rows: [{ id: "v" }] };
      return { rows: [] };
    });
    return { db: { query } as never, sqls };
  }
  const corpo = (skill_names: string[] | null) => ({ name: "Agente", version: { ...BASE, skill_names } });

  it("nome inexistente lança skill_scope_invalid antes de qualquer INSERT", async () => {
    const { db, sqls } = dbFalso(["agendamento"]);
    await expect(
      createMcpAgentDraft(db, { orgId: ORG, userId: USER }, corpo(["agendamneto"])),
    ).rejects.toThrow("skill_scope_invalid");
    expect(sqls.some((s) => s.startsWith("insert into"))).toBe(false);
  });

  it("nome existente (inclusive de plataforma) cria normalmente", async () => {
    const { db, sqls } = dbFalso(["agendamento"]);
    await createMcpAgentDraft(db, { orgId: ORG, userId: USER }, corpo(["agendamento"]));
    expect(sqls.some((s) => s.startsWith("insert into ai_agent_versions"))).toBe(true);
  });

  it("null (todas) não consulta skill nenhuma", async () => {
    const { db, sqls } = dbFalso([]);
    await createMcpAgentDraft(db, { orgId: ORG, userId: USER }, corpo(null));
    expect(sqls.some((s) => s.includes("from skill_pointers"))).toBe(false);
  });
});
