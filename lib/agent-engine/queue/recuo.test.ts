import { describe, expect, it, vi } from "vitest";

import {
  intervaloDoPollingDoEnv,
  proximoIntervaloOcioso,
  tetoDoRecuoDoEnv,
} from "@/lib/agent-engine/queue/recuo";

/**
 * O RECUO DA FILA VAZIA COMO ARITMÉTICA PROVADA (#3878, sugestão 1).
 *
 * O laço da fila do worker é o único ponto do processo que pergunta ao banco
 * "tem trabalho?" e, com a fila vazia, repete a pergunta para sempre. O
 * contrato do recuo — dobra por passada vazia, nunca passa do teto, volta ao
 * piso IMEDIATAMENTE quando aparece trabalho — é uma conta, e conta se prova
 * com números: os casos aqui são os do pedido da issue (#3878) mais o do teto
 * que o operador escolheu.
 */

const BASE = 2_000;
const TETO = 60_000;

describe("proximoIntervaloOcioso — a conta do recuo", () => {
  it("(a) 0, 1, 2 e 5 passadas vazias dão intervalos CRESCENTES, sem passar do teto", () => {
    const intervalos = [0, 1, 2, 5].map((passadas) =>
      proximoIntervaloOcioso({ passadasVazias: passadas, baseMs: BASE, tetoMs: TETO }),
    );

    // 2 s, 4 s, 8 s e o teto: a 5ª passada (32 s dobrados = 64 s) já passa
    // do teto de 60 s e é grampeada nele.
    expect(intervalos).toEqual([2_000, 4_000, 8_000, 60_000]);
    // Crescente de verdade — a propriedade que o operador compra ao ligar o teto.
    for (let i = 1; i < intervalos.length; i += 1) {
      expect(intervalos[i]!).toBeGreaterThan(intervalos[i - 1]!);
    }
    for (const ms of intervalos) expect(ms).toBeLessThanOrEqual(TETO);
  });

  it("(a) o teto é o TETO: 10 e 1.000 passadas vazias param nele, nunca acima", () => {
    expect(proximoIntervaloOcioso({ passadasVazias: 4, baseMs: BASE, tetoMs: TETO })).toBe(32_000);
    expect(proximoIntervaloOcioso({ passadasVazias: 5, baseMs: BASE, tetoMs: TETO })).toBe(TETO);
    expect(proximoIntervaloOcioso({ passadasVazias: 6, baseMs: BASE, tetoMs: TETO })).toBe(TETO);
    for (const passadas of [10, 100, 1_000, 2 ** 30]) {
      expect(proximoIntervaloOcioso({ passadasVazias: passadas, baseMs: BASE, tetoMs: TETO })).toBe(
        TETO,
      );
    }
  });

  it("(b) passada com trabalho zera o recuo: volta ao PISO na hora", () => {
    // O laço chama a função com `passadasVazias = 0` na primeira volta com
    // trabalho (o contador é zerado no call site). O piso é o atraso máximo que
    // um job novo paga — nunca o teto acumulado dormindo.
    expect(proximoIntervaloOcioso({ passadasVazias: 0, baseMs: BASE, tetoMs: TETO })).toBe(BASE);
    expect(proximoIntervaloOcioso({ passadasVazias: 0, baseMs: 250, tetoMs: TETO })).toBe(250);
  });

  it("teto abaixo do piso não encolhe o piso (e um teto ausente desliga o recuo)", () => {
    // Sem teto = comportamento de hoje: fila vazia dorme sempre o piso.
    for (const passadas of [0, 3, 20]) {
      expect(proximoIntervaloOcioso({ passadasVazias: passadas, baseMs: BASE })).toBe(BASE);
    }
    // Teto menor que o piso: o piso manda — recuo não pode acelerar o laço.
    expect(proximoIntervaloOcioso({ passadasVazias: 9, baseMs: BASE, tetoMs: 500 })).toBe(BASE);
  });

  it("contador absurdo ou negativo não vira Infinity nem NaN", () => {
    expect(
      Number.isFinite(
        proximoIntervaloOcioso({ passadasVazias: 2 ** 30, baseMs: BASE, tetoMs: TETO }),
      ),
    ).toBe(true);
    expect(proximoIntervaloOcioso({ passadasVazias: -5, baseMs: BASE, tetoMs: TETO })).toBe(BASE);
    expect(proximoIntervaloOcioso({ passadasVazias: Number.NaN, baseMs: BASE, tetoMs: TETO })).toBe(
      BASE,
    );
  });

  it("jitter, se usado, não fura o teto nem desce abaixo do piso", () => {
    // O sorteio é injetado: 0 = extremo de baixo, 1 = extremo de cima.
    const noTeto = proximoIntervaloOcioso({
      passadasVazias: 20,
      baseMs: BASE,
      tetoMs: TETO,
      sortear: () => 1,
    });
    const noPiso = proximoIntervaloOcioso({
      passadasVazias: 20,
      baseMs: BASE,
      tetoMs: TETO,
      sortear: () => 0,
    });

    expect(noTeto).toBe(TETO);
    expect(noPiso).toBeGreaterThanOrEqual(Math.floor(TETO * 0.8));
    expect(noPiso).toBeLessThanOrEqual(TETO);
    for (const sorteio of [0, 0.1, 0.5, 0.9, 0.999, 1]) {
      const ms = proximoIntervaloOcioso({
        passadasVazias: 20,
        baseMs: BASE,
        tetoMs: TETO,
        sortear: () => sorteio,
      });
      expect(ms).toBeLessThanOrEqual(TETO);
      expect(ms).toBeGreaterThanOrEqual(BASE);
    }
  });

  it("piso inválido é erro de programação, não valor silencioso", () => {
    for (const baseMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => proximoIntervaloOcioso({ passadasVazias: 0, baseMs, tetoMs: TETO })).toThrow(
        RangeError,
      );
    }
  });
});

