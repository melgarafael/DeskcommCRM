import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "11111111-1111-4111-8111-111111111111";
const PEDIDO = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const OUTRO_PEDIDO = "44444444-4444-4444-8444-444444444444";
const PESSOAL = "titular-sintetico@example.test token=segredo-sintetico";

const estado = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  status: "pending_review",
  negar: false,
  erroPedido: null as { message: string } | null,
  erroAudit: null as { message: string } | null,
  filtros: [] as { tabela: string; coluna: string; valor: unknown }[],
  assinados: [] as { path: string; segundos: number }[],
  opcoesAssinatura: [] as ({ download?: string | boolean } | undefined)[],
  falhas: {} as Record<string, "error" | "throw" | undefined>,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () =>
    estado.negar
      ? { ok: false, response: new Response("negado", { status: 403 }) }
      : { ok: true, user: { idioma: "pt-BR" }, org: { orgId: ORG } },
  ),
}));

interface Resposta {
  data: Record<string, unknown> | unknown[] | null;
  error: { message: string } | null;
}
interface Consulta {
  select: () => Consulta;
  eq: (coluna: string, valor: unknown) => Consulta;
  or: () => Consulta;
  order: () => Consulta;
  limit: () => Consulta;
  maybeSingle: () => Promise<Resposta>;
  then: (resolver: (resposta: Resposta) => unknown) => Promise<unknown>;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string): Consulta => {
      const resposta = (): Resposta =>
        tabela === "lgpd_requests"
          ? {
              data: {
                id: PEDIDO,
                organization_id: ORG,
                contact_id: null,
                status: estado.status,
                request_payload: {},
                result: estado.result,
              },
              error: estado.erroPedido,
            }
          : { data: [], error: estado.erroAudit };
      const q: Consulta = {
        select: () => q,
        eq: (coluna, valor) => {
          estado.filtros.push({ tabela, coluna, valor });
          return q;
        },
        or: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => resposta(),
        then: (resolver) => Promise.resolve(resposta()).then(resolver),
      };
      return q;
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (
          path: string,
          segundos: number,
          opcoes?: { download?: string | boolean },
        ) => {
          expect(bucket).toBe("lgpd-exports");
          estado.assinados.push({ path, segundos });
          estado.opcoesAssinatura.push(opcoes);
          const falha = estado.falhas[path];
          if (falha === "throw") throw new Error(PESSOAL);
          return falha === "error"
            ? { data: null, error: { message: PESSOAL } }
            : {
                data: { signedUrl: `https://storage.invalid/${path}?token=sintetico` },
                error: null,
              };
        },
      }),
    },
  }),
}));

import { GET } from "@/app/api/v1/lgpd/requests/[id]/route";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";

const pdf = `${ORG}/${PEDIDO}/report.pdf`;
const json = `${ORG}/${PEDIDO}/data.json`;
const pedir = () =>
  GET(new NextRequest(`http://localhost/api/v1/lgpd/requests/${PEDIDO}`), {
    params: Promise.resolve({ id: PEDIDO }),
  });
const urls = async () => {
  const resposta = await pedir();
  expect(resposta.status).toBe(200);
  const corpo = await resposta.json();
  return corpo.data as { signed_pdf_url: string | null; signed_json_url: string | null };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  estado.result = { pdf_path: pdf, json_path: json };
  estado.status = "pending_review";
  estado.negar = false;
  estado.erroPedido = estado.erroAudit = null;
  estado.filtros = [];
  estado.assinados = [];
  estado.opcoesAssinatura = [];
  estado.falhas = {};
});
afterEach(() => vi.restoreAllMocks());

