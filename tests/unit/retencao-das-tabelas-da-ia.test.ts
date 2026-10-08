import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GET,
  type PodaDb,
  type ResultadoDaRetencao,
  TAMANHO_DO_LOTE,
  houveEfeito,
  podarHistorico,
} from "@/app/api/v1/cron/data-retention/route";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import {
  RETENCAO_CHECKPOINTS_DIAS_PADRAO,
  RETENCAO_CHECKPOINTS_DIAS_PISO,
  RETENCAO_COPIAS_ENVIADAS_DIAS_PADRAO,
  RETENCAO_COPIAS_ENVIADAS_DIAS_PISO,
  RETENCAO_RITMO_DE_ENVIO_DIAS_PADRAO,
  RETENCAO_RITMO_DE_ENVIO_DIAS_PISO,
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
} from "@/lib/retencao/politica";

/**
 * AS TABELAS APPEND-ONLY DA IA ENTRAM NA PODA DIÁRIA (migration 0587).
 *
 * Antes: zero `delete` em `llm_calls`, `metrics`, `skill_activations`,
 * `ai_router_decisions`, `pacing_ledger`, `outbound_copies` e
 * `lead_checkpoints`. Este arquivo mede o lado do CRON (qual função, com que
 * prazo, e que a rodada que só apagou aqui ainda deixa rastro) e o TEXTO das
 * guardas no baseline que o kit aplica. O que o banco de fato preserva — o
 * último checkpoint da fronteira, o piso, o privilégio — é medido contra um
 * Postgres em `tests/invariants/retencao-das-tabelas-da-ia.test.ts`.
 */

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo", INTERNAL_SECRET: "" },
}));
const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

/** Quanto cada função devolve no handler HTTP; o resto devolve 0. */
let apagadasPorFuncao: Record<string, number> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (nome: string) => ({ data: apagadasPorFuncao[nome] ?? 0, error: null }),
    from: () => {
      const q: Record<string, unknown> = {
        eq: () => q,
        in: () => q,
        limit: () => q,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      const apagando: Record<string, unknown> = {
        lt: () => apagando,
        select: () => apagando,
        order: () => apagando,
        limit: () => apagando,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return { select: () => q, update: () => q, delete: () => apagando };
    },
  }),
}));

const NOVAS = {
  "fn_expurgar_telemetria_de_ia_vencida": {
    chave: "AI_TELEMETRY_RETENTION_DAYS",
    padrao: RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
    piso: RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
    campo: "telemetria_de_ia_apagada",
  },
  "fn_expurgar_ritmo_de_envio_vencido": {
    chave: "PACING_LEDGER_RETENTION_DAYS",
    padrao: RETENCAO_RITMO_DE_ENVIO_DIAS_PADRAO,
    piso: RETENCAO_RITMO_DE_ENVIO_DIAS_PISO,
    campo: "ritmo_de_envio_apagado",
  },
  "fn_expurgar_copias_enviadas_vencidas": {
    chave: "OUTBOUND_COPIES_RETENTION_DAYS",
    padrao: RETENCAO_COPIAS_ENVIADAS_DIAS_PADRAO,
    piso: RETENCAO_COPIAS_ENVIADAS_DIAS_PISO,
    campo: "copias_enviadas_apagadas",
  },
  "fn_expurgar_checkpoints_superados": {
    chave: "LEAD_CHECKPOINT_RETENTION_DAYS",
    padrao: RETENCAO_CHECKPOINTS_DIAS_PADRAO,
    piso: RETENCAO_CHECKPOINTS_DIAS_PISO,
    campo: "checkpoints_apagados",
  },
} as const;
type Nova = keyof typeof NOVAS;
const NOMES = Object.keys(NOVAS) as Nova[];

