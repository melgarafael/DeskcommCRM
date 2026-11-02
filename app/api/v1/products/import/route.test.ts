// @vitest-environment node
//
// Multipart real (File/FormData) precisa do realm do Node — jsdom (default do
// projeto) tem seu próprio File/FormData que corrompe o corpo ao passar pelo
// parser de multipart do NextRequest (undici). Mesmo achado documentado em
// app/api/v1/ai/skills/import/route.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { fotoPertenceAoProduto } from "@/lib/catalogo/fotos";
import { lerPlanilha } from "@/lib/catalogo/planilha";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Cada chamada a `.upsert()`/`.insert()` em `catalog_products`, na ordem em que aconteceu. */
let upserts: Array<Array<Record<string, unknown>>> = [];
/** Só as que foram por `insert` — o grupo do produto novo que traz foto. */
let insercoes: Array<Array<Record<string, unknown>>> = [];

/**
 * ⚠️ POR QUE DOIS LOTES SEPARADOS, E NÃO UM SÓ COM SHAPES DIFERENTES.
 *
 * O upsert do PostgREST monta UMA sentença `... ON CONFLICT (...) DO UPDATE
 * SET col = EXCLUDED.col` para o lote inteiro — o SET não é recalculado linha
 * a linha. Um array com produto novo carregando `moeda` e produto existente
 * sem ela arriscaria a coluna ausente virar `NULL` explícito no UPDATE em vez
 * de simplesmente não ser tocada — pior que o defeito que se está corrigindo.
 * Por isso o fake abaixo espera duas chamadas distintas a `.upsert()`, uma por
 * grupo, e é isso que os testes verificam.
 */
/**
 * O `id` e as `fotos` que o catálogo já tem. Determinístico por código, porque
 * é ele que nomeia a pasta da foto no bucket (`<org>/<id>/…`).
 */
const idsFixos = new Map<string, string>();

function idDe(codigo: string): string {
  const existente = idsFixos.get(codigo);
  if (existente) return existente;
  const id = `55555555-5555-4555-8555-${String(idsFixos.size + 1).padStart(12, "0")}`;
  idsFixos.set(codigo, id);
  return id;
}

function supabaseCom(
  moedaDaOrg: string,
  codigosExistentes: string[],
  {
    falhaNaLeitura = false,
    fotosPorCodigo = {},
  }: { falhaNaLeitura?: boolean; fotosPorCodigo?: Record<string, string[]> } = {},
) {
  return {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { currency: moedaDaOrg }, error: null }),
            }),
          }),
        };
      }
      // catalog_products
      return {
        // Página a página, como o PostgREST: `range` é inclusivo nas duas pontas.
        select: () => ({
          eq: () => ({
            order: () => ({
              range: async (de: number, ate: number) =>
                falhaNaLeitura
                  ? { data: null, error: { message: "conexão recusada" } }
                  : {
                      data: codigosExistentes.slice(de, ate + 1).map((codigo) => ({
                        id: idDe(codigo),
                        codigo,
                        fotos: fotosPorCodigo[codigo] ?? null,
                      })),
                      error: null,
                    },
            }),
          }),
        }),
        upsert: (linhas: Array<Record<string, unknown>>) => {
          upserts.push(linhas);
          return Promise.resolve({ error: null });
        },
        // O grupo `novo+foto` grava por `insert` (o `id` da pasta da foto não
        // pode ser reescrito por um `DO UPDATE`): o fake registra os dois verbos
        // na MESMA lista de linhas enviadas, e `insercoes` diz qual foi qual.
        insert: (linhas: Array<Record<string, unknown>>) => {
          insercoes.push(linhas);
          upserts.push(linhas);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function csv(linhas: string): File {
  const conteudo = `codigo,nome,preco\n${linhas}`;
  return new File([conteudo], "catalogo.csv", { type: "text/csv" });
}

function pedido(arquivo: File): NextRequest {
  const form = new FormData();
  form.set("file", arquivo);
  return new NextRequest("http://localhost/api/v1/products/import", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  upserts = [];
  insercoes = [];
  idsFixos.clear();
  sonda.uploads.length = 0;
  sonda.removidos.length = 0;
  sonda.guardadas.length = 0;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/products/import — reimportar não pisa a moeda de quem já existia", () => {
  it("produto NOVO herda a moeda da organização", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("MXN", []) as never);
    const { POST } = await import("./route");

    await POST(pedido(csv("IP15,iPhone 15,5499,00")));

    expect(upserts).toHaveLength(1);
    expect(upserts[0]![0]).toMatchObject({ codigo: "IP15", moeda: "MXN" });
  });

  /**
   * ⚠️ O CASO QUE O REVISOR ACHOU. Quatro textos do próprio PR afirmam que "o
   * produto guarda a moeda com que nasceu" — mas o upsert incluía `moeda` para
   * TODA linha, então reimportar a mesma planilha depois de trocar a moeda da
   * organização reescrevia produto já cadastrado. Este teste reprova esse
   * comportamento: para um código que já existe, a linha enviada ao upsert não
   * pode carregar a chave `moeda` — é o MESMO cuidado que o comentário do
   * arquivo já declara para `descricao`, `imagem_url` e `ativo`.
   */
  it("produto EXISTENTE não tem a moeda tocada, mesmo se a organização mudou de moeda", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("MXN", ["AND-01"]) as never);
    const { POST } = await import("./route");

    await POST(pedido(csv("AND-01,Galaxy S24,3999,00")));

    const linhaExistente = upserts.flat().find((l) => l.codigo === "AND-01");
    expect(linhaExistente).toBeDefined();
    expect(linhaExistente).not.toHaveProperty("moeda");
  });

  it("planilha com os dois casos grava cada grupo no shape certo", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("USD", ["AND-01"]) as never);
    const { POST } = await import("./route");

    await POST(
      pedido(csv("IP15,iPhone 15,5499,00\nAND-01,Galaxy S24,3999,00")),
    );

    const todas = upserts.flat();
    const novo = todas.find((l) => l.codigo === "IP15");
    const existente = todas.find((l) => l.codigo === "AND-01");
    expect(novo).toMatchObject({ moeda: "USD" });
    expect(existente).not.toHaveProperty("moeda");
  });
});

