import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GET,
  MAX_LOTES,
  type PodaDb,
  TAMANHO_DO_LOTE,
  houveEfeito,
  podarHistorico,
} from "@/app/api/v1/cron/data-retention/route";

import {
  RETENCAO_AUDITORIA_DIAS_PADRAO,
  RETENCAO_AUDITORIA_DIAS_PISO,
  RETENCAO_EVENT_LOG_DIAS_PADRAO,
  RETENCAO_EVENT_LOG_DIAS_PISO,
  RETENCAO_FILA_DIAS_PADRAO,
  RETENCAO_FILA_DIAS_PISO,
  interpretarRetencao,
} from "@/lib/retencao/politica";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    JOB_QUEUE_RETENTION_DAYS: "",
    AUDIT_LOG_RETENTION_DAYS: "",
    EVENT_LOG_RETENTION_DAYS: "",
  },
}));
const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

/** O que o `rpc` do admin client devolve nesta rodada (o handler HTTP usa isto). */
let respostaRpc: { data: number | null; error: { message: string } | null } = {
  data: 0,
  error: null,
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => respostaRpc }),
}));

/**
 * O LAÇO DE LOTES DA PODA — issue #261.
 *
 * O DELETE em lotes não é preciosismo: um DELETE único num banco de cliente com
 * anos de histórico segura a tabela pelo tempo inteiro da varredura, e o produto
 * é instalado em VPS sem janela de manutenção. Três propriedades sustentam isso,
 * e as três são invisíveis a olho nu:
 *
 *   1. o laço PARA no primeiro lote incompleto (senão gasta uma ida ao banco a
 *      cada rodada só para ouvir zero, 1×/dia, para sempre);
 *   2. o laço tem TETO por invocação (senão a primeira rodada de uma instalação
 *      antiga segura o `curl` do cron até o timeout de 120 s e deixa a última
 *      transação para o servidor abortar sozinho);
 *   3. quando o teto é atingido, o resultado DIZ que sobrou trabalho — silêncio
 *      aqui seria indistinguível de "acabou".
 *
 * A régua deste arquivo é a REGRA (o laço, o teto, a interpretação do knob). O
 * que o banco de fato apaga — e o que ele se recusa a apagar — é medido contra
 * um Postgres real em `tests/invariants/retencao-poda-e-expurgo.test.ts`.
 */
function bancoQueDevolve(sequencias: {
  fila: number[];
  auditoria: number[];
  eventLog?: number[];
}): { db: PodaDb; chamadas: { nome: string; dias: number; limite: number }[] } {
  const chamadas: { nome: string; dias: number; limite: number }[] = [];
  const restante = {
    fila: [...sequencias.fila],
    auditoria: [...sequencias.auditoria],
    eventLog: [...(sequencias.eventLog ?? [0])],
  };
  const db: PodaDb = {
    async rpc(nome, args) {
      chamadas.push({ nome, dias: args.p_retencao_dias, limite: args.p_limite });
      const balde =
        nome === "fn_podar_fila_de_jobs"
          ? restante.fila
          : nome === "fn_expurgar_auditoria_vencida"
            ? restante.auditoria
            : restante.eventLog;
      return { data: balde.shift() ?? 0, error: null };
    },
  };
  return { db, chamadas };
}

describe("interpretarRetencao — o knob nunca derruba o produto", () => {
  it("ausente ou vazio devolve o padrão, sem aviso", () => {
    // É o caminho de toda instalação que nunca editou `.env` — a doutrina de
    // packaging exige que ele funcione sem edição manual de arquivo.
    for (const bruto of [undefined, "", "   "]) {
      const r = interpretarRetencao(bruto, { chave: "K", padrao: 90, piso: 7 });
      expect(r).toEqual({ dias: 90, aviso: null });
    }
  });

  it("lixo devolve o padrão COM aviso — nunca a frase tranquilizadora", () => {
    for (const bruto of ["noventa", "90d", "-1", "0", "1.5", "NaN"]) {
      const r = interpretarRetencao(bruto, { chave: "K", padrao: 90, piso: 7 });
      expect(r.dias, `entrada ${bruto}`).toBe(90);
      expect(r.aviso, `entrada ${bruto} sem aviso`).toContain("K=");
    }
  });

  it("valor abaixo do piso é ELEVADO, com aviso", () => {
    const r = interpretarRetencao("2", { chave: "K", padrao: 90, piso: 7 });
    expect(r.dias).toBe(7);
    expect(r.aviso).toContain("piso");
  });

  it("valor válido passa inteiro, sem aviso", () => {
    expect(interpretarRetencao("400", { chave: "K", padrao: 90, piso: 7 })).toEqual({
      dias: 400,
      aviso: null,
    });
  });
});