function bancoGravador(devolve: Partial<Record<string, number[]>> = {}): {
  db: PodaDb;
  chamadas: { nome: string; dias: number }[];
} {
  const chamadas: { nome: string; dias: number }[] = [];
  const restante = Object.fromEntries(Object.entries(devolve).map(([k, v]) => [k, [...(v ?? [])]]));
  const db: PodaDb = {
    async rpc(nome, args) {
      chamadas.push({ nome, dias: args.p_retencao_dias });
      return { data: restante[nome]?.shift() ?? 0, error: null };
    },
    async apagarRascunhos() {
      return { data: 0, error: null };
    },
    // A poda de mídia (0557) roda antes das quatro desta suíte; aqui ela não acha nada.
    async enfileirarMidia() {
      return { data: { vencidas: 0, orfas: 0 }, error: null };
    },
  };
  return { db, chamadas };
}

describe("podarHistorico — as quatro podas da IA", () => {
  it("sem knob, chama cada função UMA vez com o padrão e sem aviso", async () => {
    const { db, chamadas } = bancoGravador();
    const r = await podarHistorico(db, {});
    for (const nome of NOMES) {
      const desta = chamadas.filter((c) => c.nome === nome);
      expect(desta, nome).toEqual([{ nome, dias: NOVAS[nome].padrao }]);
    }
    expect(r.avisos).toEqual([]);
  });

  it.each(NOMES)("%s: knob abaixo do piso é ELEVADO, com aviso nomeando a chave", async (nome) => {
    const { chave, piso } = NOVAS[nome];
    const { db, chamadas } = bancoGravador();
    const r = await podarHistorico(db, { [chave]: "1" } as Parameters<typeof podarHistorico>[1]);
    expect(chamadas.find((c) => c.nome === nome)?.dias).toBe(piso);
    expect(r.avisos).toEqual([expect.stringContaining(chave)]);
  });

  it("drena em lotes: lote cheio pede outro, lote incompleto para", async () => {
    const { db, chamadas } = bancoGravador({
      fn_expurgar_checkpoints_superados: [TAMANHO_DO_LOTE, 3],
    });
    const r = await podarHistorico(db, {});
    expect(chamadas.filter((c) => c.nome === "fn_expurgar_checkpoints_superados")).toHaveLength(2);
    expect(r.checkpoints_apagados).toBe(TAMANHO_DO_LOTE + 3);
    expect(r.lotes_checkpoints).toBe(2);
    expect(r.checkpoints_tem_resto).toBe(false);
  });

  it("o relatório traz o prazo efetivo de cada uma", async () => {
    const { db } = bancoGravador();
    const r = await podarHistorico(db, { AI_TELEMETRY_RETENTION_DAYS: "500" });
    expect(r.retencao_telemetria_de_ia_dias).toBe(500);
    expect(r.retencao_ritmo_de_envio_dias).toBe(RETENCAO_RITMO_DE_ENVIO_DIAS_PADRAO);
    expect(r.retencao_copias_enviadas_dias).toBe(RETENCAO_COPIAS_ENVIADAS_DIAS_PADRAO);
    expect(r.retencao_checkpoints_dias).toBe(RETENCAO_CHECKPOINTS_DIAS_PADRAO);
  });
});

describe("houveEfeito — rodada que só podou a IA ainda audita", () => {
  it.each(NOMES)("só %s apagou → houve efeito", async (nome) => {
    const { db } = bancoGravador({ [nome]: [1] });
    const r: ResultadoDaRetencao = await podarHistorico(db, {});
    expect(r[NOVAS[nome].campo]).toBe(1);
    expect(houveEfeito(r)).toBe(true);
  });

  it("nada apagado → sem efeito (a outra direção)", async () => {
    const { db } = bancoGravador();
    expect(houveEfeito(await podarHistorico(db, {}))).toBe(false);
  });
});

describe("o handler HTTP", () => {
  beforeEach(() => {
    auditou.mockClear();
    apagadasPorFuncao = {};
  });

  it("rodada que só apagou checkpoint superado grava retention.sweep_run com a contagem", async () => {
    apagadasPorFuncao = { fn_expurgar_checkpoints_superados: 4 };
    const resposta = await GET({ headers: new Headers({ authorization: "Bearer segredo" }) } as never);
    expect(resposta.status).toBe(200);
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { checkpoints_apagados: 4, jobs_apagados: 0 },
    });
  });
});

