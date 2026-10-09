/**
 * O TETO NOS DOIS PRAZOS DO ARQUIVO DE WEBHOOKS — issue #2612.
 *
 * O #2603 pôs `RETENCAO_TETO_DIAS = 36500` em `interpretarRetencao`, que
 * cobre os 15 prazos da limpeza diária e da captação. Os DOIS do arquivo de
 * webhooks ficaram de fora: `WEBHOOK_LOG_BODY_RETENTION_DAYS` e
 * `WEBHOOK_LOG_ROW_RETENTION_DAYS` entram por `diasDeRetencao` (`lib/env.ts`)
 * e saem por `limiteEm` (`lib/channels/retencao-do-arquivo.ts`) — caminhos
 * distintos, sem máximo nenhum.
 *
 * Medido na issue: `9999999` vira corte no ano −25353 indo ao PostgREST; um
 * `1e9` estoura a faixa de `Date` e lança `RangeError: Invalid time value` na
 * própria montagem da data.
 *
 * Aqui se medem as DUAS metades do conserto, cada uma no lugar em que ela
 * acontece:
 *
 *  - a LEITURA (`lib/env.ts`): o valor acima do teto vira 36500 com o aviso no
 *    log, no formato `chave=valor está acima do teto de N dias — usando N`, e
 *    o valor dentro do intervalo passa intacto;
 *  - o CORTE (`limiteEm`): chamando a poda direto com prazo gigante, o corte
 *    mandado ao banco é o do teto, não uma data de outro século.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { podarArquivoDeWebhooks } from "@/lib/channels/retencao-do-arquivo";
import { RETENCAO_TETO_DIAS } from "@/lib/retencao/politica";

const KNOBS = ["WEBHOOK_LOG_BODY_RETENTION_DAYS", "WEBHOOK_LOG_ROW_RETENTION_DAYS"] as const;
const DIA = 86_400_000;

// ─── A metade da LEITURA: `lib/env.ts` ──────────────────────────────────────

function ambienteMinimo(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://teste.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-teste");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-teste");

  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  // Evita ruído de outro aviso de boot sem relação com esta issue.
  vi.stubEnv("IMPERSONATE_COOKIE_SECRET", "x".repeat(32));
}

/** Importa `lib/env.ts` de verdade, capturando o que ele avisar no boot. */
async function carregarEnv() {
  const avisos: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    avisos.push(args.map(String).join(" "));
  });

  const { env } = await import("@/lib/env");
  return { env, avisos };
}

beforeEach(() => {
  vi.resetModules();
  ambienteMinimo();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("a leitura dos knobs tem teto e diz que teve", () => {
  it("9999999 vira 36500 NOS DOIS knobs, com o aviso no formato do teto", async () => {
    for (const nome of KNOBS) vi.stubEnv(nome, "9999999");

    const { env, avisos } = await carregarEnv();

    expect(env.WEBHOOK_LOG_BODY_RETENTION_DAYS).toBe(RETENCAO_TETO_DIAS);
    expect(env.WEBHOOK_LOG_ROW_RETENTION_DAYS).toBe(RETENCAO_TETO_DIAS);
    for (const nome of KNOBS) {
      expect(avisos).toContain(
        `[env] ${nome}=9999999 está acima do teto de ${RETENCAO_TETO_DIAS} dias — ` +
          `usando ${RETENCAO_TETO_DIAS}.`,
      );
    }
  });

  it("valor DENTRO do intervalo (e o próprio teto) passa intacto, sem aviso", async () => {
    // `400` é o maior padrão da casa; `36500` é o limite inclusivo — nenhum dos
    // dois pode ser cortado nem produzir aviso.
    vi.stubEnv("WEBHOOK_LOG_BODY_RETENTION_DAYS", "400");
    vi.stubEnv("WEBHOOK_LOG_ROW_RETENTION_DAYS", String(RETENCAO_TETO_DIAS));

    const { env, avisos } = await carregarEnv();

    expect(env.WEBHOOK_LOG_BODY_RETENTION_DAYS).toBe(400);
    expect(env.WEBHOOK_LOG_ROW_RETENTION_DAYS).toBe(RETENCAO_TETO_DIAS);
    expect(avisos.filter((a) => a.includes("acima do teto"))).toEqual([]);
  });

  it("sem a var escrita, o padrão de cada knob (7 e 90) segue intacto", async () => {
    const { env, avisos } = await carregarEnv();

    expect(env.WEBHOOK_LOG_BODY_RETENTION_DAYS).toBe(7);
    expect(env.WEBHOOK_LOG_ROW_RETENTION_DAYS).toBe(90);
    expect(avisos.filter((a) => a.includes("acima do teto"))).toEqual([]);
  });
});

// ─── A metade do CORTE: `limiteEm` ──────────────────────────────────────────

/**
 * Dublê só com o que a poda encosta: registra os cortes de `received_at` que a
 * cadeia manda ao banco e devolve fila vazia — caso normal de uma rodada sem
 * trabalho, em que os DOIS cortes mesmo assim são calculados.
 */
function adminQueAnotaCortes(cortes: string[]) {
  const cadeia = () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.is = () => q;
    q.lte = () => q;
    q.update = () => q;
    q.delete = () => q;
    q.order = () => q;
    q.lt = (_coluna: string, valor: string) => {
      cortes.push(valor);
      return q;
    };
    q.limit = () => Promise.resolve({ data: [], error: null });
    return q;
  };
  return { from: () => cadeia() } as never;
}

/** O corte caiu `dias` atrás do agora (com folga de 60 s para o relógio)? */
function corteHaDias(valor: string, dias: number, agora: number): boolean {
  const t = new Date(valor).getTime();
  if (Number.isNaN(t)) return false; // ano −25353 e afins não são data nenhuma
  const esperado = agora - dias * DIA;
  return t <= esperado + 60_000 && t >= esperado - 60_000;
}

describe("o corte da poda tem o mesmo teto", () => {
  it("1e9 não lança RangeError e 9999999 não vira ano −25353: os dois cortam no teto", async () => {
    const cortes: string[] = [];
    const r = await podarArquivoDeWebhooks(adminQueAnotaCortes(cortes), {
      diasComCorpo: 1e9,
      diasParaApagar: 9999999,
    });

    expect(r).toEqual({ esvaziadas: 0, apagadas: 0, temMais: false });
    expect(cortes).toHaveLength(2);
    const agora = Date.now();
    expect(corteHaDias(cortes[0] ?? "", RETENCAO_TETO_DIAS, agora)).toBe(true);
    expect(corteHaDias(cortes[1] ?? "", RETENCAO_TETO_DIAS, agora)).toBe(true);
  });

  it("prazo DENTRO do intervalo passa intacto — o teto não encurta o que é razoável", async () => {
    const cortes: string[] = [];
    await podarArquivoDeWebhooks(adminQueAnotaCortes(cortes), {
      diasComCorpo: 90,
      diasParaApagar: 400,
    });

    const agora = Date.now();
    expect(corteHaDias(cortes[0] ?? "", 90, agora)).toBe(true);
    expect(corteHaDias(cortes[1] ?? "", 400, agora)).toBe(true);
  });
});
