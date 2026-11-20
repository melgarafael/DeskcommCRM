// lib/propostas/pdf-da-proposta.ssrf.test.ts
//
// A imagem de catálogo é buscada pelo SERVIDOR, no react-pdf. O guard textual
// (`assertSafeOutboundUrl`) lê o nome do host e não o IP, então um domínio
// público apontando para a rede interna passava por ele. Este arquivo mede o
// julgamento do endereço RESOLVIDO, que é o que fecha aquele caminho.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({
  resposta: [] as Array<{ address: string; family: number }>,
  erro: null as Error | null,
}));

vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => {
    if (dns.erro) throw dns.erro;
    return dns.resposta;
  });
  // `default` é obrigatório: sem ele a coleta do arquivo inteiro quebra.
  return { lookup, default: { lookup } };
});

const mocks = vi.hoisted(() => ({
  montarDocumentoDaProposta: vi.fn(),
  renderDocumentoPdf: vi.fn(),
  marcaDaOrganizacaoParaPdf: vi.fn(),
}));

vi.mock("./documento/documento-da-proposta", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, montarDocumentoDaProposta: mocks.montarDocumentoDaProposta };
});
vi.mock("./documento/pdf-do-documento", () => ({ renderDocumentoPdf: mocks.renderDocumentoPdf }));
vi.mock("./marca-da-organizacao-para-pdf", () => ({
  marcaDaOrganizacaoParaPdf: mocks.marcaDaOrganizacaoParaPdf,
}));

import { montarPdfDaProposta, type PropostaParaPdf } from "./pdf-da-proposta";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const IMAGEM = "https://midia.exemplo.com/foto.png";

function proposta(): PropostaParaPdf {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    contact_id: "contato-1",
    titulo: "Site da imobiliária",
    versao: 1,
    condicoes: "50% no aceite",
    template_slug: "site",
    secoes_editadas: null,
    briefing_json: { project: { name: "Site da imobiliária" } },
    total_cents: 350000,
    moeda: "BRL",
    prazo_dias_uteis: 30,
    valid_until: "2026-12-31",
    created_at: "2026-09-26T00:00:00.000Z",
  };
}

/** Item de catálogo com imagem: o único caminho que faz o servidor buscar áudio/imagem de fora. */
function adminComImagem(url: string) {
  return {
    from: vi.fn((tabela: string) => {
      if (tabela === "crm_proposal_items") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      descricao: "Site institucional",
                      quantidade: 1,
                      preco_unitario_cents: 350000,
                      desconto_cents: 0,
                      product_id: "prod-1",
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (tabela === "catalog_products") {
        return {
          select: () => ({
            eq: () => ({ in: async () => ({ data: [{ id: "prod-1", imagem_url: url }], error: null }) }),
          }),
        };
      }
      if (tabela === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { name: "Maria", display_name: "Maria", email: null, phone_number: null },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no mock: ${tabela}`);
    }),
  };
}

function imagemDoPdf(): string | null {
  const argumento = mocks.renderDocumentoPdf.mock.calls[0]?.[0] as { itens: Array<{ imagemUrl: string | null }> };
  const item = argumento.itens[0];
  if (!item) throw new Error("o PDF foi montado sem item");
  return item.imagemUrl;
}

async function gerar(): Promise<void> {
  await montarPdfDaProposta(adminComImagem(IMAGEM) as never, ORG_ID, proposta(), {
    numero: 1,
    ano: 2026,
    t: (texto: string) => texto,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  dns.resposta = [];
  dns.erro = null;
  mocks.montarDocumentoDaProposta.mockResolvedValue({
    modelo: { slug: "site" },
    secoes: [{ id: "resumo", body: "Projeto: X", faltantes: [] }],
    pendencias: [],
    camposFaltando: [],
  });
  mocks.marcaDaOrganizacaoParaPdf.mockResolvedValue({ appName: "Loja X", accentHex: "#111111", logoUrl: null });
  mocks.renderDocumentoPdf.mockImplementation(async () => Buffer.from("%PDF-1.4 proposta"));
});

describe("imagem do catálogo no PDF — SSRF pelo endereço resolvido", () => {
  it("host público que resolve para a rede interna não vai para o PDF", async () => {
    dns.resposta = [{ address: "10.0.0.5", family: 4 }];
    await gerar();
    // O guard textual aprovaria `midia.exemplo.com`: é o nome que ele lê. Quem reprova é o IP.
    expect(imagemDoPdf()).toBeNull();
  });

  it("metadata da nuvem (169.254.169.254) também não", async () => {
    dns.resposta = [{ address: "169.254.169.254", family: 4 }];
    await gerar();
    expect(imagemDoPdf()).toBeNull();
  });

  it("controle: host público com IP público continua indo para o PDF", async () => {
    // Sem este caso, um `return null` fixo passaria nos dois testes acima.
    dns.resposta = [{ address: "8.8.8.8", family: 4 }];
    await gerar();
    expect(imagemDoPdf()).toBe(IMAGEM);
  });

  it("nome que não resolve é fail-closed: item sem imagem, proposta segue", async () => {
    dns.erro = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    await gerar();
    expect(imagemDoPdf()).toBeNull();
    expect(mocks.renderDocumentoPdf).toHaveBeenCalled();
  });

  it("imagem em host privado literal continua barrada pelo guard textual", async () => {
    await montarPdfDaProposta(adminComImagem("https://127.0.0.1/foto.png") as never, ORG_ID, proposta(), {
      numero: 1,
      ano: 2026,
      t: (texto: string) => texto,
    });
    expect(imagemDoPdf()).toBeNull();
  });
});
