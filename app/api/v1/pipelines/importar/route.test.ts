/**
 * POST /api/v1/pipelines/importar — aplica o blueprint de FUNIS (#1995).
 *
 * O que estes casos provam, e por que nesta forma:
 *
 * 1. Round-trip de verdade: o corpo é gerado pelo EXPORT (`blueprintDeFunis`) e
 *    o que chega ao banco é o funil com as MESMAS etapas na MESMA ordem —
 *    posição renumerada 1000, 2000, … pela posição no array.
 * 2. O import só CRIA. Nome que já existe vira cópia com sufixo e o original
 *    fica intocado (mesmo id, mesmas etapas) — a asserção é no estado, não só no
 *    nome: uma rota que renomeasse o existente teria o mesmo corpo de resposta.
 * 3. Arquivo de RESPOSTAS RÁPIDAS é recusado por `tipo` (422), sem escrita: o
 *    formato e a versão casam, então só o tipo impede o "melhor esforço".
 * 4. Arquivo com 201 funis é recusado por `itens`, com o limite na frase.
 * 5. Escrita pela metade não fica: se a etapa falha, o funil criado é desfeito
 *    (funil recém-criado não tem negócio, então o RESTRICT não atrapalha).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
  marca: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: h.marca }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.from }) }));

import { POST } from "@/app/api/v1/pipelines/importar/route";
import { FORMATO_DO_BLUEPRINT, TETO_DE_ITENS_DO_BLUEPRINT } from "@/lib/templates/blueprint";
import {
  TIPO_FUNIS,
  blueprintDeFunis,
  type EtapaExportavel,
  type FunilExportavel,
} from "@/lib/templates/blueprint-de-funis";

const ORG = "c7d40000-0000-4000-8000-000000000041";
const USER = "c7d40000-0000-4000-8000-000000000042";

type Linha = Record<string, unknown>;

/**
 * Banco fake com ESTADO das duas tabelas. `update`/`upsert` explodem de
 * propósito: o import do blueprint NUNCA sobrescreve, e um caminho de escrita
 * que não seja `insert` derrubaria o caso com erro de tabela, não com uma
 * asserção fácil de "consertar" mudando o teste.
 */