/**
 * "ip15" NA PLANILHA COM "IP15" NO CATÁLOGO (#482, decisão do mantenedor de 22/09/2026).
 *
 * O índice do banco compara o texto exato e aceitaria os dois — mas a busca do
 * agente ignora a caixa, e o cliente ouviria dois preços para o mesmo produto.
 * A linha é recusada com aviso no resumo, e nada chega ao upsert.
 */
describe("POST /api/v1/products/import — o código não diferencia maiúsculas", () => {
  async function importar(codigosExistentes: string[], linhas: string) {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", codigosExistentes) as never);
    const { POST } = await import("./route");
    const res = await POST(pedido(csv(linhas)));
    return { status: res.status, corpo: (await res.json()) as { data: Record<string, unknown> } };
  }

  it("ip15 com IP15 já cadastrado é recusado com aviso, não vira um segundo produto", async () => {
    const { corpo } = await importar(["IP15"], "ip15,iPhone 15,4999");

    expect(upserts.flat()).toEqual([]);
    expect(corpo.data).toMatchObject({ criados: 0, atualizados: 0, total_linhas: 1 });
    expect(corpo.data.erros).toEqual([
      {
        linha: 2,
        motivo:
          '"ip15": este código já está no catálogo escrito "IP15". Maiúsculas e minúsculas não mudam o código — escreva igual ao do catálogo para atualizar o produto.',
      },
    ]);
  });

  it("o código escrito IGUAL ao do catálogo continua atualizando", async () => {
    const { corpo } = await importar(["IP15"], "IP15,iPhone 15,4999");

    expect(upserts.flat().map((l) => l.codigo)).toEqual(["IP15"]);
    expect(corpo.data).toMatchObject({ criados: 0, atualizados: 1, erros: [] });
  });

  it("só a linha em outra caixa sai: o resto da planilha entra", async () => {
    const { corpo } = await importar(["IP15"], "IP16,iPhone 16,6499\nip15,iPhone 15,4999");

    expect(upserts.flat().map((l) => l.codigo)).toEqual(["IP16"]);
    expect(corpo.data).toMatchObject({ criados: 1, atualizados: 0 });
    expect(corpo.data.erros).toHaveLength(1);
  });

  it("confere o catálogo INTEIRO, não só a primeira página", async () => {
    const catalogo = [...Array.from({ length: 1000 }, (_, i) => `A${String(i).padStart(4, "0")}`), "IP15"];
    const { corpo } = await importar(catalogo, "ip15,iPhone 15,4999");

    expect(upserts.flat()).toEqual([]);
    expect(corpo.data.erros).toHaveLength(1);
  });

  it("sem conseguir ler o catálogo, nada é gravado", async () => {
    vi.mocked(createClient).mockResolvedValue(
      supabaseCom("BRL", [], { falhaNaLeitura: true }) as never,
    );
    const { POST } = await import("./route");

    const res = await POST(pedido(csv("ip15,iPhone 15,4999")));

    expect(res.status).toBe(500);
    expect(upserts).toEqual([]);
  });
});

