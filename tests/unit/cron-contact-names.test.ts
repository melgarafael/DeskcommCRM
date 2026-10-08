import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O cron que copia o nome salvo na agenda do celular para a ficha.
 *
 * O webhook só traz o apelido do perfil. Contato salvo no aparelho chega na
 * inbox como telefone. Duas regras, as mesmas do irmão que descobre o número:
 * anonimizado nunca é tocado, e a tentativa é carimbada mesmo sem nome — senão
 * a fila não gira.
 */

const ops: { tabela: string; op: string; payload?: unknown; filtros: [string, unknown][] }[] = [];
let contatos: Record<string, unknown>[] = [];
let sessao: Record<string, unknown> | null = null;
let agenda: { agenda: string | null; perfil: string | null } | null = { agenda: "Cliente da obra", perfil: null };
let lookupLanca = false;
let aoConsultar: () => void = () => {};
const auditou = vi.fn();

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const filtros: [string, unknown][] = [];
  const registro = { tabela, op, payload, filtros };
  ops.push(registro);
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (okFn: (v: unknown) => unknown) =>
            okFn(
              tabela === "contacts" && op === "select"
                ? { data: contatos, error: null }
                : { data: [{ id: "x" }], error: null },
            );
        }
        if (prop === "maybeSingle") {
          return async () => ({
            data: sessao ? { channel_sessions: sessao } : null,
            error: null,
          });
        }
        return (...args: unknown[]) => {
          if (["eq", "is", "not", "or"].includes(String(prop))) {
            filtros.push([`${String(prop)}:${String(args[0])}`, args[1]]);
          }
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => chain(tabela, "select"),
      update: (payload: unknown) => chain(tabela, "update", payload),
    }),
  }),
}));

vi.mock("@/lib/channels", async (orig) => {
  const real = await orig<typeof import("@/lib/channels")>();
  return {
    ...real,
    getAdapter: () => ({
      provider: "waha",
      resolveAddressBookName: async () => {
        aoConsultar();
        if (lookupLanca) throw new Error("rede caiu");
        return agenda;
      },
    }),
  };
});

vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "s3cr3t", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { GET } = await import("@/app/api/v1/cron/contact-names/route");

const chamar = (secret = "s3cr3t") =>
  GET(
    new Request("http://localhost/api/v1/cron/contact-names", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }) as never,
  );

const filtrosDo = (op: string) =>
  ops.filter((o) => o.tabela === "contacts" && o.op === op).flatMap((o) => o.filtros.map(([k]) => k));

beforeEach(() => {
  ops.length = 0;
  auditou.mockClear();
  contatos = [
    {
      id: "c1",
      organization_id: "org",
      phone_number: "+5562984480025",
      wa_lid: null,
      wa_identity: "phone:+5562984480025",
      name: null,
      display_name: null,
      address_book_name: null,
      organizations: { status: "active" },
    },
  ];
  sessao = { provider: "waha", waha_session_name: "sess", status: "WORKING", archived_at: null };
  agenda = { agenda: "Cliente da obra", perfil: null };
  lookupLanca = false;
  aoConsultar = () => {};
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("sem segredo é 403 e NÃO varre nada", async () => {
    const r = await chamar("");
    expect(r.status).toBe(403);
    expect(ops).toHaveLength(0);
    expect(auditou).not.toHaveBeenCalled();
  });
});

