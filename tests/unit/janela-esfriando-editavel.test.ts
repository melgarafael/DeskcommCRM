/**
 * #1532 — a janela de "esfriando" da etapa, exposta por toda a cadeia.
 *
 * A coluna `crm_stages.expected_duration_hours` JÁ EXISTE e o radar já a lê
 * (`lib/leads/risk-radar.ts:34-44`, `resolveStageWindow`): o que faltava era
 * ela ser editável. Este arquivo prende a cadeia inteira — PATCH, POST, GET —
 * porque cada pedaço dela pode voltar a esconder o campo sozinho.
 *
 * O QUE PROVA (e o que não):
 *  - o PATCH grava a coluna e a DEVOLVE na resposta (sem a mudança, `.strict()`
 *    recusa o campo com 422 — teste vermelho antes, verde depois);
 *  - fora de 1 a 8760 a recusa vem do INTERVALO (`fieldErrors` com a chave),
 *    não de "campo desconhecido" (`formErrors` com `Unrecognized key`);
 *  - dois controles VERDES antes e depois: PATCH sem o campo continua idêntico
 *    ao de hoje, e `name`/`is_won`/`is_lost`/`depois_de` não mudam.
 *
 * ⚠️ O QUE NÃO ESTÁ AQUI: a migration com
 * `CHECK (expected_duration_hours between 1 and 8760)`. Ela é a parte 2 do
 * escopo (#1532), portanto a coluna continua `numeric` SEM CHECK e a rede é a
 * validação de Zod + `validarJanelaDeEsfriamento`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Sem a chave de sessão de impersonação a rota devolve 503 ANTES do papel —
// o mesmo mock do `route.test.ts` vizinho, que mede a edição, não o suporte.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

import { audit } from "@/lib/audit";
import {
  ORG_ID,
  PIPE,
  authOk,
  comAutoria,
  etapa,
  funil,
  makeDb,
} from "@/tests/helpers/stages-db-double";

const urlFunil = `http://localhost/api/v1/pipelines/${PIPE}/stages`;

const ctxFunil = { params: Promise.resolve({ id: PIPE }) };
const ctxEtapa = { params: Promise.resolve({ id: PIPE, stageId: "e2" }) };

function reqPatch(body: unknown) {
  return new NextRequest(`${urlFunil}/e2`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function reqPost(body: unknown) {
  return new NextRequest(urlFunil, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** O `flatten()` do Zod, como a rota o manda em `error.details`. */
type Detalhes = { formErrors?: string[]; fieldErrors?: Record<string, string[]> };

/** Uma etapa como a resposta a devolve — campos soltos, id obrigatório. */
type EtapaVista = Record<string, unknown> & { id: string };

/**
 * O corpo das rotas de etapa: sucesso traz `data` (uma lista, ou o funil com
 * `etapas`), recusa traz `error`. `unknown` em tudo, com leituras auxiliares —
 * `any` aqui esconderia justamente a divergência de formato que os testes
 * procuram.
 */
type Corpo = {
  data?: { etapas?: EtapaVista[] } | EtapaVista[];
  error?: { message?: string; details?: Detalhes };
};

/** As etapas do corpo, seja qual for o formato da rota. */
function etapasDe(json: Corpo): EtapaVista[] {
  const data = json.data;
  if (!data) return [];
  return Array.isArray(data) ? data : (data.etapas ?? []);
}

/** A etapa `id` como a resposta a devolve. */
function etapaDe(json: Corpo, id = "e2") {
  return etapasDe(json).find((e) => e.id === id);
}

async function patch(body: unknown) {
  const { PATCH } = await import("@/app/api/v1/pipelines/[id]/stages/[stageId]/route");
  const res = await PATCH(reqPatch(body), ctxEtapa);
  return { res, json: (await res.json()) as Corpo };
}

async function post(body: unknown) {
  const { POST } = await import("@/app/api/v1/pipelines/[id]/stages/route");
  const res = await POST(reqPost(body), ctxFunil);
  return { res, json: (await res.json()) as Corpo };
}

