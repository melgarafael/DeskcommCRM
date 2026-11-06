// @vitest-environment node
//
// CRIAR UM NEGÓCIO NUMA ETAPA QUE EXIGE UM CAMPO DE ARQUIVO (issue #3433) ─────
//
// ─── O defeito, medido na main antes do conserto ────────────────────────────
//
// O anexo mora em `crm_lead_attachments.lead_id`: só pode ser enviado DEPOIS
// que o negócio existe. Mas o campo `file` com `obrigatorio_em.etapas = [X]` era
// cobrado na CRIAÇÃO, quando `camposComAnexo` é `undefined` por construção — e
// sem ele o campo `file` conta sempre como vazio. Resultado: criar direto na
// etapa X devolvia 422 `required_fields_missing` com o campo de arquivo em
// `details.faltando`, e não havia saída: nem pela tela (o `NewLeadDialog` mostra
// "Os anexos ficam no negócio." no lugar do uploader), nem pela API, nem pela
// captação. Nem anexar antes (o negócio não existe), nem criar sem o anexo.
//
// ─── O conserto, e o que estes casos provam ─────────────────────────────────
//
// Uma opção EXPLÍCITA na régua, `semAnexosAinda`, que pula o campo `file`. Só a
// CRIAÇÃO a passa (`createLeadHandler` e o `NewLeadDialog`). O move, o lote, o
// encerramento, o fechamento e o clone seguem como estão — é neles que
// `camposComAnexo` é lido de verdade, e a exigência do documento continua
// valendo ali.
//
// 1. a régua PURA, com `semAnexosAinda`, não devolve o campo de arquivo;
// 2. CONTROLE — sem a opção, a MESMA régua continua devolvendo (o pulo é opt-in,
//    não um afrouxamento global);
// 3. CONTROLE — o MOVE continua cobrando o arquivo: com `camposComAnexo` vazio o
//    campo falta; com o anexo na tabela ele passa;
// 4. `createLeadHandler` CRIA direto na etapa que exige o arquivo — era o 422;
// 5. CONTROLE — a criação continua recusando um campo de TEXTO exigido e não
//    preenchido (a régua não foi desligada na criação);
// 6. com um campo de texto E um de arquivo exigidos na mesma etapa, a recusa da
//    criação cita SÓ o de texto — o pulo é do `type === "file"`, não do campo.
//
// Sabotagem prevista (escrita ANTES de reverter, ver ANEXO-VIEWER-SABOTAGEM.md):
// removida a linha que pula `type === "file"` em `lib/leads/campos-exigidos.ts`,
// caem os casos 1, 4 e 6 (3 de 6) e ficam verdes os controles 2, 3 e 5.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { recusaDeCamposObrigatorios, validaCamposExigidos } from "@/lib/leads/campos-exigidos";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** O funil que exige o ARQUIVO para receber o negócio na etapa `ETAPA`. */
const EXIGE_ARQUIVO = {
  fields: [
    { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [ETAPA] } },
  ],
};

/** O mesmo, com um campo de TEXTO exigido junto — o controle do recorte. */
const EXIGE_TEXTO_E_ARQUIVO = {
  fields: [
    { key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { etapas: [ETAPA] } },
    { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [ETAPA] } },
  ],
};

const DESTINO = { stageId: ETAPA, desfecho: null };

const ctx = {
  organization_id: ORG,
  actor: { type: "user" as const, id: "user-1" },
  requestId: "req-1",
};

const payloadBase = {
  pipeline_id: FUNIL,
  stage_id: ETAPA,
  title: "Negócio numa etapa que pede documento",
  tags: [],
  source: "manual",
};

type Resposta = { data: unknown; error: { message: string } | null };

/**
 * Supabase de mentira, encadeável, que responde por TABELA + MÉTODO + ORDEM —
 * o mesmo desenho de `criacao-na-etapa-exigente-passa-pela-regua.test.ts`, para
 * que a diferença entre os dois arquivos seja o CAMPO exigido, não o dublê.
 */
function supabaseFake(responder: (tabela: string, metodo: string, ordem: number) => Resposta) {
  const ordens: Record<string, number> = {};
  const inseridos: Record<string, unknown>[] = [];

  const proxima = (tabela: string, metodo: string): Resposta => {
    const chave = `${tabela}:${metodo}`;
    ordens[chave] = (ordens[chave] ?? 0) + 1;
    return responder(tabela, metodo, ordens[chave]);
  };

  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const cadeia = () => q;
    for (const nome of ["select", "eq", "neq", "is", "order", "limit"]) q[nome] = cadeia;
    q.insert = (linha: Record<string, unknown>) => {
      inseridos.push(linha);
      return q;
    };
    q.update = () => q;
    q.maybeSingle = async () => proxima(tabela, "maybeSingle");
    q.single = async () => {
      const r = proxima(tabela, "single");
      return r.data === null && r.error === null
        ? { data: { ...inseridos.at(-1), id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, error: null }
        : r;
    };
    q.then = (ok: (v: Resposta) => void) => {
      ok(proxima(tabela, "lista"));
    };
    return q;
  };

  return { cliente: { from } as never, inseridos };
}

