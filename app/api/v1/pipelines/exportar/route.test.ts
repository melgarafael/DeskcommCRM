/**
 * GET /api/v1/pipelines/exportar — o blueprint de FUNIS com as etapas (#1995).
 *
 * O que estes casos provam, e por que nesta forma:
 *
 * 1. O recorte é funil VIVO (`is_archived = false`) da organização ativa, na
 *    ordem do quadro — a asserção é nos FILTROS da consulta, não só no corpo:
 *    exportar arquivado recriaria no destino um quadro que a origem escondeu.
 * 2. O arquivo é o MESMO envelope (`formato`/`versao`), com `tipo: "funis"` e
 *    `funis-AAAA-MM-DD.json` — e o corpo que sai é lido de volta pelo leitor do
 *    import (round-trip de verdade, não só formato).
 * 3. As etapas vão DENTRO do funil, na ordem lida do banco.
 * 4. Organização sem funil responde 409 e não gera arquivo vazio; acima do
 *    teto também recusa, dizendo o limite.
 * 5. O audit registra quantidade — nunca nome de funil nem de etapa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.from }) }));

import { GET } from "@/app/api/v1/pipelines/exportar/route";
import { TETO_DE_ITENS_DO_BLUEPRINT } from "@/lib/templates/blueprint";
import { lerBlueprintDeFunis } from "@/lib/templates/blueprint-de-funis";

const ORG = "c7d40000-0000-4000-8000-000000000031";
const USER = "c7d40000-0000-4000-8000-000000000032";

type Linha = Record<string, unknown>;

interface ConsultaFake {
  q: unknown;
  filtros: Record<string, unknown>;
  ordens: Array<[string, unknown]>;
  limite: () => number | null;
  colunas: () => string;
  em: () => unknown[] | null;
}

/** A consulta fake do PostgREST: guarda filtros/ordens e resolve com o dado. */
function consulta(resultado: { data?: unknown; error?: unknown }): ConsultaFake {
  const filtros: Record<string, unknown> = {};
  const ordens: Array<[string, unknown]> = [];
  let limite: number | null = null;
  let colunas = "";
  let em: unknown[] | null = null;

  const q = {
    select(cols: string) {
      colunas = cols;
      return q;
    },
    eq(coluna: string, valor: unknown) {
      filtros[coluna] = valor;
      return q;
    },
    in(coluna: string, valores: unknown[]) {
      em = valores;
      return q;
    },
    order(coluna: string, opcoes?: unknown) {
      ordens.push([coluna, opcoes]);
      return q;
    },
    limit(valor: number) {
      limite = valor;
      return q;
    },
    then<T>(resolve: (valor: unknown) => T) {
      return Promise.resolve(resultado).then(resolve);
    },
  };

  return {
    q,
    filtros,
    ordens,
    limite: () => limite,
    colunas: () => colunas,
    em: () => em,
  };
}

function pedido(): NextRequest {
  return new NextRequest("http://localhost/api/v1/pipelines/exportar");
}

const PIPELINES = [
  { id: "p1", name: "Clínica", description: "Entrada", position: 1000 },
  { id: "p2", name: "Retorno", description: null, position: 2000 },
];

const STAGES = [
  {
    pipeline_id: "p1",
    name: "Novo",
    color: "#22c55e",
    is_won: false,
    is_lost: false,
    position: 1000,
  },
  {
    pipeline_id: "p1",
    name: "Ganho",
    color: null,
    is_won: true,
    is_lost: false,
    position: 2000,
  },
  {
    pipeline_id: "p2",
    name: "Aguardando",
    color: "#64748b",
    is_won: false,
    is_lost: false,
    position: 1000,
  },
];

/** Duas tabelas, na ordem em que a rota as consulta. */
function bancoDeDuasLeituras(
  funis: Linha[],
  etapas: Linha[],
): { funis: ConsultaFake; etapas: ConsultaFake } {
  const leituraDeFunis = consulta({ data: funis, error: null });
  const leituraDeEtapas = consulta({ data: etapas, error: null });
  h.from.mockImplementation((tabela: string) => {
    if (tabela === "crm_pipelines") return leituraDeFunis.q;
    if (tabela === "crm_stages") return leituraDeEtapas.q;
    throw new Error(`tabela inesperada: ${tabela}`);
  });
  return { funis: leituraDeFunis, etapas: leituraDeEtapas };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
  h.audit.mockResolvedValue(undefined);
});

