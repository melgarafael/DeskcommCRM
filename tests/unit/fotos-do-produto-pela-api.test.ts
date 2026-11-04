/**
 * A FOTO DO PRODUTO PELA API — `fotos` no POST e no PATCH (#3587, fatia 1).
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * `lib/schemas/produtos.ts` fechava o `produtoCreateSchema` em `imagem_url`, sem
 * a chave `fotos`. Como o `produtoPatchSchema` é este schema `.partial()` e o
 * Zod DESCARTA chave desconhecida, um corpo com `fotos` era ignorado em
 * silêncio: `POST /api/v1/products` devolvia 201 sem foto nenhuma e
 * `PATCH /api/v1/products/:id` devolvia 201 (ou 422 "Nada para alterar") sem
 * tocar nas fotos. Para quem integra por n8n ou script, silêncio é pior que
 * erro — a integração "funciona" e o agente apresenta o produto sem foto.
 *
 * ─── Por que o instrumento é o PAYLOAD, e não a resposta ───────────────────
 *
 * A resposta devolve a linha que o PostgREST gravou; o que decide se a foto
 * entrou é o que a rota MANDA para o banco (`fotos` = caminhos no bucket, na
 * ordem da capa). O teste espia o payload do insert/update — uma rota que
 * devolva 201 sem gravar `fotos` reprova aqui, em vez de passar.
 *
 * ─── O que este arquivo NÃO mede ───────────────────────────────────────────
 *
 * O download em si (bytes, tamanho, tipo, SSRF) é do `guardarFotosPorUrl`, que
 * a planilha já usa; aqui ele é dublado para medir o CONTRATO da API (ordem,
 * limite, recusa inteira, substituição no PATCH). O caminho real
 * fio→download→bucket está em `fotos-por-url-no-cadastro-do-produto.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PATCH } from "@/app/api/v1/products/[id]/route";
import { POST } from "@/app/api/v1/products/route";
import { requireRole } from "@/lib/auth/require-role";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: vi.fn(async () => "BRL") }));
vi.mock("@/lib/catalogo/fotos-por-url", () => ({ guardarFotosPorUrl: vi.fn() }));
vi.mock("@/lib/catalogo/fotos-no-bucket", () => ({ apagarDoBucket: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const PRODUTO = "33333333-3333-4333-8333-333333333333";
const URL_A = "https://cdn.loja.test/carro/frente.jpg";
const URL_B = "https://cdn.loja.test/carro/painel.jpg";

/** O que a rota mandou gravar, por tabela e por operação. */
let insercoes: Array<Record<string, unknown>> = [];
let atualizacoes: Array<Record<string, unknown>> = [];
/** A linha que a leitura de apoio do PATCH encontra (null = produto de fora). */
let linhaAtual: { id: string; fotos: string[] | null } | null = null;
/** Erro que o banco devolve no insert/update (null = grava normalmente). */
let erroDoBanco: { code: string } | null = null;

/** Cadeia auto-referente do supabase-js: `eq`/`or`/`select` devolvem a si mesmos. */
function consulta(resolver: () => { data: unknown; error: unknown }) {
  const elo: Record<string, unknown> = {};
  elo.eq = () => elo;
  elo.neq = () => elo;
  elo.or = () => elo;
  elo.in = () => elo;
  elo.order = () => elo;
  elo.limit = () => elo;
  elo.maybeSingle = async () => resolver();
  elo.single = async () => resolver();
  elo.select = () => elo;
  return elo;
}

