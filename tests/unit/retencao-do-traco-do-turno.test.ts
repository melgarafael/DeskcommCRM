/**
 * O CRON PÕE O TRAÇO DO TURNO NA PODA — COM A MESMA JANELA DA TELEMETRIA (9021).
 *
 * A 0721 gravou o traço e a tabela não aparecia em poda nenhuma (#3201, fatia 2
 * da #2869). O que este arquivo mede, no lado do TypeScript:
 *
 *   1. o cron drena `fn_expurgar_traco_do_turno_vencido` pelo MESMO laço das
 *      irmãs, com o prazo vindo do knob da telemetria da IA — a issue deixa
 *      aberta "janela própria ou a da telemetria?" e a resposta é a segunda, sem
 *      variável nova;
 *   2. rodada que só apagou traço ainda deixa rastro (`houveEfeito`);
 *   3. o corpo do SQL que roda no clone (baseline) é LITERALMENTE o da migration
 *      — quem instala pelo Supabase CLI e quem instala pelo kit não podem podar
 *      com regras diferentes;
 *   4. o padrão e o piso do SQL são os MESMOS números de
 *      `lib/retencao/politica.ts`: um deles mudando sozinho é a divergência que
 *      o comentário das irmãs avisa para não acontecer.
 *
 * O comportamento contra um Postgres de verdade (o piso, o lote, o leitor
 * alcançando o que ficou) está em
 * `tests/invariants/traco-do-turno-tem-prazo.test.ts`, porque é o banco que o
 * aplica.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type PodaDb,
  TAMANHO_DO_LOTE,
  houveEfeito,
  podarHistorico,
} from "@/app/api/v1/cron/data-retention/route";
import {
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
} from "@/lib/retencao/politica";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo", INTERNAL_SECRET: "" },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: 0, error: null }),
    from: () => ({
      delete: () => ({ lt: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }),
    }),
  }),
}));

const FN = "fn_expurgar_traco_do_turno_vencido";
const RAIZ = join(__dirname, "..", "..");
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
const MIGRATION = readFileSync(
  join(RAIZ, "supabase", "migrations", "20261027013000_9021_o_traco_do_turno_tem_prazo.sql"),
  "utf8",
);
const CRON = readFileSync(join(RAIZ, "app", "api", "v1", "cron", "data-retention", "route.ts"), "utf8");

function bancoGravador(devolve: Record<string, number[]> = {}): {
  db: PodaDb;
  chamadas: { nome: string; dias: number; limite: number }[];
} {
  const chamadas: { nome: string; dias: number; limite: number }[] = [];
  const restante = Object.fromEntries(Object.entries(devolve).map(([k, v]) => [k, [...v]]));
  const db: PodaDb = {
    async rpc(nome, args) {
      chamadas.push({ nome, dias: args.p_retencao_dias, limite: args.p_limite });
      return { data: restante[nome]?.shift() ?? 0, error: null };
    },
    async apagarRascunhos() {
      return { data: 0, error: null };
    },
    async enfileirarMidia() {
      return { data: { vencidas: 0, orfas: 0 }, error: null };
    },
  };
  return { db, chamadas };
}

const daPodaDoTraco = (chamadas: { nome: string; dias: number; limite: number }[]) =>
  chamadas.filter((c) => c.nome === FN);

describe("o cron drena o traço do turno com o prazo da telemetria da IA", () => {
  it("sem knob, uma chamada com o padrão da telemetria e o lote do laço", async () => {
    const { db, chamadas } = bancoGravador();
    const r = await podarHistorico(db, {});

    expect(daPodaDoTraco(chamadas)).toEqual([
      { nome: FN, dias: RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO, limite: TAMANHO_DO_LOTE },
    ]);
    expect(r.retencao_traco_dias).toBe(RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO);
  });

  it("o knob da telemetria move as DUAS podas — o traço não tem janela própria", async () => {
    const { db, chamadas } = bancoGravador();
    const r = await podarHistorico(db, { AI_TELEMETRY_RETENTION_DAYS: "500" });

    expect(daPodaDoTraco(chamadas)[0]?.dias).toBe(500);
    expect(chamadas.find((c) => c.nome === "fn_expurgar_telemetria_de_ia_vencida")?.dias).toBe(500);
    expect(r.retencao_traco_dias).toBe(500);
  });

  it("knob abaixo do piso é elevado, com aviso nomeando a chave", async () => {
    const { db, chamadas } = bancoGravador();
    const r = await podarHistorico(db, { AI_TELEMETRY_RETENTION_DAYS: "1" });

    expect(daPodaDoTraco(chamadas)[0]?.dias).toBe(RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO);
    expect(r.avisos).toEqual([expect.stringContaining("AI_TELEMETRY_RETENTION_DAYS")]);
  });

  it("drena em lotes: lote cheio pede outro, lote incompleto para", async () => {
    const { db, chamadas } = bancoGravador({ [FN]: [TAMANHO_DO_LOTE, 3] });
    const r = await podarHistorico(db, {});

    expect(daPodaDoTraco(chamadas)).toHaveLength(2);
    expect(r.tracos_apagados).toBe(TAMANHO_DO_LOTE + 3);
    expect(r.lotes_tracos).toBe(2);
    expect(r.tracos_tem_resto).toBe(false);
  });

  it("a falha da poda do traço é NOMEADA e não derruba as irmãs", async () => {
    const { db, chamadas } = bancoGravador();
    const original = db.rpc.bind(db);
    db.rpc = async (nome, args) => {
      if (nome === FN) return { data: null, error: { message: "permission denied" } };
      return original(nome, args);
    };

    const r = await podarHistorico(db, {});
    expect(r.falhas).toEqual([expect.stringContaining(FN)]);
    // As outras podas seguiram: o traço não é o dia inteiro.
    expect(chamadas.some((c) => c.nome === "fn_expurgar_telemetria_de_ia_vencida")).toBe(true);
  });
});

describe("rodada que só apagou traço ainda audita", () => {
  it("tracos_apagados > 0 → houve efeito", async () => {
    const { db } = bancoGravador({ [FN]: [7] });
    const r = await podarHistorico(db, {});
    expect(r.tracos_apagados).toBe(7);
    expect(houveEfeito(r)).toBe(true);
  });

  it("nada apagado → sem efeito (a outra direção)", async () => {
    const { db } = bancoGravador();
    expect(houveEfeito(await podarHistorico(db, {}))).toBe(false);
  });
});

describe("o SQL do traço: forma da família e mesmos números do TypeScript", () => {
  function corpo(fonte: string): string {
    const i = fonte.lastIndexOf(`create or replace function public.${FN}(`);
    expect(i, `INSTRUMENTO: ${FN} ausente`).toBeGreaterThan(-1);
    return fonte.slice(i, fonte.indexOf("$$;", i));
  }

  it("o corpo do baseline é o MESMO da migration 9021", () => {
    // O kit aplica só o baseline; o Supabase CLI, só a migration. Corpos
    // divergentes = clone e instalação nova podando com regras diferentes.
    expect(corpo(BASELINE)).toBe(corpo(MIGRATION));
  });

  it("é definer, sem seletor de linha, e o piso mora no corpo", () => {
    const c = corpo(BASELINE);
    expect(c).toContain("security definer");
    expect(c).toContain("set search_path = public, pg_temp");
    // A assinatura: só idade e lote, nenhum parâmetro de organização/contato/id.
    expect(c).toMatch(
      new RegExp(
        `create or replace function public\\.${FN}\\(\\s*p_retencao_dias int default null,\\s*p_limite int default null\\s*\\)`,
      ),
    );
    expect(c).toContain(`greatest(coalesce(p_retencao_dias, ${RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO}), ${RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO})`);
    expect(c).toContain("interval");
    expect(c).toContain("limit v_limite");
  });

  it("revogada das duas origens e concedida só ao servidor, nos DOIS artefatos", () => {
    for (const fonte of [BASELINE, MIGRATION]) {
      expect(fonte).toContain(
        `revoke execute on function public.${FN}(int,int) from public, anon, authenticated;`,
      );
      expect(fonte).toContain(`grant  execute on function public.${FN}(int,int) to service_role;`);
    }
  });

  it("o cron chama pela união do laço e o nome está nela", () => {
    expect(CRON).toContain(`"${FN}"`);
    expect(CRON).toMatch(
      new RegExp(`executarDreno\\(falhas, "${FN}", \\(\\) => drenar\\(db, "${FN}", telemetriaDeIa\\.dias\\)`),
    );
  });
});
