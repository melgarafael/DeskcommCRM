import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CONVIDADA acha a conversa na aba "Minhas" (issue #2848, CR do mantenedor).
 *
 * O CR provou com 4 contas: quem é convidado para participar de uma conversa
 * ASSIGNADA A OUTRO não a achava — a aba Minhas filtrava só em
 * `assigned_to_user_id = eu`, e a participação não estava na régua. O conserto
 * é o `or=` (assigned OU id em participadas) na lista e no badge.
 *
 * Este teste é o que o mock antigo não conseguia ver: o builder de antes não
 * tinha `.is`, então a busca de participações caía no `catch` e o caminho novo
 * nem rodava — vermelho não aparecia, falso verde aparecia.
 */
const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const CONVIDADA = "0a0a0a0a-2222-4000-8000-000000000001";
const DONA = "0a0a0a0a-2222-4000-8000-000000000002";

const C1 = "1a1a1a1a-0000-4000-8000-000000000001"; // de outra, eu não participo
const C2 = "1a1a1a1a-0000-4000-8000-000000000002"; // minha (assigned = eu)
const C3 = "1a1a1a1a-0000-4000-8000-000000000003"; // de outra, participo ATIVA
const C4 = "1a1a1a1a-0000-4000-8000-000000000004"; // de outra, parti e SAI

type Linha = Record<string, unknown>;

let tabelas: Record<string, Linha[]> = {};

/** Builder falso do supabase-js com `.is` e `.or` APLICANDO o filtro. */
function consulta(nome: string, filtros: Array<(l: Linha) => boolean> = []) {
  const linhas = tabelas[nome] ?? [];
  const com = (f: (l: Linha) => boolean) => consulta(nome, [...filtros, f]);
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => com((l) => l[c] === v),
    is: (c: string, v: unknown) => com((l) => (v === null ? l[c] == null : l[c] === v)),
    in: (c: string, vs: unknown[]) => com((l) => vs.includes(l[c])),
    not: (c: string, _op: "in", lista: string) =>
      com((l) => !lista.slice(1, -1).split(",").includes(String(l[c]))),
    gt: (c: string, v: number) => com((l) => Number(l[c]) > v),
    // A gramática que a rota manda: `a.eq.X,b.in.(y,z)`. Se um dia a rota
    // mandar outra, o throw abaixo é o teste dizendo que não acompanhou.
    or: (expr: string) => {
      const m = expr.match(/^([a-z_]+)\.eq\.([^,]+),([a-z_]+)\.in\.\(([^)]*)\)$/);
      if (!m) throw new Error(`padrao de .or() nao reconhecido pelo mock: ${expr}`);
      const [, c1, v1, c2, lista] = m;
      return com(
        (l) => l[c1 as string] === v1 || lista!.split(",").includes(String(l[c2 as string])),
      );
    },
    // `data` importa: a busca de participacoes faz `participadas.data ?? []`,
    // e sem ele o try/catch vira `idsParticipadas = []` — falso verde com o
    // caminho antigo. Por isso o mock antigo nunca mostrou o defeito do #2848.
    then: (ok: (r: { count: number; error: null; data: Linha[] }) => unknown) =>
      Promise.resolve({
        count: linhas.filter((l) => filtros.every((f) => f(l))).length,
        error: null,
        data: linhas.filter((l) => filtros.every((f) => f(l))),
      }).then(ok),
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: CONVIDADA } }, error: null }) },
    from: (nome: string) => consulta(nome),
  }),
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ id: CONVIDADA }) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: async () => ({ ok: true, org: { orgId: ORG, role: "manager" } }),
}));
vi.mock("@/lib/channels/desativado", () => ({ idsDosCanaisDesativados: async () => [] }));
vi.mock("@/lib/ai/agents/org-tem-automatico", () => ({ orgTemAutomatico: async () => false }));
vi.mock("@/app/api/v1/conversations/_handler", () => ({ idsDeContatosPessoais: async () => [] }));

const { GET } = await import("@/app/api/v1/conversations/counts/route");

async function contagens(qs: string) {
  const req = { nextUrl: new URL(`http://x/api/v1/conversations/counts?${qs}`) } as unknown as NextRequest;
  const corpo = (await (await GET(req)).json()) as { data: Record<string, number> };
  return corpo.data;
}

const conversa = (id: string, dono: string): Linha => ({
  id,
  organization_id: ORG,
  assigned_to_user_id: dono,
  status: "open",
  channel_id: "canal-1",
  updated_at: Date.now() - 1000,
});

beforeEach(() => {
  tabelas = {
    conversations: [
      conversa(C1, DONA),
      conversa(C2, CONVIDADA),
      conversa(C3, DONA),
      conversa(C4, DONA),
    ],
    conversation_participants: [
      { organization_id: ORG, conversation_id: C3, user_id: CONVIDADA, left_at: null },
      { organization_id: ORG, conversation_id: C4, user_id: CONVIDADA, left_at: "2026-10-01T00:00:00Z" },
    ],
  };
});

describe("a aba Minhas da CONVIDADA (participação conta, saída não)", () => {
  it("acha a conversa participada e a própria; não a dos outros nem a de onde saí", async () => {
    const { mine } = await contagens("assigned_to=me");
    // C2 (minha) + C3 (participo). C1 (de outra, sem convite) e C4 (saí) ficam fora.
    expect(mine, "Minhas precisa espelhar o que a lista mostra").toBe(2);
  });

  it("sem participação ativa, Minhas volta a ser só as assigned", async () => {
    tabelas.conversation_participants = [];
    const { mine } = await contagens("assigned_to=me");
    expect(mine, "sem participações o caminho é o antigo (.eq)").toBe(1);
  });

  it("a busca de participações NÃO derruba o badge quando a tabela não existe", async () => {
    // `42P01`/erro de schema: o caminho novo cai no antigo, nunca em 500.
    delete tabelas.conversation_participants;
    const { mine } = await contagens("assigned_to=me");
    expect(mine).toBe(1);
  });
});
