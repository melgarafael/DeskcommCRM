/**
 * O AVISO DA CENTRAL COM DONO (#2529, doc de decisão 162, migration 0689).
 *
 * Duas pessoas da MESMA empresa, Ana e Bruno, cada uma com o seu aviso de prazo
 * de tarefa (`para_user_id`), mais um aviso da empresa (`para_user_id` nulo) e
 * um da organização vizinha. Mede-se o que SOBRA, numa tabela em memória que
 * APLICA os predicados (`.eq` e o `.or` do PostgREST): o admin é service role e
 * bypassa RLS, então o filtro que a rota escreve é a única cerca — espiar
 * argumento provaria a chamada, não o efeito.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PATCH } from "@/app/api/v1/ai/inbox/[id]/route";
import { POST as resolverTodos } from "@/app/api/v1/ai/inbox/resolve-all/route";
import { GET } from "@/app/api/v1/ai/inbox/route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const VIZINHA = "99999999-9999-4999-8999-999999999999";
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRUNO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID = {
  empresa: "00000000-0000-4000-8000-000000000001",
  daAna: "00000000-0000-4000-8000-000000000002",
  doBruno: "00000000-0000-4000-8000-000000000003",
  vizinha: "00000000-0000-4000-8000-000000000004",
};

type Linha = Record<string, string | null>;
let tabela: Linha[];

const base = { severity: "warn", body: null, created_at: "2026-10-16T12:00:00Z" };
function semear() {
  tabela = [
    { ...base, id: ID.empresa, organization_id: ORG, para_user_id: null, kind: "handoff", title: "Da empresa", ref_kind: null, ref_id: null, status: "open" },
    { ...base, id: ID.daAna, organization_id: ORG, para_user_id: ANA, kind: "task_due", title: "Ligar para o cliente", ref_kind: "task", ref_id: "t-ana", status: "open" },
    { ...base, id: ID.doBruno, organization_id: ORG, para_user_id: BRUNO, kind: "task_overdue", title: "Enviar contrato", ref_kind: "task", ref_id: "t-bruno", status: "open" },
    { ...base, id: ID.vizinha, organization_id: VIZINHA, para_user_id: ANA, kind: "task_due", title: "De outra org", ref_kind: "task", ref_id: "t-viz", status: "open" },
  ];
}

/** `a.is.null,a.eq.x` → OR dos termos — o subconjunto do PostgREST que a rota usa. */
function casaOr(linha: Linha, filtro: string): boolean {
  return filtro.split(",").some((termo) => {
    const [coluna, op, ...resto] = termo.split(".");
    const valor = resto.join(".");
    if (op === "is" && valor === "null") return linha[coluna!] === null;
    if (op === "eq") return linha[coluna!] === valor;
    throw new Error(`termo não suportado pelo dublê: ${termo}`);
  });
}

function admin() {
  return {
    from(nome: string) {
      expect(nome).toBe("agent_inbox_items");
      const eqs: Array<[string, unknown]> = [];
      const ors: string[] = [];
      let patch: Linha | null = null;
      let soContar = false;
      const alvo = () =>
        tabela.filter((l) => eqs.every(([c, v]) => l[c] === v) && ors.every((f) => casaOr(l, f)));
      const resultado = () => {
        const linhas = alvo();
        if (patch) for (const l of linhas) Object.assign(l, patch);
        return soContar
          ? { data: null, count: linhas.length, error: null }
          : { data: linhas.map((l) => ({ ...l })), error: null };
      };
      const cadeia = {
        select(_c?: string, opts?: { head?: boolean }) {
          soContar = Boolean(opts?.head);
          return cadeia;
        },
        update(p: Linha) {
          patch = p;
          return cadeia;
        },
        eq(c: string, v: unknown) {
          eqs.push([c, v]);
          return cadeia;
        },
        or(f: string) {
          ors.push(f);
          return cadeia;
        },
        order: () => cadeia,
        limit: () => cadeia,
        maybeSingle: async () => {
          const r = resultado();
          return { data: r.data?.[0] ?? null, error: null };
        },
        then: (resolve: (r: unknown) => unknown) => Promise.resolve(resultado()).then(resolve),
      };
      return cadeia;
    },
  };
}

/** Leitura autenticada dos destinos: devolve zero linhas, e o destino fica indisponível. */
function autenticado() {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    in: () => cadeia,
    then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return { from: () => cadeia };
}

function comoUsuario(userId: string) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "agent", name: "Org" },
    user: { id: userId, idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
}

async function centralDe(userId: string) {
  comoUsuario(userId);
  const r = await GET(new NextRequest("http://localhost/api/v1/ai/inbox"));
  expect(r.status).toBe(200);
  const { data } = await r.json();
  return { ids: (data.items as { id: string }[]).map((i) => i.id).sort(), aberto: data.open_count as number };
}

const statusDe = (id: string) => tabela.find((l) => l.id === id)!.status;

beforeEach(() => {
  vi.clearAllMocks();
  semear();
  vi.mocked(createAdminClient).mockImplementation(() => admin() as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(createClient).mockResolvedValue(autenticado() as unknown as Awaited<ReturnType<typeof createClient>>);
});

describe("Central: o aviso com destinatário é só dele", () => {
  it("cada pessoa vê o aviso da empresa e o SEU — nunca o do colega nem o da outra org", async () => {
    expect(await centralDe(ANA)).toEqual({ ids: [ID.empresa, ID.daAna].sort(), aberto: 2 });
    expect(await centralDe(BRUNO)).toEqual({ ids: [ID.empresa, ID.doBruno].sort(), aberto: 2 });
  });

  it("o 'Marcar todos resolvidos' da Ana não resolve o aviso do Bruno", async () => {
    comoUsuario(ANA);
    const r = await resolverTodos();
    expect((await r.json()).data).toEqual({ resolved_count: 2 });
    expect(statusDe(ID.empresa)).toBe("resolved");
    expect(statusDe(ID.daAna)).toBe("resolved");
    expect(statusDe(ID.doBruno), "o lote alcançou o aviso pessoal do colega").toBe("open");
    expect(statusDe(ID.vizinha), "o lote alcançou a organização vizinha").toBe("open");
    expect((await centralDe(BRUNO)).aberto).toBe(1);
  });

  it("resolver um aviso: o do colega é 404 e não muda; o próprio resolve", async () => {
    comoUsuario(ANA);
    const patch = (id: string) =>
      PATCH(
        new NextRequest(`http://localhost/api/v1/ai/inbox/${id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }),
        { params: Promise.resolve({ id }) },
      );
    expect((await patch(ID.doBruno)).status).toBe(404);
    expect(statusDe(ID.doBruno)).toBe("open");
    expect((await patch(ID.daAna)).status).toBe(200);
    expect(statusDe(ID.daAna)).toBe("resolved");
  });
});
