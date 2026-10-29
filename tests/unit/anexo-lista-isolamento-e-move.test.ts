// @vitest-environment node
/**
 * O CAMPO DE ARQUIVO DO NEGÓCIO: a LISTA e o MOVE — guarda das issues #3431 e #3433.
 *
 * Os dois consertos estão na `main` desde a v1.91.0, e a maior parte da cobertura
 * já mora em três arquivos — este COMPLETA, não repete:
 *
 * - `app/api/v1/leads/[id]/attachments/route.viewer.test.ts` — papel: viewer lê a
 *   lista e a mídia; POST e DELETE seguem exigindo agent.
 * - `tests/unit/lead-attachments.test.ts` — isolamento da MÍDIA e do DELETE entre
 *   organizações, caminho fora do prefixo, chave que não é campo de arquivo, upload
 *   válido.
 * - `tests/unit/criacao-na-etapa-que-exige-arquivo.test.ts` — a régua pura
 *   (`semAnexosAinda`) e a criação na etapa que exige arquivo.
 *
 * O que só este arquivo cobre:
 *
 * A7  ISOLAMENTO da LISTA — lead de outra organização: 404, não 200 e não 403
 * R2  ISOLAMENTO da LISTA — linha de OUTRA organização com o mesmo `lead_id` fica fora
 * R1  a lista respeita o `field_key` pedido — dois campos, um pedido, um arquivo
 * R3  POST sem arquivo é 422, e nada vai ao Storage
 * R4  POST com formato fora da lista aceita é 415 (PDF e imagem, só)
 * C1  o MOVE pela ROTA para a etapa que exige arquivo, sem anexo: 422, nada gravado
 * C2  o MOVE pela ROTA com o anexo no negócio: 200 e a etapa muda
 *
 * A7 e R2 só valem porque o dublê `consulta` APLICA os `eq`/`in`: sem isso, uma
 * rota que esquecesse o `organization_id` passaria aqui por construção.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROLE_RANK, type Role } from "@/lib/auth/types";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "99999999-9999-4999-8999-999999999999";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA_A = "66666666-6666-4666-8666-666666666666";
const ETAPA_X = "77777777-7777-4777-8777-777777777777";
const LEAD = "22222222-2222-4222-8222-222222222222";
const ANEXO = "88888888-8888-4888-8888-888888888888";
const USER = "55555555-5555-4555-8555-555555555555";
const CAMINHO = `${ORG_A}/leads/${LEAD}/comprovante/${ANEXO}.pdf`;
const ANEXO_ALHEIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARREGADO = "2026-10-24T10:00:00.000Z";

/** O funil da rota: dois campos de arquivo e um de texto, nada exigido. */
const SETTINGS_DA_ROTA = {
  fields: [
    { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [] } },
    { key: "laudo", label: "Laudo", type: "file" },
    { key: "concorrente", label: "Concorrente", type: "text" },
  ],
};

/** O funil que exige o ARQUIVO para receber o negócio na etapa X. */
const EXIGE_ARQUIVO = {
  fields: [
    { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [ETAPA_X] } },
  ],
};

interface Resultado {
  data: unknown;
  error: { message: string } | null;
}

