import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A aba Minhas IGNORA o atendente escolhido pelo gerente (a lista da aba pede
 * `assigned_to=me`, que vence a escolha). O badge dela tem de
 * ignorar também: com o atendente X escolhido numa outra aba, "Minhas" contava
 * `eu E X` — zero — e ao clicar a lista mostrava as conversas do gerente.
 * Badge que conta o que a aba não mostra é o defeito que a rota existe para impedir.
 */
const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const GERENTE = "0a0a0a0a-1111-4000-8000-000000000001";
const ATENDENTE = "0a0a0a0a-1111-4000-8000-000000000002";

type Linha = Record<string, unknown>;
let linhas: Linha[] = [];

/** Builder falso do supabase-js: aplica eq/in/not-in/gt sobre `linhas` e conta. */
function consulta(filtros: Array<(l: Linha) => boolean> = []) {
  const com = (f: (l: Linha) => boolean) => consulta([...filtros, f]);
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => com((l) => l[c] === v),
    in: (c: string, vs: unknown[]) => com((l) => vs.includes(l[c])),
    is: (c: string, v: unknown) => com((l) => (l[c] ?? null) === v),
    not: (c: string, _op: "in", lista: string) =>
      com((l) => !lista.slice(1, -1).split(",").includes(String(l[c]))),
    gt: (c: string, v: number) => com((l) => Number(l[c]) > v),
    or: () => q,
    then: (ok: (r: { count: number; error: null }) => unknown) =>
      Promise.resolve({ count: linhas.filter((l) => filtros.every((f) => f(l))).length, error: null }).then(ok),
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: GERENTE } }, error: null }) },
    from: () => consulta(),
  }),
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ id: GERENTE }) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: async () => ({ ok: true, org: { orgId: ORG, role: "manager" } }),
}));
vi.mock("@/lib/channels/desativado", () => ({ idsDosCanaisDesativados: async () => [] }));
vi.mock("@/lib/ai/agents/org-tem-automatico", () => ({ orgTemAutomatico: async () => false }));
// `idsDeContatosPessoaisVisiveis` (#4434) é novo no handler, e a rota de counts
// o chama em TODA leitura: sem ele no dublê o vitest explode antes do caso.
// Vazio é o cenário destes arquivos — nenhum contato pessoal marcado.
vi.mock("@/app/api/v1/conversations/_handler", () => ({
  idsDeContatosPessoais: async () => [],
  idsDeContatosPessoaisVisiveis: async () => [],
}));

const { GET } = await import("@/app/api/v1/conversations/counts/route");

async function contagens(qs: string) {
  const req = { nextUrl: new URL(`http://x/api/v1/conversations/counts?${qs}`) } as unknown as NextRequest;
  const corpo = (await (await GET(req)).json()) as { data: Record<string, number> };
  return corpo.data;
}

const conversa = (dono: string): Linha => ({
  organization_id: ORG,
  assigned_to_user_id: dono,
  status: "open",
  comando_da_conversa: "humano",
});

describe("filtro por atendente — o badge de Minhas espelha a aba Minhas", () => {
  beforeEach(() => {
    linhas = [conversa(GERENTE), conversa(GERENTE), conversa(ATENDENTE), conversa(ATENDENTE), conversa(ATENDENTE)];
  });

  it("CONTROLE: sem atendente escolhido, Minhas = as do gerente e Todas = todas", async () => {
    const c = await contagens("");
    expect(c.mine).toBe(2);
    expect(c.all).toBe(5);
  });

  it("com o atendente escolhido, Todas conta só as dele e Minhas continua as do gerente", async () => {
    const c = await contagens(`assigned_to=${ATENDENTE}`);
    expect(c.all).toBe(3);
    expect(c.mine).toBe(2);
  });
});