describe("POST /api/v1/products/import — estoque inválido não chega ao banco", () => {
  it("reimportar estoque negativo não sobrescreve o produto; as outras linhas seguem", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", ["P1"]) as never);
    const { POST } = await import("./route");
    const arquivo = new File([
      "codigo;nome;preco;estoque\nP1;Produto existente;10;-5\nP2;Produto novo;20;3\n",
    ], "catalogo.csv", { type: "text/csv" });

    const res = await POST(pedido(arquivo));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(upserts.flat()).toEqual([
      expect.objectContaining({ codigo: "P2", quantidade: 3, organization_id: ORG_ID }),
    ]);
    expect(corpo.data).toMatchObject({ total_linhas: 2, criados: 1, atualizados: 0 });
    expect(corpo.data.erros).toEqual([{
      linha: 2,
      motivo: 'quantidade inválida ("-5") — use um inteiro de 0 a 2147483647',
    }]);
  });
});

/**
 * FOTO POR URL (#3587, fatia 1) — a planilha da revenda traz o link da foto.
 *
 * O agente manda as fotos do produto na apresentação, e o que ele lê é
 * `catalog_products.fotos`: CAMINHOS dentro de `catalog-photos`, no formato que
 * a tela grava e que `fotoPertenceAoProduto` exige (`<org>/<produto>/<uuid>.<ext>`).
 * Por isso a URL da planilha é BAIXADA e guardada como arquivo nosso — gravar a
 * URL na coluna não serviria: o agente a descartaria na conferência de dono, e a
 * foto continuaria sem aparecer (é a segunda representação que esta fatia não
 * cria).
 */
const sonda = vi.hoisted(() => ({
  uploads: [] as Array<{ caminho: string; bytes: Uint8Array; opcoes: Record<string, unknown> }>,
  removidos: [] as string[][],
  guardadas: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async (caminho: string, bytes: Uint8Array, opcoes: Record<string, unknown>) => {
          sonda.uploads.push({ caminho, bytes, opcoes });
          return { error: null };
        },
        remove: async (caminhos: string[]) => {
          sonda.removidos.push(caminhos);
          return { error: null };
        },
      }),
    },
  }),
}));

// A guarda anti-SSRF resolve o hostname por DNS: exercitada na suíte dela, aqui
// o que se prende é que ela está NO CAMINHO, antes de qualquer fetch.
vi.mock("@/lib/messaging/media/url-de-midia-externa", () => ({
  assertUrlDeMidiaSegura: async (url: string) => {
    sonda.guardadas.push(url);
  },
}));

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const URL_DA_FOTO = "https://cdn.revenda.com.br/carro-1/frente.jpg";

/**
 * `Response` só aceita `ArrayBuffer` de verdade — o `Uint8Array<ArrayBufferLike>`
 * que os testes montam não é `BodyInit` para o `lib.dom` deste projeto.
 */
const corpoDe = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

/** Servidor de fotos: cada URL responde o que o caso mandar (default: 404). */
function servidorDeFotos(
  respostas: Record<string, { status?: number; corpo?: Uint8Array; tipo?: string }> = {},
): string[] {
  const pedidas: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string) => {
      pedidas.push(url);
      const r = respostas[url] ?? { status: 404 };
      return new Response(corpoDe(r.corpo ?? new Uint8Array()), {
        status: r.status ?? 200,
        headers: { "content-type": r.tipo ?? "image/jpeg" },
      });
    },
  );
  return pedidas;
}

function planilhaComFoto(linhas: string): File {
  return new File([`codigo,nome,preco,foto\n${linhas}\n`], "catalogo.csv", { type: "text/csv" });
}