describe("podarHistorico — o laço de lotes", () => {
  it("para no primeiro lote incompleto (não gasta uma ida a mais)", async () => {
    const { db, chamadas } = bancoQueDevolve({
      fila: [TAMANHO_DO_LOTE, 7],
      auditoria: [0],
    });
    const r = await podarHistorico(db, {});
    expect(r.jobs_apagados).toBe(TAMANHO_DO_LOTE + 7);
    expect(r.lotes_fila).toBe(2);
    expect(r.fila_tem_resto).toBe(false);
    expect(r.lotes_auditoria).toBe(1);
    expect(chamadas.filter((c) => c.nome === "fn_podar_fila_de_jobs")).toHaveLength(2);
  });

  it("respeita o teto por invocação e DECLARA que sobrou trabalho", async () => {
    // Previsão feita ANTES: com todo lote cheio, são exatamente MAX_LOTES
    // chamadas e `fila_tem_resto` verdadeiro.
    const { db, chamadas } = bancoQueDevolve({
      fila: Array.from({ length: MAX_LOTES + 5 }, () => TAMANHO_DO_LOTE),
      auditoria: [0],
    });
    const r = await podarHistorico(db, {});
    expect(chamadas.filter((c) => c.nome === "fn_podar_fila_de_jobs")).toHaveLength(MAX_LOTES);
    expect(r.jobs_apagados).toBe(MAX_LOTES * TAMANHO_DO_LOTE);
    expect(r.fila_tem_resto).toBe(true);
  });

  it("pede ao banco os dias do padrão quando o .env está intocado", async () => {
    const { db, chamadas } = bancoQueDevolve({ fila: [0], auditoria: [0], eventLog: [0] });
    const r = await podarHistorico(db, {});
    expect(chamadas[0]).toEqual({
      nome: "fn_podar_fila_de_jobs",
      dias: RETENCAO_FILA_DIAS_PADRAO,
      limite: TAMANHO_DO_LOTE,
    });
    expect(chamadas[1]).toEqual({
      nome: "fn_expurgar_auditoria_vencida",
      dias: RETENCAO_AUDITORIA_DIAS_PADRAO,
      limite: TAMANHO_DO_LOTE,
    });
    expect(chamadas[2]).toEqual({
      nome: "fn_podar_event_log",
      dias: RETENCAO_EVENT_LOG_DIAS_PADRAO,
      limite: TAMANHO_DO_LOTE,
    });
    expect(r.avisos).toEqual([]);
  });

  it("eleva ao piso o knob abaixo dele e devolve o aviso", async () => {
    const { db, chamadas } = bancoQueDevolve({ fila: [0], auditoria: [0], eventLog: [0] });
    const r = await podarHistorico(db, {
      JOB_QUEUE_RETENTION_DAYS: "1",
      AUDIT_LOG_RETENTION_DAYS: "0",
      EVENT_LOG_RETENTION_DAYS: "1",
    });
    expect(chamadas[0]?.dias).toBe(RETENCAO_FILA_DIAS_PISO);
    // "0" é lixo (não-positivo), então cai no PADRÃO, não no piso — é a
    // diferença entre "escolheu pouco" e "escreveu bobagem".
    expect(chamadas[1]?.dias).toBe(RETENCAO_AUDITORIA_DIAS_PADRAO);
    expect(chamadas[2]?.dias).toBe(RETENCAO_EVENT_LOG_DIAS_PISO);
    expect(r.avisos).toHaveLength(3);
  });

  it("erro do banco sobe — a poda não engole falha em silêncio", async () => {
    const db: PodaDb = {
      async rpc() {
        return { data: null, error: { message: "permission denied for table api_audit_log" } };
      },
    };
    await expect(podarHistorico(db, {})).rejects.toThrow(/permission denied/);
  });
});

