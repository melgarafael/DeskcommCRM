/**
 * AJUSTAR O RITMO DE UMA CAMPANHA DE PROSPECÇÃO PAUSADA — issue #2095.
 *
 * ## O que muda, e o que NÃO pode mudar junto
 *
 * Antes, o limite por dia e o intervalo eram escolhidos uma vez, ao iniciar, e não
 * havia onde trocá-los: quem via o número aquecer demais só podia retomar com o
 * mesmo ritmo ou refazer a busca (e a empresa já vista é descartada como
 * "repetida" pelo índice único de telefone). Agora a ação `adjust_pace` troca
 * SÓ esses dois valores, com a campanha pausada.
 *
 * O risco é o contrário do conserto: abrir uma porta de escrita na `config` e ela
 * deixar passar conexão, agente, funil, base legal ou instrução — que decidem
 * QUEM recebe e com que autorização. Por isso a metade mais importante deste
 * arquivo é a que prova que o resto fica fechado.
 *
 * ## O que este arquivo prova, e o que fica para o invariante de banco
 *
 * Aqui, sem banco: o formato aceito pelo schema, a ordem das guardas em
 * `adjustPace` e o TEXTO do `update` (que carrega organização, estado e o `||`
 * que preserva as demais chaves). O efeito real sobre linhas — inclusive que
 * outra organização não alcança a campanha — está em
 * `tests/invariants/prospecting-ajustar-ritmo.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: vi.fn(),
  beginServiceAtOrigin: vi.fn(),
}));

import { campaignConfigSchema, prospectingInputSchema } from "@/lib/prospecting/schema";
import { AJUSTE_DE_RITMO_SQL, adjustPace } from "@/lib/prospecting/store";

const ORG = "0a110000-0000-4000-8000-000000000001";
const CAMPANHA = "0a110000-1111-4000-8000-000000000001";
const valido = { action: "adjust_pace", id: CAMPANHA, daily_limit: 10, interval_minutes: 20 };

describe("a ação adjust_pace aceita só o ritmo", () => {
  it("aceita um ritmo válido", () => {
    expect(prospectingInputSchema.safeParse(valido).success).toBe(true);
  });

  it("recusa qualquer campo além do ritmo — conexão, agente, funil, base legal e instrução ficam fechados", () => {
    for (const campo of [
      "instruction",
      "qualification",
      "agent_id",
      "channel_session_id",
      "pipeline_id",
      "stage_id",
      "qualified_stage_id",
      "legal_basis_ref",
      "organization_id",
    ]) {
      expect(
        prospectingInputSchema.safeParse({ ...valido, [campo]: "x" }).success,
        `o campo ${campo} não pode passar por adjust_pace`,
      ).toBe(false);
    }
  });

  it("não aceita config aninhada nem a ação de iniciar disfarçada de ajuste", () => {
    expect(
      prospectingInputSchema.safeParse({
        action: "adjust_pace",
        id: CAMPANHA,
        config: { daily_limit: 10, interval_minutes: 20 },
      }).success,
    ).toBe(false);
  });

  it("os limites são os da criação, nas duas pontas", () => {
    const tenta = (daily_limit: number, interval_minutes: number) =>
      prospectingInputSchema.safeParse({ ...valido, daily_limit, interval_minutes }).success;
    expect(tenta(1, 5)).toBe(true);
    expect(tenta(50, 1440)).toBe(true);
    expect(tenta(0, 20)).toBe(false);
    expect(tenta(51, 20)).toBe(false);
    expect(tenta(10, 4)).toBe(false);
    expect(tenta(10, 1441)).toBe(false);
    expect(tenta(5.5, 20)).toBe(false);
    expect(tenta(10, 20.5)).toBe(false);
  });

  it("valor omitido é erro: no ajuste não existe 'volta para o padrão sem avisar'", () => {
    expect(
      prospectingInputSchema.safeParse({
        action: "adjust_pace",
        id: CAMPANHA,
        interval_minutes: 20,
      }).success,
    ).toBe(false);
    expect(
      prospectingInputSchema.safeParse({ action: "adjust_pace", id: CAMPANHA, daily_limit: 10 })
        .success,
    ).toBe(false);
  });

  it("não mudou o padrão da criação: sem limite nem intervalo, 10 por dia e 15 minutos", () => {
    const parsed = campaignConfigSchema.parse({
      agent_id: CAMPANHA,
      channel_session_id: CAMPANHA,
      pipeline_id: CAMPANHA,
      stage_id: CAMPANHA,
      qualified_stage_id: CAMPANHA,
      instruction: "Vender consultoria para clínicas.",
      qualification: "Confirmou a necessidade e a decisão.",
      legal_basis_ref: "LIA-teste",
    });
    expect(parsed.daily_limit).toBe(10);
    expect(parsed.interval_minutes).toBe(15);
  });
});

type Linha = { status: string; config: Record<string, unknown> | null };
function poolDeMentira(campanha: Linha | null, atualiza = true) {
  const consultas: { texto: string; params: unknown[] }[] = [];
  const cliente = {
    query: vi.fn(async (texto: string, params: unknown[] = []) => {
      consultas.push({ texto, params });
      if (texto.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (texto.startsWith("select status, config")) return { rows: campanha ? [campanha] : [] };
      if (texto === AJUSTE_DE_RITMO_SQL) return { rows: atualiza ? [{ id: CAMPANHA }] : [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => cliente } as never, consultas };
}
const escreveu = (consultas: { texto: string }[]) =>
  consultas.some((q) => q.texto === AJUSTE_DE_RITMO_SQL);

describe("adjustPace: só pausada, só desta organização", () => {
  const ritmo = { daily_limit: 7, interval_minutes: 20 };
  const antes = { daily_limit: 10, interval_minutes: 5, instruction: "intocada" };

  it("campanha que não existe: 404, sem escrever", async () => {
    const { pool, consultas } = poolDeMentira(null);
    await expect(adjustPace(pool, ORG, CAMPANHA, ritmo)).rejects.toMatchObject({ status: 404 });
    expect(escreveu(consultas)).toBe(false);
  });

  it.each(["running", "draft", "completed"])("campanha %s: 409, sem escrever", async (status) => {
    const { pool, consultas } = poolDeMentira({ status, config: antes });
    await expect(adjustPace(pool, ORG, CAMPANHA, ritmo)).rejects.toMatchObject({ status: 409 });
    expect(escreveu(consultas)).toBe(false);
  });

  it("campanha sem configuração (nunca iniciada): 409, sem escrever", async () => {
    const { pool, consultas } = poolDeMentira({ status: "paused", config: null });
    await expect(adjustPace(pool, ORG, CAMPANHA, ritmo)).rejects.toMatchObject({ status: 409 });
    expect(escreveu(consultas)).toBe(false);
  });

  it("pausada: escreve com organização e id nos dois primeiros parâmetros, e devolve o ritmo de antes e o de depois", async () => {
    const { pool, consultas } = poolDeMentira({ status: "paused", config: antes });
    const resultado = await adjustPace(pool, ORG, CAMPANHA, ritmo);
    expect(resultado).toEqual({
      previous: { daily_limit: 10, interval_minutes: 5 },
      next: { daily_limit: 7, interval_minutes: 20 },
    });
    const escrita = consultas.find((q) => q.texto === AJUSTE_DE_RITMO_SQL);
    expect(escrita?.params).toEqual([ORG, CAMPANHA, 7, 20]);
  });

  it("alguém retomou entre a leitura e a escrita: o `where` recusou e o resultado é 409", async () => {
    const { pool } = poolDeMentira({ status: "paused", config: antes }, false);
    await expect(adjustPace(pool, ORG, CAMPANHA, ritmo)).rejects.toMatchObject({ status: 409 });
  });

  it("o ritmo de antes sai cru: configuração antiga que o schema atual recusaria ainda pode ser consertada", async () => {
    const { pool } = poolDeMentira({
      status: "paused",
      config: { daily_limit: 500, interval_minutes: 1 },
    });
    const resultado = await adjustPace(pool, ORG, CAMPANHA, ritmo);
    expect(resultado.previous).toEqual({ daily_limit: 500, interval_minutes: 1 });
  });
});

describe("o texto do update carrega as guardas na própria cláusula where", () => {
  const texto = AJUSTE_DE_RITMO_SQL.replace(/\s+/g, " ");

  it("filtra pela organização e pelo id", () => {
    expect(texto).toContain("where organization_id = $1 and id = $2");
  });

  it("só altera campanha pausada", () => {
    expect(texto).toContain("status = 'paused'");
  });

  it("não deixa `null || jsonb` apagar a configuração de quem nunca foi iniciada", () => {
    expect(texto).toContain("config is not null");
  });

  it("troca só as duas chaves: faz merge com `||` e não substitui a configuração inteira", () => {
    expect(texto).toContain(
      "set config = config || jsonb_build_object('daily_limit', $3::int, 'interval_minutes', $4::int)",
    );
    expect(texto).not.toMatch(/set config\s*=\s*\$/);
  });

  it("antecipa o próximo envio: a hora gravada era do ritmo antigo, e o envio sai cedo enquanto ela está no futuro", () => {
    expect(texto).toContain("next_send_at = least(next_send_at, now())");
  });
});