describe("POST /api/v1/products/import — foto por URL", () => {
  it("produto novo: guarda a foto como arquivo NOSSO e grava o caminho no produto", async () => {
    servidorDeFotos({ [URL_DA_FOTO]: { corpo: JPEG } });
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", []) as never);
    const { POST } = await import("./route");

    const res = await POST(pedido(planilhaComFoto(`IP15,iPhone 15,5499,${URL_DA_FOTO}`)));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({ criados: 1, atualizados: 0, erros: [] });

    const linha = upserts.flat().find((l) => l.codigo === "IP15")!;
    expect(linha.fotos).toHaveLength(1);

    // O caminho é o da TELA — é ele que a leitura do agente aceita
    // (`fotoPertenceAoProduto`), e é a mesma ida ao bucket, não uma segunda.
    const caminho = (linha.fotos as string[])[0]!;
    expect(fotoPertenceAoProduto(caminho, ORG_ID, linha.id as string)).toBe(true);

    expect(sonda.uploads).toHaveLength(1);
    expect(sonda.uploads[0]!.caminho).toBe(caminho);
    expect(sonda.uploads[0]!.bytes).toEqual(JPEG);
    expect(sonda.uploads[0]!.opcoes).toMatchObject({ contentType: "image/jpeg" });

    // Vai por `insert`, não por upsert: o `id` da pasta da foto não pode ser
    // reescrito pelo `DO UPDATE` de um código que já existisse por corrida.
    expect(insercoes.flat().map((l) => l.codigo)).toEqual(["IP15"]);
  });

  it("a URL é conferida pela guarda de saída ANTES do download", async () => {
    const pedidas = servidorDeFotos({ [URL_DA_FOTO]: { corpo: JPEG } });
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", []) as never);
    const { POST } = await import("./route");

    await POST(pedido(planilhaComFoto(`IP15,iPhone 15,5499,${URL_DA_FOTO}`)));

    expect(sonda.guardadas).toEqual([URL_DA_FOTO]);
    expect(pedidas).toEqual([URL_DA_FOTO]);
  });

  it("linha sem a coluna de foto grava no shape de hoje — sem `fotos`, sem `id`", async () => {
    servidorDeFotos();
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", []) as never);
    const { POST } = await import("./route");

    await POST(pedido(csv("IP15,iPhone 15,5499,00")));

    const linha = upserts.flat().find((l) => l.codigo === "IP15")!;
    expect(linha).not.toHaveProperty("fotos");
    expect(linha).not.toHaveProperty("id");
    expect(sonda.uploads).toEqual([]);
  });

  it("foto que não baixa recusa SÓ aquela linha, com o motivo, e o resto entra", async () => {
    servidorDeFotos({ [URL_DA_FOTO]: { status: 404 } });
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", []) as never);
    const { POST } = await import("./route");

    const res = await POST(
      pedido(
        new File(
          [
            `codigo,nome,preco,foto\nIP15,iPhone 15,5499,${URL_DA_FOTO}\nPERF,212 VIP,449.90,\n`,
          ],
          "catalogo.csv",
          { type: "text/csv" },
        ),
      ),
    );
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({ criados: 1, atualizados: 0 });
    expect(corpo.data.erros).toEqual([
      { linha: 2, motivo: `não consegui baixar a foto (HTTP 404): ${URL_DA_FOTO}` },
    ]);
    // A linha recusada não chega ao banco, e nada sobra no bucket.
    expect(upserts.flat().map((l) => l.codigo)).toEqual(["PERF"]);
    expect(sonda.uploads).toEqual([]);
  });

  it("link que devolve HTML não vira foto no catálogo", async () => {
    servidorDeFotos({
      [URL_DA_FOTO]: { corpo: new TextEncoder().encode("<html>página</html>"), tipo: "text/html" },
    });
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", []) as never);
    const { POST } = await import("./route");

    const res = await POST(pedido(planilhaComFoto(`IP15,iPhone 15,5499,${URL_DA_FOTO}`)));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.erros).toEqual([
      { linha: 2, motivo: `o endereço não devolveu uma foto JPG ou PNG: ${URL_DA_FOTO}` },
    ]);
    expect(upserts.flat()).toEqual([]);
    expect(sonda.uploads).toEqual([]);
  });

  it("corpo sem content-length para de ser lido ao passar de 5 MB, e a linha é recusada", async () => {
    // `content-length` é opcional: uma origem em `chunked` manda o que quiser.
    // O teto tem de valer ENQUANTO o corpo chega — conferido só no fim, o corpo
    // inteiro já estaria na memória. A origem aqui oferece 20 MB, em pedaços de 1 MB.
    const MEGA = 1024 * 1024;
    let servidos = 0;
    let cancelado = false;
    vi.stubGlobal("fetch", async () => {
      const corpo = new ReadableStream<Uint8Array>({
        pull(controle) {
          if (servidos >= 20) return controle.close();
          const pedaco = new Uint8Array(MEGA);
          if (servidos === 0) pedaco.set(JPEG);
          servidos += 1;
          controle.enqueue(pedaco);
        },
        cancel() {
          cancelado = true;
        },
      });
      return new Response(corpo, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", []) as never);
    const { POST } = await import("./route");

    const res = await POST(pedido(planilhaComFoto(`IP15,iPhone 15,5499,${URL_DA_FOTO}`)));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.erros).toEqual([
      { linha: 2, motivo: `a foto passa de 5 MB: ${URL_DA_FOTO}` },
    ]);
    expect(cancelado).toBe(true);
    // 6 pedaços bastam para passar do teto; a folga é a leitura antecipada do stream.
    expect(servidos).toBeLessThan(10);
    expect(upserts.flat()).toEqual([]);
    expect(sonda.uploads).toEqual([]);
  });

  it("produto que já existe: a pasta é a do id dele e as fotos antigas saem do bucket", async () => {
    const idAntigo = idDe("AND-01");
    const fotoAntiga = `${ORG_ID}/${idAntigo}/11111111-1111-4111-8111-111111111111.jpg`;
    servidorDeFotos({ [URL_DA_FOTO]: { corpo: JPEG } });
    vi.mocked(createClient).mockResolvedValue(
      supabaseCom("BRL", ["AND-01"], { fotosPorCodigo: { "AND-01": [fotoAntiga] } }) as never,
    );
    const { POST } = await import("./route");

    await POST(pedido(planilhaComFoto(`AND-01,Galaxy S24,3999,${URL_DA_FOTO}`)));

    const linha = upserts.flat().find((l) => l.codigo === "AND-01")!;
    // Produto existente NÃO ganha `id` no shape (não reescreve a chave dele).
    expect(linha).not.toHaveProperty("id");
    const caminho = (linha.fotos as string[])[0]!;
    expect(fotoPertenceAoProduto(caminho, ORG_ID, idAntigo)).toBe(true);
    expect(insercoes).toEqual([]);
    // A foto que a planilha substituiu não fica órfã no bucket.
    expect(sonda.removidos).toEqual([[fotoAntiga]]);
  });

  it("redirecionamento é seguido com a guarda rodando de novo no endereço novo", async () => {
    // O salto é o buraco clássico da checagem anti-SSRF: o primeiro endereço é
    // público, o segundo é o metadata da nuvem. `redirect: "manual"` + guarda
    // por salto é o que impede a segunda casa de passar sem conferência.
    const destino = "https://169.254.169.254/latest/meta-data";
    const pedidas: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      pedidas.push(url);
      if (url === URL_DA_FOTO) {
        return new Response(null, { status: 302, headers: { location: destino } });
      }
      return new Response(corpoDe(JPEG), { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL", []) as never);
    const { POST } = await import("./route");

    await POST(pedido(planilhaComFoto(`IP15,iPhone 15,5499,${URL_DA_FOTO}`)));

    expect(sonda.guardadas).toEqual([URL_DA_FOTO, destino]);
    expect(pedidas).toEqual([URL_DA_FOTO, destino]);
  });

  it("GET devolve o modelo com a coluna de foto, e o modelo é planilha que o importador lê", async () => {
    const { GET } = await import("./route");

    const texto = (await (await GET()).text()).replace("\ufeff", "");

    expect(texto.split("\n")[0]).toBe("codigo,nome,marca,categoria,preco,custo,estoque,foto");
    const lido = lerPlanilha(texto);
    if ("erro" in lido) throw new Error(`o modelo devolvido não é lido pelo importador: ${lido.erro}`);
    // As linhas do modelo trazem a coluna VAZIA: importado como vem, o modelo
    // não baixa nada de ninguém e nenhuma linha volta recusada.
    expect(lido.produtos).toHaveLength(2);
    for (const produto of lido.produtos) expect(produto).not.toHaveProperty("fotos");
    expect(texto).not.toMatch(/https?:\/\//);
  });
});
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