describe("env do polling — inválida cai no default com aviso, nunca quebra o worker", () => {
  const avisos: string[] = [];
  const avisar = (msg: string): void => void avisos.push(msg);

  it("(c) teto inválido vira undefined (recuo DESLIGADO) e avisa, sem lançar", () => {
    for (const bruto of ["abc", "-5", "0", "1.5", "6e4", "60000ms"]) {
      avisos.length = 0;
      expect(() =>
        tetoDoRecuoDoEnv(bruto, { nome: "QUEUE_IDLE_MAX_INTERVAL_MS", avisar }),
      ).not.toThrow();
      expect(
        tetoDoRecuoDoEnv(bruto, { nome: "QUEUE_IDLE_MAX_INTERVAL_MS", avisar }),
      ).toBeUndefined();
      expect(avisos.join(" ")).toContain("QUEUE_IDLE_MAX_INTERVAL_MS");
    }
  });

  it("(c) piso inválido cai no default do produto (2000 ms) e avisa, sem lançar", () => {
    for (const bruto of ["abc", "-5", "0", "2.5"]) {
      avisos.length = 0;
      expect(() =>
        intervaloDoPollingDoEnv(bruto, { nome: "QUEUE_POLL_INTERVAL_MS", padraoMs: 2_000, avisar }),
      ).not.toThrow();
      expect(
        intervaloDoPollingDoEnv(bruto, { nome: "QUEUE_POLL_INTERVAL_MS", padraoMs: 2_000, avisar }),
      ).toBe(2_000);
      expect(avisos.join(" ")).toContain("QUEUE_POLL_INTERVAL_MS");
    }
  });

  it("(d) valor válido é respeitado, com ou sem espaço em volta", () => {
    for (const bruto of ["60000", " 60000 ", "60000\n"]) {
      avisos.length = 0;
      expect(tetoDoRecuoDoEnv(bruto, { nome: "QUEUE_IDLE_MAX_INTERVAL_MS", avisar })).toBe(60_000);
      expect(avisos).toEqual([]);
    }
    expect(
      intervaloDoPollingDoEnv("1500", { nome: "QUEUE_POLL_INTERVAL_MS", padraoMs: 2_000, avisar }),
    ).toBe(1_500);
    expect(
      intervaloDoPollingDoEnv("1500", { nome: "QUEUE_POLL_INTERVAL_MS", padraoMs: 2_000, avisar }),
    ).not.toBe(2_000);
  });

  it("vazio e ausente NÃO avisam: é o default documentado, não erro de ninguém", () => {
    avisos.length = 0;
    expect(
      tetoDoRecuoDoEnv(undefined, { nome: "QUEUE_IDLE_MAX_INTERVAL_MS", avisar }),
    ).toBeUndefined();
    expect(tetoDoRecuoDoEnv("", { nome: "QUEUE_IDLE_MAX_INTERVAL_MS", avisar })).toBeUndefined();
    // Só espaço é ausência, não erro: quem deixou a linha em branco não configurou nada.
    expect(tetoDoRecuoDoEnv("   ", { nome: "QUEUE_IDLE_MAX_INTERVAL_MS", avisar })).toBeUndefined();
    expect(
      intervaloDoPollingDoEnv(undefined, {
        nome: "QUEUE_POLL_INTERVAL_MS",
        padraoMs: 2_000,
        avisar,
      }),
    ).toBe(2_000);
    expect(
      intervaloDoPollingDoEnv("", { nome: "QUEUE_POLL_INTERVAL_MS", padraoMs: 2_000, avisar }),
    ).toBe(2_000);
    expect(avisos).toEqual([]);
  });

  it("o aviso diz o valor e o que passa a valer — sem credencial na mensagem", () => {
    avisos.length = 0;
    tetoDoRecuoDoEnv("sessenta", { nome: "QUEUE_IDLE_MAX_INTERVAL_MS", avisar });
    const texto = avisos.join(" ");
    expect(texto).toContain("sessenta");
    expect(texto).toContain("QUEUE_POLL_INTERVAL_MS");
    expect(texto.toLowerCase()).toContain("desligado");
  });
});

describe("o env real do worker (loadEnv) aceita o inválido sem derrubar o boot", () => {
  it("(c) QUEUE_IDLE_MAX_INTERVAL_MS=abc não lança e cai no desligado", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loadEnv } = await import("@/lib/agent-engine/env");
    const base: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      SUPABASE_DB_URL: "postgresql://u:p@localhost:5432/db",
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    };

    expect(() => loadEnv({ ...base, QUEUE_IDLE_MAX_INTERVAL_MS: "abc" })).not.toThrow();
    expect(
      loadEnv({ ...base, QUEUE_IDLE_MAX_INTERVAL_MS: "abc" }).QUEUE_IDLE_MAX_INTERVAL_MS,
    ).toBeUndefined();
    expect(() => loadEnv({ ...base, QUEUE_POLL_INTERVAL_MS: "dois segundos" })).not.toThrow();
    expect(
      loadEnv({ ...base, QUEUE_POLL_INTERVAL_MS: "dois segundos" }).QUEUE_POLL_INTERVAL_MS,
    ).toBe(2_000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