describe("as guardas moram no corpo das funções do baseline", () => {
  const RAIZ = join(__dirname, "..", "..");
  const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
  const MIGRATION = readFileSync(
    join(RAIZ, "supabase", "migrations", "20261007131344_0587_retencao_das_tabelas_da_ia.sql"),
    "utf8",
  );

  function corpo(fonte: string, nome: Nova): string {
    const i = fonte.lastIndexOf(`create or replace function public.${nome}(`);
    if (i < 0) throw new Error(`INSTRUMENTO: ${nome} ausente`);
    return fonte.slice(i, fonte.indexOf("$$;", i));
  }

  it.each(NOMES)("%s: o corpo do baseline é o MESMO da migration", (nome) => {
    // O kit aplica só o baseline; o Supabase CLI, só a migration. Corpos
    // divergentes = clone e instalação nova podando com regras diferentes.
    expect(corpo(BASELINE, nome)).toBe(corpo(MIGRATION, nome));
  });

  it.each(NOMES)("%s: revogada das duas origens e concedida só ao servidor", (nome) => {
    expect(BASELINE).toContain(
      `revoke execute on function public.${nome}(int,int) from public, anon, authenticated;`,
    );
    expect(BASELINE).toContain(`grant  execute on function public.${nome}(int,int) to service_role;`);
  });

  it.each(NOMES)("%s: o único parâmetro é idade e lote — sem seletor de linha", (nome) => {
    const assinatura = corpo(BASELINE, nome).slice(0, 200);
    expect(assinatura).toMatch(/\(\s*p_retencao_dias int default null,\s*p_limite int default null\s*\)/);
  });

  it("telemetria: a cópia legada da 0130 não sai (o update.sh a ressuscitaria)", () => {
    expect(corpo(BASELINE, "fn_expurgar_telemetria_de_ia_vencida")).toContain(
      "c.legacy_invocation_id is null",
    );
  });

  it("ritmo: só sai quem tem um envio MAIS NOVO do mesmo número", () => {
    expect(corpo(BASELINE, "fn_expurgar_ritmo_de_envio_vencido")).toMatch(
      /n\.channel_session_id = p\.channel_session_id\s+and n\.sent_at > p\.sent_at/,
    );
  });

  it("cópias: a janela mínima no SQL é a de SPINNING_DEFAULTS", () => {
    // Duas cópias do número 20: se o default do gate subir e o SQL não, a poda
    // apagaria o que o gate ainda compara.
    const c = corpo(BASELINE, "fn_expurgar_copias_enviadas_vencidas");
    expect(c).toContain(`greatest(${SPINNING_DEFAULTS.windowSize}, case when`);
    expect(c).toContain(`coalesce(j.janela, ${SPINNING_DEFAULTS.windowSize})`);
  });

  it("checkpoints: a fronteira são as MESMAS colunas que latestCheckpoint filtra", () => {
    const c = corpo(BASELINE, "fn_expurgar_checkpoints_superados");
    const leitor = readFileSync(join(RAIZ, "lib", "agent-engine", "agent", "inbound-turn.ts"), "utf8");
    // As colunas do recorte do leitor, lidas do PRÓPRIO leitor: se a fronteira
    // ganhar uma coluna lá, este caso exige que a poda a acompanhe.
    const recorte = /and conversation_id=\$3 and service_revision=\$4 and demanda_id is not distinct from \$5::uuid and demanda_revision is not distinct from \$6::bigint/;
    expect(leitor).toMatch(recorte);
    for (const col of ["conversation_id", "service_revision", "demanda_id", "demanda_revision"]) {
      expect(c, col).toContain(`n.${col} is not distinct from k.${col}`);
    }
    expect(c).toContain("n.seq > k.seq");
    expect(c).toContain("payload->>'origin_job_id'");
    expect(c).toContain("j.status in ('pending', 'running')");
  });

  it("event_log fica FORA de toda poda nova", () => {
    for (const nome of NOMES) expect(corpo(BASELINE, nome), nome).not.toContain("event_log");
  });
});