describe("o nome da agenda", () => {
  it("grava o nome salvo no campo da equipe e carimba a tentativa", async () => {
    const r = await chamar();
    expect(await r.json()).toMatchObject({ data: { preenchidos: 1 } });
    const up = ops.find((o) => o.tabela === "contacts" && o.op === "update");
    expect(up?.payload).toMatchObject({ address_book_name: "Cliente da obra" });
    expect(up?.payload).toHaveProperty("name_lookup_at");
  });

  it("o nome da agenda NUNCA vai para name nem display_name (é o que o {{nome}} lê)", async () => {
    agenda = { agenda: "Maria caloteira", perfil: "Maria" };
    await chamar();
    const ups = ops.filter((o) => o.tabela === "contacts" && o.op === "update");
    expect(ups).toHaveLength(1);
    const payload = ups[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("name");
    expect(payload.display_name).not.toBe("Maria caloteira");
    expect(JSON.stringify({ ...payload, address_book_name: undefined })).not.toContain("caloteira");
  });

  it("não substitui nome que a ficha ganhou no meio do lote", async () => {
    await chamar();
    expect(filtrosDo("update")).toContain("is:name");
    expect(filtrosDo("update")).toContain("is:address_book_name");
  });

  it("sem nome na agenda carimba e não inventa", async () => {
    agenda = { agenda: null, perfil: null };
    const r = await chamar();
    expect(await r.json()).toMatchObject({ data: { sem_nome: 1, preenchidos: 0 } });
    const up = ops.find((o) => o.tabela === "contacts" && o.op === "update");
    expect(up?.payload).not.toHaveProperty("name");
    expect(up?.payload).not.toHaveProperty("address_book_name");
    expect(up?.payload).toHaveProperty("name_lookup_at");
    expect(auditou).not.toHaveBeenCalled();
  });

  it("rodada que preencheu alguém deixa rastro", async () => {
    await chamar();
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "contact.address_book_name_filled",
      organizationId: "org",
      metadata: { preenchidos: 1 },
    });
  });

  it("audita uma linha por empresa, na trilha de cada uma", async () => {
    const base = contatos[0]!;
    contatos = [base, { ...base, id: "c2", organization_id: "org-b" }, { ...base, id: "c3" }];
    await chamar();
    const porOrg = auditou.mock.calls.map((c) => [
      (c[0] as { organizationId: string }).organizationId,
      (c[0] as { metadata: { preenchidos: number } }).metadata.preenchidos,
    ]);
    expect(porOrg.sort()).toEqual([
      ["org", 2],
      ["org-b", 1],
    ]);
  });

  it("lookup que lança não derruba o lote e carimba", async () => {
    lookupLanca = true;
    const r = await chamar();
    expect(r.status).toBe(200);
    expect(ops.some((o) => o.tabela === "contacts" && o.op === "update")).toBe(true);
  });
});

describe("LGPD e escopo", () => {
  it("não varre anonimizado e confere de novo na gravação", async () => {
    await chamar();
    expect(filtrosDo("select")).toContain("eq:is_anonymized");
    expect(filtrosDo("update")).toContain("eq:is_anonymized");
  });

  it("só ficha de pessoa ainda sem nome", async () => {
    await chamar();
    const f = filtrosDo("select");
    expect(f).toContain("is:name");
    expect(f).toContain("is:address_book_name");
    expect(f).toContain("eq:kind");
  });

  it("deixa de fora o contato pessoal, na seleção e na gravação", async () => {
    await chamar();
    expect(filtrosDo("select")).toContain("eq:is_personal");
    expect(filtrosDo("update")).toContain("eq:is_personal");
  });

  it("empresa parada fica fora da seleção, no banco e no cinto", async () => {
    await chamar();
    expect(filtrosDo("select")).toContain("eq:organizations.status");

    ops.length = 0;
    contatos = [{ ...contatos[0]!, organizations: { status: "suspended" } }];
    const r = await chamar();
    expect(await r.json()).toMatchObject({ data: { varridos: 0, preenchidos: 0 } });
    expect(ops.some((o) => o.tabela === "contacts" && o.op === "update")).toBe(false);
  });

  it("passado o prazo, para e não carimba quem não visitou", async () => {
    let agora = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => agora);
    aoConsultar = () => {
      agora += 46_000;
    };
    contatos = [contatos[0]!, { ...contatos[0]!, id: "c2" }];
    const r = await chamar();
    expect(await r.json()).toMatchObject({ data: { varridos: 1, interrompida: true } });
    expect(ops.filter((o) => o.tabela === "contacts" && o.op === "update")).toHaveLength(1);
  });

  it("canal fora do ar carimba sem perguntar nome", async () => {
    sessao = { provider: "waha", waha_session_name: "s", status: "STOPPED", archived_at: null };
    expect(await (await chamar()).json()).toMatchObject({ data: { sem_canal: 1, preenchidos: 0 } });
  });
});

describe("o encanamento", () => {
  it("não nomeia o provider — pede as colunas ao seam", () => {
    const fonte = readFileSync("app/api/v1/cron/contact-names/route.ts", "utf8");
    expect(fonte).toContain("CHANNEL_SESSION_REF_COLUMNS");
    expect(fonte).toContain("resolveSessionRef");
    expect(fonte).not.toMatch(/waha/i);
  });

  it("está agendado", () => {
    const compose = readFileSync("docker/scheduler/entrypoint.sh", "utf8");
    expect(compose).toMatch(/cron\/contact-names/);
  });
});