describe("houveEfeito — as três direções", () => {
  const base = {
    jobs_apagados: 0,
    auditoria_apagada: 0,
    event_log_apagado: 0,
    lotes_fila: 1,
    lotes_auditoria: 1,
    lotes_event_log: 1,
    fila_tem_resto: false,
    auditoria_tem_resto: false,
    event_log_tem_resto: false,
    retencao_fila_dias: RETENCAO_FILA_DIAS_PADRAO,
    retencao_auditoria_dias: RETENCAO_AUDITORIA_DIAS_PADRAO,
    retencao_event_log_dias: RETENCAO_EVENT_LOG_DIAS_PADRAO,
    avisos: [] as string[],
  };

  it("rodada que não apagou nada NÃO ocupa linha de auditoria", () => {
    expect(houveEfeito(base)).toBe(false);
  });

  it("apagou job → audita; apagou auditoria → audita; apagou event_log → audita", () => {
    // A segunda é a que não pode se perder: é ela que faz o expurgo do audit
    // deixar rastro em vez de encolher a trilha em silêncio.
    expect(houveEfeito({ ...base, jobs_apagados: 1 })).toBe(true);
    expect(houveEfeito({ ...base, auditoria_apagada: 1 })).toBe(true);
    expect(houveEfeito({ ...base, event_log_apagado: 1 })).toBe(true);
  });
});

describe("os pisos do TypeScript e os do SQL são os mesmos números", () => {
  it("os quatro valores de fila/auditoria aparecem literalmente no baseline.sql", async () => {
    // Duas cópias de um piso é como um piso vira decorativo: o `.env.example`
    // documenta um número, a função do banco aplica outro, e ninguém percebe
    // porque os dois lados continuam "funcionando".
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");
    const bloco = sql.slice(sql.indexOf("-- ---- poda da fila e expurgo do audit (migration 0167)"));
    expect(bloco.length).toBeGreaterThan(500);
    expect(bloco).toContain(`greatest(coalesce(p_retencao_dias, ${RETENCAO_FILA_DIAS_PADRAO}), ${RETENCAO_FILA_DIAS_PISO})`);
    expect(bloco).toContain(
      `greatest(coalesce(p_retencao_dias, ${RETENCAO_AUDITORIA_DIAS_PADRAO}), ${RETENCAO_AUDITORIA_DIAS_PISO})`,
    );
  });

  it("os dois valores do event_log aparecem literalmente no baseline.sql", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");
    const bloco = sql.slice(sql.indexOf("-- ---- poda do event_log (migration 0172)"));
    expect(bloco.length).toBeGreaterThan(500);
    expect(bloco).toContain(
      `greatest(coalesce(p_retencao_dias, ${RETENCAO_EVENT_LOG_DIAS_PADRAO}), ${RETENCAO_EVENT_LOG_DIAS_PISO})`,
    );
  });
});

describe("o handler HTTP — a falha entra na trilha, o vazio não", () => {
  function requisicaoAutorizada(): Parameters<typeof GET>[0] {
    // O handler só lê `headers.get("authorization")`.
    return { headers: new Headers({ authorization: "Bearer segredo" }) } as never;
  }

  beforeEach(() => {
    auditou.mockClear();
  });

  it("rodada que não apagou nada responde 200 e NÃO audita", async () => {
    respostaRpc = { data: 0, error: null };
    const resposta = await GET(requisicaoAutorizada());
    expect(resposta.status).toBe(200);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("rodada que apagou AUDITA — o expurgo do audit deixa rastro", async () => {
    // Esta é a direção que não pode se perder: sem ela, o expurgo encolheria a
    // trilha em silêncio, que é exatamente o que a doutrina de append-only
    // existe para impedir.
    respostaRpc = { data: 7, error: null };
    await GET(requisicaoAutorizada());
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { jobs_apagados: 7 },
    });
  });

  it("rodada que FALHOU responde 500 e AUDITA a falha", async () => {
    // O laço de retorno: uma poda que parou de funcionar num clone (grants que
    // não vieram no `update.sh`) não pode ficar idêntica, na trilha, a uma poda
    // sem nada a fazer. Sem esta linha o único sinal viveria num `logger.error`
    // dentro do contêiner, atrás de um `curl` que manda tudo para /dev/null.
    respostaRpc = { data: null, error: { message: "permission denied for table api_audit_log" } };
    const resposta = await GET(requisicaoAutorizada());
    expect(resposta.status).toBe(500);
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { falhou: true },
    });
  });
});
