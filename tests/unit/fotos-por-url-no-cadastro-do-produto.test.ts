/**
 * A API REUSA O DOWNLOAD DA PLANILHA — não um segundo baixador (#3587).
 *
 * ─── Por que este teste existe separado do contrato ────────────────────────
 *
 * `fotos-do-produto-pela-api.test.ts` dubla `guardarFotosPorUrl` e mede o
 * contrato da rota (ordem, limite, recusa inteira, substituição no PATCH). Aqui
 * o downloader é o DE VERDADE: a rota grava e o que se mede é o fio inteiro —
 * `fetch` → assinatura dos bytes → `upload` no bucket → caminhos no produto.
 *
 * Se alguém no futuro "resolver" a API com um `fetch` próprio (ou gravando a
 * URL na coluna), o teste de contrato continuaria verde e este reprova: são
 * dois instrumentos para duas perguntas diferentes.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/v1/products/route";
import { requireRole } from "@/lib/auth/require-role";
import { assertUrlDeMidiaSegura } from "@/lib/messaging/media/url-de-midia-externa";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: vi.fn(async () => "BRL") }));
// A guarda anti-SSRF é da URL de mídia, exercitada em
// lib/messaging/media/url-de-midia-externa.test.ts: aqui ela é dublada (resolver
// DNS em teste de unidade é dependência de rede) e apenas ESPIADA.
vi.mock("@/lib/messaging/media/url-de-midia-externa", () => ({
  assertUrlDeMidiaSegura: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const URL_A = "https://cdn.loja.test/carro/frente.jpg";
const URL_B = "https://cdn.loja.test/carro/painel.jpg";

/** Assinatura JPEG de verdade — o tipo sai dos BYTES, não do content-type. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

let insercoes: Array<Record<string, unknown>> = [];
let uploads: Array<{ caminho: string; bytes: Uint8Array; contentType?: string }> = [];
let removidos: string[] = [];

function consulta(resolver: () => { data: unknown; error: unknown }) {
  const elo: Record<string, unknown> = {};
  elo.eq = () => elo;
  elo.neq = () => elo;
  elo.or = () => elo;
  elo.order = () => elo;
  elo.limit = () => elo;
  elo.maybeSingle = async () => resolver();
  elo.single = async () => resolver();
  elo.select = () => elo;
  return elo;
}

function montarMundo() {
  insercoes = [];
  uploads = [];
  removidos = [];

  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: ORG, name: "Loja", role: "manager" },
      }) as never,
  );

  const from = () => ({
    insert: (linha: Record<string, unknown>) => {
      insercoes.push(linha);
      return consulta(() => ({ data: { ...linha, id: linha.id }, error: null }));
    },
    select: () => consulta(() => ({ data: null, error: null })),
  });
  vi.mocked(createClient).mockResolvedValue({ from } as never);

  vi.mocked(createAdminClient).mockReturnValue({
    storage: {
      from: () => ({
        upload: async (caminho: string, bytes: Uint8Array, opts?: { contentType?: string }) => {
          uploads.push({ caminho, bytes, contentType: opts?.contentType });
          return { error: null };
        },
        remove: async (caminhos: string[]) => {
          removidos.push(...caminhos);
          return { error: null };
        },
      }),
    },
  } as never);
}

function corpo(json: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
}

const produtoNovo = { codigo: "CARRO-2", nome: "VW Gol 2020", preco_cents: 5190000 };

describe("#3587 — o download da planilha é o mesmo da API", () => {
  beforeEach(() => {
    montarMundo();
    vi.mocked(assertUrlDeMidiaSegura).mockClear();
  });

  it("POST baixa as URLs, sobe os arquivos e grava os caminhos na ordem", async () => {
    const pedidas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        pedidas.push(String(url));
        return new Response(JPEG, { status: 200 });
      }),
    );

    const resposta = await POST(corpo({ ...produtoNovo, fotos: [URL_A, URL_B] }));
    vi.unstubAllGlobals();

    expect(resposta.status).toBe(201);
    expect(pedidas).toEqual([URL_A, URL_B]);
    // A guarda anti-SSRF roda em CADA URL, como no caminho da planilha.
    expect(vi.mocked(assertUrlDeMidiaSegura).mock.calls.map((c) => c[0])).toEqual([URL_A, URL_B]);
    expect(uploads).toHaveLength(2);
    expect(uploads.every((u) => u.contentType === "image/jpeg")).toBe(true);

    const gravado = insercoes[0]!;
    // O que foi para o banco são os CAMINHOS dos arquivos que subiram, na ordem.
    expect(gravado.fotos).toEqual(uploads.map((u) => u.caminho));
    expect((gravado.fotos as string[]).every((c) => c.startsWith(`${ORG}/${gravado.id as string}/`))).toBe(true);
  });

  it("corpo interrompido devolve 422 e limpa a primeira foto sem criar produto", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url) !== URL_B) return new Response(JPEG, { status: 200 });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new TypeError("conexão interrompida")); },
      }), { status: 200 });
    });

    try {
      const resposta = await POST(corpo({ ...produtoNovo, fotos: [URL_A, URL_B] }));
      const json = await resposta.json();

      expect(resposta.status).toBe(422);
      expect(json.error.message).toContain(URL_B);
      expect(insercoes).toHaveLength(0);
      expect(uploads).toHaveLength(1);
      expect(removidos).toEqual([uploads[0]!.caminho]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uma foto que não baixa derruba o cadastro inteiro e limpa o que já subiu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url) === URL_B ? new Response("", { status: 404 }) : new Response(JPEG, { status: 200 }),
      ),
    );

    const resposta = await POST(corpo({ ...produtoNovo, fotos: [URL_A, URL_B] }));
    vi.unstubAllGlobals();
    const json = (await resposta.json()) as { error: { message: string } };

    expect(resposta.status).toBe(422);
    expect(json.error.message).toContain("HTTP 404");
    // Nada de produto "pela metade": sem linha e sem arquivo órfão.
    expect(insercoes).toHaveLength(0);
    expect(uploads).toHaveLength(1);
    expect(removidos).toEqual([uploads[0]!.caminho]);
  });
});