describe("GET /pipelines/exportar", () => {
  it("lê só os funis vivos da organização ativa, na ordem do quadro", async () => {
    const db = bancoDeDuasLeituras(PIPELINES, STAGES);

    await GET(pedido());

    expect(h.from).toHaveBeenCalledWith("crm_pipelines");
    expect(db.funis.filtros).toEqual({ organization_id: ORG, is_archived: false });
    expect(db.funis.ordens[0]).toEqual(["position", { ascending: true }]);
    // Um a mais que o teto: basta para saber que passou.
    expect(db.funis.limite()).toBe(TETO_DE_ITENS_DO_BLUEPRINT + 1);

    expect(h.from).toHaveBeenCalledWith("crm_stages");
    expect(db.etapas.em()).toEqual(["p1", "p2"]);
    expect(db.etapas.ordens[0]).toEqual(["position", { ascending: true }]);
  });

  it("monta o mesmo envelope, com tipo `funis` e as etapas dentro do funil", async () => {
    bancoDeDuasLeituras(PIPELINES, STAGES);

    const res = await GET(pedido());
    expect(res.status).toBe(200);

    const corpo = await res.json();
    expect(corpo.formato).toBe("respostas-rapidas.blueprint");
    expect(corpo.versao).toBe(1);
    expect(corpo.tipo).toBe("funis");
    expect(typeof corpo.gerado_em).toBe("string");

    expect(corpo.itens.map((item: Linha) => item.nome)).toEqual(["Clínica", "Retorno"]);
    expect(Object.keys(corpo.itens[0]).sort()).toEqual(["descricao", "etapas", "nome"]);
    expect(corpo.itens[0].etapas.map((etapa: Linha) => etapa.nome)).toEqual(["Novo", "Ganho"]);
    expect(corpo.itens[1].etapas.map((etapa: Linha) => etapa.nome)).toEqual(["Aguardando"]);
    // Nada de id, slug nem posição numérica da origem.
    const texto = JSON.stringify(corpo);
    expect(texto).not.toContain("pipeline_id");
    expect(texto).not.toContain("\"position\"");
    expect(texto).not.toContain("\"id\"");
  });

  it("o arquivo que sai é lido de volta pelo import, com as etapas na mesma ordem", async () => {
    bancoDeDuasLeituras(PIPELINES, STAGES);

    const corpo = await (await GET(pedido())).json();
    const lido = lerBlueprintDeFunis(JSON.parse(JSON.stringify(corpo)));

    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.itens[0]!.etapas.map((etapa) => etapa.nome)).toEqual(["Novo", "Ganho"]);
    expect(lido.itens[0]!.etapas[1]).toMatchObject({ is_won: true, is_lost: false });
  });

  it("sai como download funis-AAAA-MM-DD.json, sem cache", async () => {
    bancoDeDuasLeituras(PIPELINES, STAGES);

    const res = await GET(pedido());

    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="funis-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("organização sem funil responde 409 e não gera arquivo vazio", async () => {
    bancoDeDuasLeituras([], []);

    const res = await GET(pedido());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("state_conflict");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("funil sem etapa ativa recusa: o import não criaria quadro morto", async () => {
    // `p2` não tem etapa na leitura (todas as dele estão arquivadas).
    bancoDeDuasLeituras(PIPELINES, [STAGES[0]!, STAGES[1]!]);

    const res = await GET(pedido());

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/sem etapas ativas/);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("acima do teto recusa com 409 que diz o limite, sem audit de export", async () => {
    const funis = Array.from({ length: TETO_DE_ITENS_DO_BLUEPRINT + 1 }, (_, i) => ({
      id: `p${i}`,
      name: `Funil ${i}`,
      description: null,
      position: (i + 1) * 1000,
    }));
    bancoDeDuasLeituras(funis, []);

    const res = await GET(pedido());

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain(String(TETO_DE_ITENS_DO_BLUEPRINT));
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("o audit conta funis e etapas, sem guardar nomes", async () => {
    bancoDeDuasLeituras(PIPELINES, STAGES);

    await GET(pedido());

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.exported",
        organizationId: ORG,
        resourceType: "crm_pipeline",
        metadata: expect.objectContaining({ total: 2, etapas: 3 }),
      }),
    );
    const registrado = JSON.stringify(h.audit.mock.calls[0]?.[0]);
    expect(registrado).not.toContain("Clínica");
    expect(registrado).not.toContain("Aguardando");
  });

  it("propaga a recusa do requireRole sem tocar no banco", async () => {
    h.guard.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), {
        status: 403,
      }),
    });

    const res = await GET(pedido());

    expect(res.status).toBe(403);
    expect(h.from).not.toHaveBeenCalled();
  });
});