async function get() {
  const { GET } = await import("@/app/api/v1/pipelines/[id]/stages/route");
  const res = await GET(new NextRequest(urlFunil, { method: "GET" }), ctxFunil);
  return { res, json: (await res.json()) as Corpo };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH …/stages/[stageId] — a janela de esfriando", () => {
  it("grava `expected_duration_hours` e a DEVOLVE na etapa", async () => {
    authOk();
    const db = makeDb({ stages: funil() });

    const { res, json } = await patch({ expected_duration_hours: 48 });

    expect(res.status).toBe(200);
    // Um update só, com os filtros de tenant e a autoria de sempre.
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toEqual(comAutoria({ expected_duration_hours: 48 }));
    expect(db.escritas[0]?.filtros).toContainEqual(["id", "e2"]);
    expect(db.escritas[0]?.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(db.escritas[0]?.filtros).toContainEqual(["pipeline_id", PIPE]);

    // O dado chegou ao banco…
    expect(db.tabelas.crm_stages.find((e) => e.id === "e2")?.expected_duration_hours).toBe(48);
    // …e voltou para quem pediu: sem isto a tela reabriria vazia e a próxima
    // edição gravaria por cima da configuração.
    expect(etapaDe(json)?.expected_duration_hours).toBe(48);
    // Os campos de sempre continuam na resposta, com os mesmos valores.
    expect(etapaDe(json)?.name).toBe("Proposta");
    expect(etapaDe(json)?.is_won).toBe(false);
  });

  it("`null` limpa a janela e a etapa volta ao padrão (não some da resposta)", async () => {
    authOk();
    const db = makeDb({
      stages: funil().map((e) => (e.id === "e2" ? { ...e, expected_duration_hours: 96 } : e)),
    });

    const { res, json } = await patch({ expected_duration_hours: null });

    expect(res.status).toBe(200);
    expect(db.escritas[0]?.patch).toEqual(comAutoria({ expected_duration_hours: null }));
    expect(db.tabelas.crm_stages.find((e) => e.id === "e2")?.expected_duration_hours).toBeNull();
    // `null` na resposta = "usa o padrão de 24 h/72 h", não "campo sumiu".
    expect(etapaDe(json)).toHaveProperty("expected_duration_hours", null);
  });

  /**
   * A régua da issue: inteiro entre 1 e 8760. Como a migration com CHECK
   * ficou fora do escopo, ESTE Zod é a única rede — e a recusa precisa citar o
   * intervalo (`fieldErrors.expected_duration_hours`), não dizer que o campo
   * não existe (`formErrors` com `Unrecognized key`), que era a resposta de
   * hoje para qualquer número.
   */
  it.each([0, -1, 0.5, 48.5, 8761, 100000])(
    "janela fora da faixa (%p) → 422, nenhuma escrita, recusa pelo intervalo",
    async (valor) => {
      authOk();
      const db = makeDb({ stages: funil() });

      const { res, json } = await patch({ expected_duration_hours: valor });

      expect(res.status).toBe(422);
      expect(db.escritas).toEqual([]);
      expect(db.tabelas.crm_stages.find((e) => e.id === "e2")?.expected_duration_hours).toBeNull();

      const detalhes = json.error?.details;
      expect(detalhes?.fieldErrors).toHaveProperty("expected_duration_hours");
      expect((detalhes?.formErrors ?? []).join(" ")).not.toContain("Unrecognized");
    },
  );

  // ─── CONTROLE 1: PATCH sem o campo é o de HOJE, byte a byte ───────────────
  it("controle: PATCH sem `expected_duration_hours` continua idêntico ao de hoje", async () => {
    authOk();
    const db = makeDb({ stages: funil() });

    const { res, json } = await patch({ name: "Orçamento" });

    expect(res.status).toBe(200);
    // `toEqual` exato: um campo A MAIS no update derruba o teste, inclusive
    // `expected_duration_hours: undefined` (o `undefined` some, mas a chave
    // gravada com valor não).
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toEqual(comAutoria({ name: "Orçamento" }));
    expect(db.escritas[0]?.patch).not.toHaveProperty("expected_duration_hours");
    // E a leitura continua devolvendo o que ela sempre devolveu para a tela.
    expect(etapaDe(json)?.name).toBe("Orçamento");
  });

  // ─── CONTROLE 2: name / is_won / is_lost / depois_de não mudam ────────────
  it("controle: name, is_won, is_lost e depois_de continuam exatamente como hoje", async () => {
    // Renomear: um update, só o nome, com autoria.
    authOk();
    let db = makeDb({ stages: funil() });
    let r = await patch({ name: "Orçamento" });
    expect(r.res.status).toBe(200);
    expect(db.escritas[0]?.patch).toEqual(comAutoria({ name: "Orçamento" }));

    // Ganho: DESMARCA a etapa de ganho antiga ANTES de marcar a nova
    // (`uniq_crm_stages_pipeline_won` é imediato) — dois updates, nesta ordem.
    db = makeDb({ stages: funil() });
    r = await patch({ is_won: true });
    expect(r.res.status).toBe(200);
    expect(db.escritas.map((w) => w.patch)).toEqual([
      comAutoria({ is_won: false }),
      comAutoria({ is_won: true }),
    ]);
    expect(db.escritas[0]?.filtros).toContainEqual(["id", "e3"]);
    expect(db.escritas[1]?.filtros).toContainEqual(["id", "e2"]);

    // Perda: mesma ordem, com a etapa de perda antiga.
    db = makeDb({ stages: funil() });
    r = await patch({ is_lost: true });
    expect(r.res.status).toBe(200);
    expect(db.escritas.map((w) => w.patch)).toEqual([
      comAutoria({ is_lost: false }),
      comAutoria({ is_lost: true }),
    ]);
    expect(db.escritas[0]?.filtros).toContainEqual(["id", "e4"]);

    // Ordem: `depois_de: null` manda a etapa para a primeira coluna — só
    // `position` viaja, nunca `expected_duration_hours`.
    db = makeDb({ stages: funil() });
    r = await patch({ depois_de: null });
    expect(r.res.status).toBe(200);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toEqual(comAutoria({ position: expect.any(Number) }));
    expect(db.escritas[0]?.patch).not.toHaveProperty("expected_duration_hours");
    expect(db.escritas[0]?.filtros).toContainEqual(["id", "e2"]);
  });
});