function banco(inicial: { funis?: Linha[]; etapas?: Linha[] } = {}) {
  const funis: Linha[] = (inicial.funis ?? []).map((linha) => ({ ...linha }));
  const etapas: Linha[] = (inicial.etapas ?? []).map((linha) => ({ ...linha }));
  const insertsDeFunil: Linha[] = [];
  const insertsDeEtapa: Linha[][] = [];
  const deletes: string[] = [];
  let falharEtapa = false;
  let proximoId = 1;

  function consultaFunis() {
    const filtros: Array<[string, unknown]> = [];
    const q = {
      select() {
        return q;
      },
      eq(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return q;
      },
      order() {
        return q;
      },
      then<T>(resolve: (valor: unknown) => T) {
        const casadas = funis
          .filter((linha) => filtros.every(([coluna, valor]) => linha[coluna] === valor))
          .sort((a, b) => Number(a.position) - Number(b.position));
        return Promise.resolve({ data: casadas, error: null }).then(resolve);
      },
    };
    return q;
  }

  h.from.mockImplementation((tabela: string) => {
    if (tabela === "crm_pipelines") {
      return {
        select: () => consultaFunis(),
        insert: (linha: Linha) => {
          const id = `novo-${proximoId++}`;
          const nova = { id, is_archived: false, ...linha };
          insertsDeFunil.push(linha);
          funis.push(nova);
          return {
            select: () => ({
              single: async () => ({ data: { id }, error: null }),
            }),
          };
        },
        delete: () => {
          const filtros: Array<[string, unknown]> = [];
          const q = {
            eq(coluna: string, valor: unknown) {
              filtros.push([coluna, valor]);
              return q;
            },
            then<T>(resolve: (valor: unknown) => T) {
              const alvo = filtros.find(([coluna]) => coluna === "id")?.[1];
              deletes.push(String(alvo));
              for (let i = funis.length - 1; i >= 0; i--) {
                if (funis[i]!.id === alvo) funis.splice(i, 1);
              }
              // `crm_stages_pipeline_id_fkey` é ON DELETE CASCADE.
              for (let i = etapas.length - 1; i >= 0; i--) {
                if (etapas[i]!.pipeline_id === alvo) etapas.splice(i, 1);
              }
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return q;
        },
        update: () => {
          throw new Error("o import não pode dar update em funil");
        },
        upsert: () => {
          throw new Error("o import não pode dar upsert em funil");
        },
      };
    }

    if (tabela === "crm_stages") {
      return {
        insert: async (linhas: Linha[]) => {
          if (falharEtapa) return { error: { message: "falha forjada na etapa" } };
          insertsDeEtapa.push(linhas);
          etapas.push(...linhas.map((linha) => ({ ...linha })));
          return { error: null };
        },
        update: () => {
          throw new Error("o import não pode dar update em etapa");
        },
      };
    }

    throw new Error(`tabela inesperada: ${tabela}`);
  });

  return {
    funis,
    etapas,
    insertsDeFunil,
    insertsDeEtapa,
    deletes,
    falharEtapa: () => {
      falharEtapa = true;
    },
  };
}

const EXPORTADO: FunilExportavel[] = [
  { id: "origem-1", name: "Clínica", description: "Fluxo da recepção" },
];
const ETAPAS_EXPORTADAS: EtapaExportavel[] = [
  { pipeline_id: "origem-1", name: "Novo", color: "#22c55e", is_won: false, is_lost: false },
  {
    pipeline_id: "origem-1",
    name: "Em andamento",
    color: null,
    is_won: false,
    is_lost: false,
  },
  { pipeline_id: "origem-1", name: "Ganho", color: "#16a34a", is_won: true, is_lost: false },
  { pipeline_id: "origem-1", name: "Perdido", color: null, is_won: false, is_lost: true },
];

/** O corpo vem do EXPORT: é o round-trip, não um objeto montado à mão. */
function arquivoExportado(): unknown {
  return JSON.parse(
    JSON.stringify(blueprintDeFunis(EXPORTADO, ETAPAS_EXPORTADAS, new Date("2026-11-08T12:00:00Z"))),
  );
}

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/pipelines/importar", {
    method: "POST",
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
  h.apoio.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
  h.marca.mockResolvedValue({ nome: "Acme CRM" });
});