describe("download manual de LGPD: duas assinaturas sem cruzar pedidos", () => {
  it.each(["pending_review", "completed"] as const)(
    "%s pede download dos dois anexos com os nomes fixos do worker e prazo de72h",
    async (status) => {
      estado.status = status;
      await urls();
      expect(estado.assinados).toEqual([
        { path: pdf, segundos: 259200 },
        { path: json, segundos: 259200 },
      ]);
      expect(estado.opcoesAssinatura).toEqual([
        { download: "report.pdf" },
        { download: "data.json" },
      ]);
    },
  );

  it("controle: assina os dois arquivos emitidos pelo worker por72h, com filtro de organização e guard original", async () => {
    const r = await urls();
    expect(r.signed_pdf_url).toContain(pdf);
    expect(r.signed_json_url).toContain(json);
    expect(r.signed_pdf_url).not.toBe(r.signed_json_url);
    expect(estado.assinados).toEqual([
      { path: pdf, segundos: 259200 },
      { path: json, segundos: 259200 },
    ]);
    expect(estado.filtros).toEqual(
      expect.arrayContaining([
        { tabela: "lgpd_requests", coluna: "organization_id", valor: ORG },
        { tabela: "lgpd_requests", coluna: "id", valor: PEDIDO },
        { tabela: "api_audit_log", coluna: "organization_id", valor: ORG },
      ]),
    );
    expect(requireRole).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({
        allowPlatformAdmin: "leitura",
        permiteOrgSuspensa: true,
      }),
    );
  });

  it.each([
    [`${OUTRA_ORG}/${PEDIDO}/data.json`, "json_path"],
    [`${ORG}/${OUTRO_PEDIDO}/data.json`, "json_path"],
    [pdf, "json_path"],
    [`${ORG}/${PEDIDO}/../${OUTRO_PEDIDO}/report.pdf`, "pdf_path"],
  ])("recusa caminho fora da estrutura emitida pelo worker: %s", async (path, campo) => {
    estado.result[campo] = path;
    const r = await urls();
    expect(estado.assinados.some((a) => a.path === path && a.path !== pdf)).toBe(false);
    if (campo === "json_path") {
      expect(r.signed_json_url).toBeNull();
      expect(r.signed_pdf_url).toContain(pdf);
      expect(estado.assinados).toEqual([{ path: pdf, segundos: 259200 }]);
    } else {
      expect(r.signed_pdf_url).toBeNull();
      expect(r.signed_json_url).toContain(json);
    }
  });

  it.each(["error", "throw"] as const)(
    "uma falha %s no PDF não impede assinar o JSON",
    async (falha) => {
      estado.falhas[pdf] = falha;
      const r = await urls();
      expect(r.signed_pdf_url).toBeNull();
      expect(r.signed_json_url).toContain(json);
    },
  );

  it.each(["error", "throw"] as const)("uma falha %s no JSON preserva o PDF", async (falha) => {
    estado.falhas[json] = falha;
    const r = await urls();
    expect(r.signed_pdf_url).toContain(pdf);
    expect(r.signed_json_url).toBeNull();
  });

  it("legado sem json_path continua com PDF e não inventa outro arquivo", async () => {
    estado.result = { pdf_path: pdf };
    const r = await urls();
    expect(r.signed_pdf_url).toContain(pdf);
    expect(r.signed_json_url).toBeNull();
    expect(estado.assinados).toEqual([{ path: pdf, segundos: 259200 }]);
    expect(estado.opcoesAssinatura).toEqual([{ download: "report.pdf" }]);
  });

  it("processing e acesso negado não assinam arquivo", async () => {
    estado.status = "processing";
    expect(await urls()).toMatchObject({ signed_pdf_url: null, signed_json_url: null });
    estado.negar = true;
    expect((await pedir()).status).toBe(403);
    expect(estado.assinados).toEqual([]);
  });

  it("falha de assinatura é log técnico, sem mensagem, caminho ou URL", async () => {
    estado.falhas[pdf] = "error";
    await urls();
    expect(logger.warn).toHaveBeenCalled();
    const logs = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    for (const valor of [PESSOAL, pdf, json, "https://"]) expect(logs).not.toContain(valor);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("erro não fatal da trilha mantém o pacote e também evita log bruto", async () => {
    estado.erroAudit = { message: PESSOAL };
    expect((await urls()).signed_json_url).toContain(json);
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(PESSOAL);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("erro de leitura não entrega a mensagem do banco ao operador", async () => {
    estado.erroPedido = { message: PESSOAL };
    const r = await pedir();
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).toContain("internal_error");
    expect(body).not.toContain(PESSOAL);
    expect(estado.assinados).toEqual([]);
  });
});