const h = vi.hoisted(() => {
  const db: Record<string, Record<string, unknown>[]> = {};
  const upload = vi.fn();
  const audit = vi.fn();
  const atividade = vi.fn();
  const patches: Record<string, unknown>[] = [];

  /** Consulta encadeável que APLICA os `eq`/`in` vistos — é o que dá força a A7 e R2. */
  function consulta(tabela: string) {
    const filtros: ((linha: Record<string, unknown>) => boolean)[] = [];
    const executa = (): Resultado => ({
      data: (db[tabela] ?? []).filter((linha) => filtros.every((filtro) => filtro(linha))),
      error: null,
    });
    const primeira = async (): Promise<Resultado> => {
      const linhas = executa().data as Record<string, unknown>[];
      return { data: linhas[0] ?? null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (coluna: string, valor: unknown) => {
        filtros.push((linha) => linha[coluna] === valor);
        return b;
      },
      in: (coluna: string, valores: unknown[]) => {
        filtros.push((linha) => (valores as unknown[]).includes(linha[coluna]));
        return b;
      },
      update: (patch: Record<string, unknown>) => {
        patches.push(patch);
        return b;
      },
      maybeSingle: primeira,
      single: primeira,
      then: (ok: (r: Resultado) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve(executa()).then(ok, falha),
    };
    return b;
  }

  return { db, consulta, upload, audit, atividade, patches };
});

/** O papel de quem está na sessão — muda por caso, como muda na vida real. */
let papelDaSessao: Role = "agent";
/** A organização de quem está na sessão. */
let orgDaSessao = ORG_A;

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async (minimo: Role) => {
    if (ROLE_RANK[papelDaSessao] < ROLE_RANK[minimo]) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    return {
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: { orgId: orgDaSessao, name: "Org", role: papelDaSessao },
    };
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: h.consulta, rpc: () => Promise.resolve({ error: null }) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: h.consulta,
    rpc: () => Promise.resolve({ error: null }),
    storage: { from: () => ({ upload: h.upload }) },
  }),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: h.atividade,
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));

import { GET, POST } from "@/app/api/v1/leads/[id]/attachments/route";
import { POST as MOVER } from "@/app/api/v1/leads/[id]/move/route";

const ctxDoNegocio = { params: Promise.resolve({ id: LEAD }) };

const lista = (query = "") =>
  new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments${query}`, { method: "GET" });

const moverPedido = (etapa: string) =>
  new NextRequest(`http://localhost/api/v1/leads/${LEAD}/move`, {
    method: "POST",
    body: JSON.stringify({
      stage_id: etapa,
      position_in_stage: 2000,
      expected_updated_at: CARREGADO,
    }),
    headers: { "content-type": "application/json" },
  });

function uploadPedido(campos: { file?: File | null; field_key?: string }) {
  const form = new FormData();
  if (campos.field_key) form.set("field_key", campos.field_key);
  if (campos.file) form.set("file", campos.file);
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, {
    method: "POST",
    body: form,
  });
}

const anexoDe = (sobrescrever: Record<string, unknown> = {}) => ({
  id: ANEXO,
  organization_id: ORG_A,
  lead_id: LEAD,
  field_key: "comprovante",
  file_name: "contrato.pdf",
  file_size: 1024,
  mime_type: "application/pdf",
  storage_path: CAMINHO,
  created_at: CARREGADO,
  ...sobrescrever,
});

/** O negócio, o anexo e o funil de cada cenário. Cada teste diz o que NÃO quer. */
function semear(opcoes: { anexos?: Record<string, unknown>[]; settings?: unknown } = {}) {
  for (const chave of Object.keys(h.db)) delete h.db[chave];
  h.db.crm_leads = [
    {
      id: LEAD,
      organization_id: ORG_A,
      pipeline_id: FUNIL,
      stage_id: ETAPA_A,
      status: "open",
      contact_id: null,
      updated_at: CARREGADO,
      custom_fields: {},
      won_reason: null,
    },
  ];
  h.db.crm_stages = [
    { id: ETAPA_A, pipeline_id: FUNIL, organization_id: ORG_A, name: "Entrada", is_won: false, is_lost: false },
    { id: ETAPA_X, pipeline_id: FUNIL, organization_id: ORG_A, name: "Documentação", is_won: false, is_lost: false },
  ];
  h.db.crm_pipelines = [{ id: FUNIL, organization_id: ORG_A, settings: opcoes.settings ?? EXIGE_ARQUIVO }];
  h.db.organizations = [{ id: ORG_A, currency: "BRL" }];
  h.db.crm_lead_attachments = opcoes.anexos ?? [anexoDe()];
}