function montarMundo() {
  insercoes = [];
  atualizacoes = [];
  linhaAtual = null;
  erroDoBanco = null;

  // `mockReset` (e não só o `mockImplementation` abaixo): sem zerar a contagem,
  // "não foi chamado" de um teste passa a ler as chamadas do teste anterior.
  vi.mocked(guardarFotosPorUrl).mockReset();
  vi.mocked(apagarDoBucket).mockClear();

  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: ORG, name: "Loja", role: "manager" },
      }) as never,
  );

  vi.mocked(guardarFotosPorUrl).mockImplementation(async ({ produtoId, urls }) => ({
    ok: true,
    caminhos: urls.map((_, i) => `${ORG}/${produtoId}/foto-${i + 1}.jpg`),
  }));

  const from = (tabela: string) => ({
    insert: (linha: Record<string, unknown>) => {
      insercoes.push(linha);
      const gravado = { ...linha, id: (linha.id as string) ?? PRODUTO };
      return consulta(() => (erroDoBanco ? { data: null, error: erroDoBanco } : { data: gravado, error: null }));
    },
    update: (mudanca: Record<string, unknown>) => {
      atualizacoes.push(mudanca);
      if (erroDoBanco) return consulta(() => ({ data: null, error: erroDoBanco }));
      return consulta(() => ({
        data: linhaAtual
          ? { ...linhaAtual, ...mudanca, id: linhaAtual.id }
          : null,
        error: null,
      }));
    },
    select: () => consulta(() => ({ data: linhaAtual, error: null })),
    delete: () => consulta(() => ({ data: null, error: null })),
    __tabela: tabela,
  });

  vi.mocked(createClient).mockResolvedValue({ from } as never);
}

function corpo(json: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
}

function pedidoDePatch(id: string, json: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/products/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
}

const produtoNovo = { codigo: "CARRO-1", nome: "Fiat Uno 2019", preco_cents: 4590000 };