describe("POST /pipelines/importar", () => {
  it("round-trip: cria funil novo com as mesmas etapas na mesma ordem", async () => {
    const db = banco();

    const res = await POST(pedido(arquivoExportado()));

    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ importados: 1, etapas: 4, renomeados: 0 });

    expect(db.insertsDeFunil).toEqual([
      {
        organization_id: ORG,
        name: "Clínica",
        description: "Fluxo da recepção",
        slug: "clinica",
        position: 1000,
        // Organização sem funil: o primeiro nasce padrão, como no POST de funil.
        is_default: true,
        // Explícito, não o default da coluna: o arquivo não tem campo de arquivo.
        is_archived: false,
      },
    ]);

    const etapas = db.insertsDeEtapa[0]!;
    expect(etapas.map((etapa) => etapa.name)).toEqual([
      "Novo",
      "Em andamento",
      "Ganho",
      "Perdido",
    ]);
    expect(etapas.map((etapa) => etapa.position)).toEqual([1000, 2000, 3000, 4000]);
    expect(etapas.map((etapa) => etapa.slug)).toEqual([
      "novo",
      "em-andamento",
      "ganho",
      "perdido",
    ]);
    expect(etapas.map((etapa) => etapa.color)).toEqual(["#22c55e", null, "#16a34a", null]);
    expect(etapas.map((etapa) => [etapa.is_won, etapa.is_lost])).toEqual([
      [false, false],
      [false, false],
      [true, false],
      [false, true],
    ]);
    expect(etapas.every((etapa) => etapa.pipeline_id === "novo-1")).toBe(true);
    expect(etapas.every((etapa) => etapa.organization_id === ORG)).toBe(true);

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.imported",
        organizationId: ORG,
        resourceType: "crm_pipeline",
        metadata: expect.objectContaining({ total: 1, etapas: 4, renomeados: 0 }),
      }),
    );
  });

  it("nome existente vira CÓPIA com sufixo — o original não é tocado", async () => {
    const db = banco({
      funis: [
        {
          id: "original",
          organization_id: ORG,
          name: "Clínica",
          slug: "clinica",
          description: "Do destino",
          position: 1000,
          is_default: true,
          is_client_pipeline: false,
          is_archived: false,
        },
      ],
      etapas: [
        {
          id: "e1",
          organization_id: ORG,
          pipeline_id: "original",
          name: "Recepção",
          slug: "recepcao",
          position: 1000,
        },
        {
          id: "e2",
          organization_id: ORG,
          pipeline_id: "original",
          name: "Fechamento",
          slug: "fechamento",
          position: 2000,
        },
      ],
    });

    const res = await POST(pedido(arquivoExportado()));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ importados: 1, renomeados: 1 });

    // O ORIGINAL continua com o nome, o slug, o padrão e as duas etapas dele.
    const original = db.funis.find((funil) => funil.id === "original");
    expect(original).toMatchObject({
      name: "Clínica",
      slug: "clinica",
      is_default: true,
      description: "Do destino",
    });
    expect(db.etapas.filter((etapa) => etapa.pipeline_id === "original")).toHaveLength(2);

    // A CÓPIA nasce ao lado, com sufixo e slug próprio.
    expect(db.insertsDeFunil[0]).toMatchObject({
      name: "Clínica (importado)",
      // Slug deriva do NOME final — não tenta "roubar" o slug do original.
      slug: "clinica-importado",
      position: 2000,
      is_default: false,
    });
    expect(db.insertsDeEtapa[0]!.every((etapa) => etapa.pipeline_id === "novo-1")).toBe(true);
  });

  it("arquivo de RESPOSTAS RÁPIDAS é recusado por tipo, sem escrever nada", async () => {
    const db = banco();

    const res = await POST(
      pedido({
        formato: FORMATO_DO_BLUEPRINT,
        versao: 1,
        tipo: "respostas_rapidas",
        gerado_em: "2026-11-08T12:00:00.000Z",
        itens: [{ titulo: "Boas-vindas", corpo: "Olá", atalho: null, mostrar_na_barra: true }],
      }),
    );

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.message).toMatch(/não é de funis/);
    expect(db.insertsDeFunil).toHaveLength(0);
    expect(db.insertsDeEtapa).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
    // Só a recusa de formato paga a leitura da marca.
    expect(h.marca).not.toHaveBeenCalled();
  });

  it("201 funis é recusado por itens, com o limite na frase", async () => {
    const db = banco();
    const itens = Array.from({ length: TETO_DE_ITENS_DO_BLUEPRINT + 1 }, (_, i) => ({
      nome: `Funil ${i}`,
      etapas: [{ nome: "Novo", cor: null, is_won: false, is_lost: false }],
    }));

    const res = await POST(
      pedido({
        formato: FORMATO_DO_BLUEPRINT,
        versao: 1,
        tipo: TIPO_FUNIS,
        gerado_em: "2026-11-08T12:00:00.000Z",
        itens,
      }),
    );

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.message).toContain(`de 1 a ${TETO_DE_ITENS_DO_BLUEPRINT}`);
    expect(db.insertsDeFunil).toHaveLength(0);
  });

  it("etapa que falha desfaz o funil criado: import pela metade não fica", async () => {
    const db = banco();
    db.falharEtapa();

    const res = await POST(pedido(arquivoExportado()));

    expect(res.status).toBe(500);
    expect(db.deletes).toEqual(["novo-1"]);
    expect(db.funis).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("corpo que não é JSON é 400", async () => {
    const db = banco();

    const res = await POST(pedido("isto não é json"));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
    expect(db.insertsDeFunil).toHaveLength(0);
  });
});