beforeEach(() => {
  papelDaSessao = "agent";
  orgDaSessao = ORG_A;
  semear();
  h.patches.length = 0;
  h.upload.mockReset().mockResolvedValue({ error: null });
  h.audit.mockReset().mockResolvedValue(undefined);
  h.atividade.mockReset().mockResolvedValue({ ok: true });
});

describe("a lista de anexos não cruza organizações (#3431)", () => {
  it("A7: lead de outra organização responde 404 (nem 200, nem 403)", async () => {
    papelDaSessao = "viewer";
    orgDaSessao = ORG_B;

    const res = await GET(lista(), ctxDoNegocio);

    expect(res.status).toBe(404);
    const corpo = (await res.json()) as { data?: { files?: unknown[] } };
    expect(corpo.data?.files).toBeUndefined();
  });

  it("R2: anexo de OUTRA organização, com o mesmo lead_id, não entra na lista", async () => {
    semear({
      settings: SETTINGS_DA_ROTA,
      anexos: [
        anexoDe(),
        anexoDe({ id: ANEXO_ALHEIO, organization_id: ORG_B, file_name: "intruso.pdf", file_size: 10 }),
      ],
    });

    const res = await GET(lista(), ctxDoNegocio);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { files?: { id: string; name: string }[] } };
    expect(corpo.data?.files).toHaveLength(1);
    expect(corpo.data?.files?.[0]?.name).toBe("contrato.pdf");
  });

  it("R1: com dois campos, o `field_key` pedido devolve só o anexo dele", async () => {
    semear({
      settings: SETTINGS_DA_ROTA,
      anexos: [
        anexoDe(),
        anexoDe({ id: ANEXO_ALHEIO, field_key: "laudo", file_name: "laudo.pdf", file_size: 2048 }),
      ],
    });

    const res = await GET(lista("?field_key=comprovante"), ctxDoNegocio);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { files?: { id: string }[] } };
    expect(corpo.data?.files).toHaveLength(1);
    expect(corpo.data?.files?.[0]?.id).toBe(ANEXO);
  });
});

describe("o upload recusa antes do Storage (#3431)", () => {
  it("R3: POST sem arquivo é 422 e nada vai ao Storage", async () => {
    semear({ settings: SETTINGS_DA_ROTA });

    const res = await POST(uploadPedido({ field_key: "comprovante" }), ctxDoNegocio);

    expect(res.status).toBe(422);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("R4: formato fora da lista é 415 (PDF e imagem, só)", async () => {
    semear({ settings: SETTINGS_DA_ROTA });

    const res = await POST(
      uploadPedido({
        field_key: "comprovante",
        file: new File(["conteudo"], "planilha.csv", { type: "text/csv" }),
      }),
      ctxDoNegocio,
    );

    expect(res.status).toBe(415);
    expect(h.upload).not.toHaveBeenCalled();
  });
});

describe("o move pela rota cobra o arquivo (#3433)", () => {
  it("C1: mover para a etapa exigente SEM anexo: 422, e nada é gravado", async () => {
    semear({ anexos: [] });

    const res = await MOVER(moverPedido(ETAPA_X), ctxDoNegocio);

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as {
      error?: { code?: string; details?: { faltando?: { chave: string; tipo?: string }[] } };
    };
    expect(corpo.error?.code).toBe("required_fields_missing");
    expect(corpo.error?.details?.faltando).toEqual([
      { chave: "comprovante", rotulo: "Comprovante", tipo: "file" },
    ]);
    // A recusa veio ANTES da escrita: nenhum patch de etapa saiu.
    expect(h.patches.some((patch) => patch.stage_id === ETAPA_X)).toBe(false);
  });

  it("C2: mover para a etapa exigente COM o anexo no negócio: passa e a etapa muda", async () => {
    const res = await MOVER(moverPedido(ETAPA_X), ctxDoNegocio);

    expect(res.status).toBe(200);
    expect(h.patches[0]).toMatchObject({ stage_id: ETAPA_X });
  });
});