describe("#3587 — fotos por URL na API de produto", () => {
  beforeEach(() => {
    montarMundo();
  });

  it("POST guarda as duas fotos, na ordem enviada", async () => {
    const resposta = await POST(corpo({ ...produtoNovo, fotos: [URL_A, URL_B] }));
    const json = (await resposta.json()) as { data?: { id: string; fotos?: string[] } };

    expect(resposta.status).toBe(201);
    expect(guardarFotosPorUrl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(guardarFotosPorUrl).mock.calls[0]![0]).toMatchObject({ orgId: ORG, urls: [URL_A, URL_B] });

    const gravado = insercoes[0]!;
    const caminhos = gravado.fotos as string[];
    expect(caminhos).toHaveLength(2);
    // A ORDEM é o contrato: a primeira URL é a capa.
    expect(caminhos[0]).toMatch(/\/foto-1\.jpg$/);
    expect(caminhos[1]).toMatch(/\/foto-2\.jpg$/);
    // O arquivo é NOSSO: o caminho do bucket, nunca a URL de fora.
    expect(caminhos.every((c) => c.startsWith(`${ORG}/${gravado.id as string}/`))).toBe(true);
    expect(json.data?.fotos).toEqual(caminhos);
  });

  it("POST recusa o corpo inteiro com mais de 5 fotos", async () => {
    const seis = Array.from({ length: 6 }, (_, i) => `https://cdn.loja.test/carro/${i + 1}.jpg`);

    const resposta = await POST(corpo({ ...produtoNovo, fotos: seis }));
    const json = (await resposta.json()) as { error: { code: string; details?: { fotos?: string[] } } };

    expect(resposta.status).toBe(422);
    expect(json.error.code).toBe("validation_failed");
    expect((json.error.details?.fotos ?? []).join(" ")).toContain("5");
    // Nada é baixado e nada é gravado: a recusa é do corpo, não de uma foto.
    expect(guardarFotosPorUrl).not.toHaveBeenCalled();
    expect(insercoes).toHaveLength(0);
  });

  it("POST recusa URL que não é http(s), nomeando o item", async () => {
    const resposta = await POST(corpo({ ...produtoNovo, fotos: [URL_A, "ftp://cdn.loja.test/carro/painel.jpg"] }));
    const json = (await resposta.json()) as { error: { code: string; details?: { fotos?: string[] } } };

    expect(resposta.status).toBe(422);
    expect((json.error.details?.fotos ?? []).join(" ")).toContain("ftp://cdn.loja.test/carro/painel.jpg");
    expect(guardarFotosPorUrl).not.toHaveBeenCalled();
    expect(insercoes).toHaveLength(0);
  });

  it("POST recusa quando uma foto não baixa — e não grava o produto pela metade", async () => {
    vi.mocked(guardarFotosPorUrl).mockResolvedValue({
      ok: false,
      motivo: `não consegui baixar a foto (HTTP 404): ${URL_B}`,
    });

    const resposta = await POST(corpo({ ...produtoNovo, fotos: [URL_A, URL_B] }));
    const json = (await resposta.json()) as { error: { code: string; message: string; details?: { fotos?: string[] } } };

    expect(resposta.status).toBe(422);
    expect(json.error.code).toBe("validation_failed");
    // O motivo do downloader chega a quem chamou — sem ele, "não deu" não ajuda.
    expect(`${json.error.message} ${(json.error.details?.fotos ?? []).join(" ")}`).toContain("HTTP 404");
    expect(insercoes).toHaveLength(0);
  });

  it("POST que esbarra em código repetido (409) apaga as fotos que já baixou", async () => {
    erroDoBanco = { code: "23505" };

    const resposta = await POST(corpo({ ...produtoNovo, fotos: [URL_A, URL_B] }));
    const json = (await resposta.json()) as { error: { code: string } };

    expect(resposta.status).toBe(409);
    expect(json.error.code).toBe("conflict");
    const { produtoId } = vi.mocked(guardarFotosPorUrl).mock.calls[0]![0];
    const baixadas = [`${ORG}/${produtoId}/foto-1.jpg`, `${ORG}/${produtoId}/foto-2.jpg`];
    // A linha não existe e os arquivos já subiram: sem a limpeza, ficam órfãos no bucket.
    expect(apagarDoBucket).toHaveBeenCalledWith(ORG, produtoId, baixadas, expect.any(String));
  });

  it("PATCH cujo update falha apaga as fotos novas e preserva as antigas", async () => {
    const antiga = `${ORG}/${PRODUTO}/00000000-0000-4000-8000-000000000001.jpg`;
    linhaAtual = { id: PRODUTO, fotos: [antiga] };
    erroDoBanco = { code: "23505" };

    const resposta = await PATCH(pedidoDePatch(PRODUTO, { fotos: [URL_A, URL_B] }), {
      params: Promise.resolve({ id: PRODUTO }),
    });

    expect(resposta.status).toBe(409);
    const novas = [`${ORG}/${PRODUTO}/foto-1.jpg`, `${ORG}/${PRODUTO}/foto-2.jpg`];
    expect(apagarDoBucket).toHaveBeenCalledTimes(1);
    expect(apagarDoBucket).toHaveBeenCalledWith(ORG, PRODUTO, novas, expect.any(String));
    // A linha não mudou: a foto antiga continua sendo a do produto.
    expect(vi.mocked(apagarDoBucket).mock.calls.flatMap((c) => c[2])).not.toContain(antiga);
  });

  it("PATCH troca o conjunto de fotos e apaga os arquivos que saíram", async () => {
    const antiga = `${ORG}/${PRODUTO}/00000000-0000-4000-8000-000000000001.jpg`;
    linhaAtual = { id: PRODUTO, fotos: [antiga] };

    const resposta = await PATCH(pedidoDePatch(PRODUTO, { fotos: [URL_A, URL_B] }), {
      params: Promise.resolve({ id: PRODUTO }),
    });
    const json = (await resposta.json()) as { data?: { fotos?: string[] } };

    expect(resposta.status).toBe(200);
    // Só `fotos` no corpo já é uma alteração válida.
    expect(atualizacoes).toHaveLength(1);
    const caminhos = atualizacoes[0]!.fotos as string[];
    expect(caminhos).toHaveLength(2);
    // SUBSTITUI, não acrescenta: a foto antiga não sobrevive ao novo conjunto.
    expect(caminhos).not.toContain(antiga);
    expect(caminhos.every((c) => c.startsWith(`${ORG}/${PRODUTO}/`))).toBe(true);
    expect(json.data?.fotos).toEqual(caminhos);
    // O arquivo que saiu do produto sai do bucket.
    expect(apagarDoBucket).toHaveBeenCalledWith(ORG, PRODUTO, [antiga], expect.any(String));
  });

  it("PATCH de produto que não é desta organização responde 404 e não baixa nada", async () => {
    linhaAtual = null;

    const resposta = await PATCH(pedidoDePatch(PRODUTO, { fotos: [URL_A] }), {
      params: Promise.resolve({ id: PRODUTO }),
    });

    expect(resposta.status).toBe(404);
    expect(guardarFotosPorUrl).not.toHaveBeenCalled();
    expect(atualizacoes).toHaveLength(0);
  });
});