/** O cenário de CRIAÇÃO: a etapa de `FUNIL` e o `settings` do funil. */
function criacao(settings: unknown) {
  return supabaseFake((tabela, metodo) => {
    if (tabela === "crm_stages" && metodo === "maybeSingle") {
      return { data: { id: ETAPA, pipeline_id: FUNIL, organization_id: ORG }, error: null };
    }
    if (tabela === "crm_pipelines" && metodo === "maybeSingle") {
      return { data: { settings }, error: null };
    }
    if (tabela === "organizations" && metodo === "maybeSingle") {
      return { data: { currency: "BRL" }, error: null };
    }
    return { data: null, error: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a régua pura — `semAnexosAinda` pula SÓ o campo de arquivo", () => {
  it("com `semAnexosAinda`, o campo de arquivo exigido não é cobrado", () => {
    const faltando = validaCamposExigidos({
      lead: { custom_fields: {} },
      settingsDoFunil: EXIGE_ARQUIVO,
      destino: DESTINO,
      motivoDeGanho: null,
      semAnexosAinda: true,
    }).faltando;

    expect(faltando).toEqual([]);
  });

  it("CONTROLE: sem a opção, a MESMA régua continua devolvendo o arquivo", () => {
    const faltando = validaCamposExigidos({
      lead: { custom_fields: {} },
      settingsDoFunil: EXIGE_ARQUIVO,
      destino: DESTINO,
      motivoDeGanho: null,
    }).faltando;

    expect(faltando.map((campo) => campo.chave)).toEqual(["comprovante"]);
  });

  it("CONTROLE: o MOVE continua cobrando o arquivo — vazio falta, anexo passa", () => {
    const semAnexo = validaCamposExigidos({
      lead: { custom_fields: {} },
      settingsDoFunil: EXIGE_ARQUIVO,
      destino: DESTINO,
      motivoDeGanho: null,
      camposComAnexo: new Set<string>(),
    }).faltando;
    expect(semAnexo.map((campo) => campo.chave)).toEqual(["comprovante"]);

    const comAnexo = validaCamposExigidos({
      lead: { custom_fields: {} },
      settingsDoFunil: EXIGE_ARQUIVO,
      destino: DESTINO,
      motivoDeGanho: null,
      camposComAnexo: new Set<string>(["comprovante"]),
    }).faltando;
    expect(comAnexo).toEqual([]);
  });
});

describe("createLeadHandler — criar numa etapa que exige arquivo", () => {
  it("cria o negócio direto na etapa que exige o arquivo (era 422 sem saída)", async () => {
    const { cliente, inseridos } = criacao(EXIGE_ARQUIVO);

    await createLeadHandler(cliente, ctx, payloadBase);

    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]).toMatchObject({ stage_id: ETAPA, title: payloadBase.title });
  });

  it("CONTROLE: campo de TEXTO exigido e não preenchido continua recusando", async () => {
    const { cliente, inseridos } = criacao(EXIGE_TEXTO_E_ARQUIVO);

    const erro = await createLeadHandler(cliente, ctx, payloadBase).catch((e: unknown) => e);

    const faltando = [{ chave: "concorrente", rotulo: "Concorrente", tipo: "text" as const }];
    expect(erro).toMatchObject({
      name: "ApiError",
      status: 422,
      code: "required_fields_missing",
      details: { faltando },
    });
    // A MESMA frase de sempre: o pulo do arquivo não inventou vocabulário novo.
    expect((erro as Error).message).toBe(recusaDeCamposObrigatorios(faltando, undefined).mensagem);
    expect(inseridos).toHaveLength(0);
  });

  it("com texto E arquivo exigidos, a recusa da criação cita SÓ o de texto", async () => {
    const { cliente } = criacao(EXIGE_TEXTO_E_ARQUIVO);

    const erro = await createLeadHandler(cliente, ctx, payloadBase).catch((e: unknown) => e);

    const detalhes = (erro as { details: { faltando: { chave: string; tipo?: string }[] } }).details;
    expect(detalhes.faltando.map((campo) => campo.chave)).toEqual(["concorrente"]);
    // O pulo é do `type === "file"`, não do campo: o de texto continua lá.
    expect(detalhes.faltando.some((campo) => campo.tipo === "file")).toBe(false);
  });
});