describe("POST e GET …/stages — a mesma coluna na outra ponta", () => {
  it("POST com a janela grava a coluna na etapa nova", async () => {
    authOk();
    const db = makeDb({ stages: funil() });

    const { res, json } = await post({ name: "Orçamento", expected_duration_hours: 72 });

    expect(res.status).toBe(201);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toMatchObject({ expected_duration_hours: 72 });
    const criada = (db.tabelas.crm_stages as Array<Record<string, unknown>>).find(
      (e) => e.name === "Orçamento",
    );
    expect(criada?.expected_duration_hours).toBe(72);
    expect(
      etapasDe(json).find((e) => e.name === "Orçamento")?.expected_duration_hours,
    ).toBe(72);
  });

  it("controle: POST sem a janela nasce como hoje — sem a chave no insert", async () => {
    authOk();
    const db = makeDb({ stages: funil() });

    const { res } = await post({ name: "Orçamento" });

    expect(res.status).toBe(201);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).not.toHaveProperty("expected_duration_hours");
    expect(vi.mocked(audit).mock.calls[0]?.[0]?.action).toBe("pipeline.stage_created");
  });

  it("POST fora da faixa → 422 e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil() });

    const { res, json } = await post({ name: "Orçamento", expected_duration_hours: 0 });

    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
    const detalhes = json.error?.details;
    expect(detalhes?.fieldErrors).toHaveProperty("expected_duration_hours");
  });

  it("GET devolve a janela de cada etapa — inclusive o `null` do padrão", async () => {
    authOk();
    const db = makeDb({
      stages: funil().map((e) => (e.id === "e1" ? { ...e, expected_duration_hours: 4 } : e)),
    });

    const { res, json } = await get();

    expect(res.status).toBe(200);
    const lista = etapasDe(json);
    expect(lista.find((e) => e.id === "e1")?.expected_duration_hours).toBe(4);
    expect(lista.find((e) => e.id === "e2")).toHaveProperty("expected_duration_hours", null);
    // O select continua trazendo o resto — a projeção não foi trocada.
    expect(lista.find((e) => e.id === "e3")).toMatchObject({ name: "Pago", is_won: true });
    void db;
  });
});
