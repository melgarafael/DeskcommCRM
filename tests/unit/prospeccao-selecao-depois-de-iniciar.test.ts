/**
 * MARCAR, DESMARCAR E EXCLUIR EMPRESAS DEPOIS DE INICIADA (campanha pausada).
 *
 * O efeito sobre linhas e o isolamento entre organizações estão em
 * `tests/invariants/prospecting-selecao-depois-de-iniciar.test.ts`, num Postgres de verdade.
 * Aqui, sem banco: o formato aceito pelas ações novas, a ordem das guardas nas funções e o
 * TEXTO dos três comandos, onde mora o que eles não podem alcançar.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: vi.fn(),
  beginServiceAtOrigin: vi.fn(),
}));

import { prospectingInputSchema } from "@/lib/prospecting/schema";
import {
  DESCARTAR_DESMARCADAS_SQL,
  FILA_DESMARCAR_SQL,
  FILA_REMARCAR_SQL,
  descartarDesmarcadas,
  selecionarNaFila,
} from "@/lib/prospecting/store";

const ORG = "0b130000-0000-4000-8000-000000000001";
const CAMPANHA = "0b130000-1111-4000-8000-000000000001";
const EMPRESA = "0b130000-2222-4000-8000-000000000001";
const plano = (sql: string) => sql.replace(/\s+/g, " ");

describe("as ações novas aceitam só o que precisam", () => {
  it("select_in_queue aceita lista de empresas e um booleano", () => {
    expect(
      prospectingInputSchema.safeParse({
        action: "select_in_queue",
        id: CAMPANHA,
        candidate_ids: [EMPRESA],
        selected: false,
      }).success,
    ).toBe(true);
  });

  it("select_in_queue recusa lista vazia, sem lista e campo a mais (inclusive a organização no corpo)", () => {
    const base = {
      action: "select_in_queue",
      id: CAMPANHA,
      candidate_ids: [EMPRESA],
      selected: true,
    };
    expect(prospectingInputSchema.safeParse({ ...base, candidate_ids: [] }).success).toBe(false);
    expect(
      prospectingInputSchema.safeParse({ action: "select_in_queue", id: CAMPANHA, selected: true })
        .success,
    ).toBe(false);
    expect(prospectingInputSchema.safeParse({ ...base, organization_id: "outra" }).success).toBe(
      false,
    );
  });

  it("discard_unselected aceita só o id da campanha", () => {
    expect(
      prospectingInputSchema.safeParse({ action: "discard_unselected", id: CAMPANHA }).success,
    ).toBe(true);
    expect(
      prospectingInputSchema.safeParse({ action: "discard_unselected", id: CAMPANHA, force: true })
        .success,
    ).toBe(false);
    expect(prospectingInputSchema.safeParse({ action: "discard_unselected" }).success).toBe(false);
  });
});

type Linha = { status: string; config: Record<string, unknown> | null };
function poolDeMentira(campanha: Linha | null) {
  const consultas: { texto: string; params: unknown[] }[] = [];
  const cliente = {
    query: vi.fn(async (texto: string, params: unknown[] = []) => {
      consultas.push({ texto, params });
      if (texto.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (texto.startsWith("select status")) return { rows: campanha ? [campanha] : [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => cliente } as never, consultas };
}
const escreveu = (consultas: { texto: string }[]) =>
  consultas.some((q) => /^(update|delete) prospecting_candidates/.test(q.texto));

describe("selecionarNaFila: só com a campanha pausada", () => {
  it("campanha que não existe: 404, sem escrever", async () => {
    const { pool, consultas } = poolDeMentira(null);
    await expect(selecionarNaFila(pool, ORG, CAMPANHA, [EMPRESA], false)).rejects.toMatchObject({
      status: 404,
    });
    expect(escreveu(consultas)).toBe(false);
  });

  it.each(["running", "draft", "completed"])("campanha %s: 409, sem escrever", async (status) => {
    const { pool, consultas } = poolDeMentira({ status, config: { funnel_entry: "on_send" } });
    await expect(selecionarNaFila(pool, ORG, CAMPANHA, [EMPRESA], false)).rejects.toMatchObject({
      status: 409,
    });
    expect(escreveu(consultas)).toBe(false);
  });

  it("pausada sem configuração: 409, sem escrever", async () => {
    const { pool, consultas } = poolDeMentira({ status: "paused", config: null });
    await expect(selecionarNaFila(pool, ORG, CAMPANHA, [EMPRESA], true)).rejects.toMatchObject({
      status: 409,
    });
    expect(escreveu(consultas)).toBe(false);
  });

  it("desmarcar usa o comando de desmarcar, com organização, campanha, ids e o motivo do operador", async () => {
    const { pool, consultas } = poolDeMentira({
      status: "paused",
      config: { funnel_entry: "on_send" },
    });
    await selecionarNaFila(pool, ORG, CAMPANHA, [EMPRESA], false);
    const q = consultas.find((c) => c.texto === FILA_DESMARCAR_SQL);
    expect(q?.params).toEqual([ORG, CAMPANHA, [EMPRESA], "Não selecionada pelo operador."]);
  });

  it("marcar leva `true` para quem cria a empresa só no envio, e `false` para o modo antigo ou sem a chave", async () => {
    const modo = async (config: Record<string, unknown>) => {
      const { pool, consultas } = poolDeMentira({ status: "paused", config });
      await selecionarNaFila(pool, ORG, CAMPANHA, [EMPRESA], true);
      return consultas.find((c) => c.texto === FILA_REMARCAR_SQL)?.params[4];
    };
    expect(await modo({ funnel_entry: "on_send" })).toBe(true);
    expect(await modo({ funnel_entry: "on_start" })).toBe(false);
    expect(await modo({}), "configuração gravada antes da chave existir é o modo antigo").toBe(
      false,
    );
  });
});

describe("descartarDesmarcadas: só rascunho ou pausada", () => {
  it.each(["running", "completed"])("campanha %s: 409, sem escrever", async (status) => {
    const { pool, consultas } = poolDeMentira({ status, config: null });
    await expect(descartarDesmarcadas(pool, ORG, CAMPANHA)).rejects.toMatchObject({ status: 409 });
    expect(escreveu(consultas)).toBe(false);
  });

  it.each(["draft", "paused"])(
    "campanha %s: apaga com organização, campanha e o motivo do operador",
    async (status) => {
      const { pool, consultas } = poolDeMentira({ status, config: null });
      await descartarDesmarcadas(pool, ORG, CAMPANHA);
      expect(consultas.find((c) => c.texto === DESCARTAR_DESMARCADAS_SQL)?.params).toEqual([
        ORG,
        CAMPANHA,
        "Não selecionada pelo operador.",
      ]);
    },
  );
});

describe("o texto dos comandos carrega as guardas no próprio where", () => {
  it("desmarcar: só `queued`, da organização e da campanha", () => {
    const t = plano(FILA_DESMARCAR_SQL);
    expect(t).toContain("where organization_id=$1 and campaign_id=$2");
    expect(t).toContain("status='queued'");
  });

  it("marcar: só quem o operador tirou — `skipped`, `selected=false` e o motivo exato —, e o modo antigo só devolve quem já tem conversa", () => {
    const t = plano(FILA_REMARCAR_SQL);
    expect(t).toContain("where organization_id=$1 and campaign_id=$2");
    expect(t).toContain("status='skipped' and selected=false and error=$4");
    expect(t).toContain("($5::boolean or conversation_id is not null)");
  });

  it("excluir: nada que já virou registro do CRM e nunca a linha-tomba de supressão", () => {
    const t = plano(DESCARTAR_DESMARCADAS_SQL);
    expect(t).toContain("where organization_id=$1 and campaign_id=$2");
    expect(t).toContain("selected=false");
    expect(t).toContain("contact_id is null and lead_id is null and conversation_id is null");
    expect(t).toContain("suppression_salt is null");
  });
});

describe("o envio só pega o que está na fila (leitura do worker)", () => {
  const worker = fs.readFileSync(
    path.resolve(__dirname, "../../lib/prospecting/worker.ts"),
    "utf8",
  );

  it("o candidato do próximo envio sai de `status='queued'`, então a desmarcada (skipped) nunca é alcançada", () => {
    const i = worker.indexOf("select * from prospecting_candidates");
    expect(
      i,
      "o worker precisa continuar escolhendo o próximo candidato por consulta",
    ).toBeGreaterThan(-1);
    expect(worker.slice(i, i + 220)).toContain("status='queued'");
  });
});
