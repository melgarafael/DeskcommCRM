/**
 * Issue #4743, item 1 — a janela do dia (vira à meia-noite UTC) com castigo
 * crescente.
 *
 * O que este arquivo prova, com RELÓGIO CONTROLADO (nada de `sleep`):
 *
 *   - o castigo tem o PRAZO que promete (5 min / 30 min), contado a partir da
 *     falha e não do início de uma janela alinhada;
 *   - a conta NÃO volta ao zero a cada 5 minutos — é o defeito que a issue
 *     descreve ("5 erros a cada 5 min dão ~1.440 tentativas por dia");
 *   - o castigo em curso sobrevive à virada do dia UTC;
 *   - redefinir a senha destranca na hora;
 *   - NÃO existe degrau "até redefinir a senha" (decisão do dono, doc 418).
 *
 * O limitador é o de verdade: sem Upstash no ambiente de teste, `checkRateLimit`
 * cai para o contador em memória do processo — exatamente o caminho real de uma
 * instalação sem Redis, e o único em que o relógio injetado controla o TTL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

/** Meio-dia UTC: longe das bordas da janela diária e das de 5 min. */
const AGORA = Date.parse("2026-03-10T12:00:00.000Z");
const MINUTO = 60_000;

async function regua() {
  return import("./rate-limit");
}

async function falhar(
  email: string,
  vezes: number,
  intervaloMs = 0,
): Promise<void> {
  const { registrarFalhaDeLogin, AUTH_LIMITS } = await regua();
  for (let i = 0; i < vezes; i++) {
    // O intervalo é ESPERA antes da tentativa (o atacante que aguenta o castigo
    // vencer), e não depois: assim o prazo do último degrau fica inteiro.
    if (i > 0 && intervaloMs > 0) vi.setSystemTime(Date.now() + intervaloMs);
    await registrarFalhaDeLogin(email, AUTH_LIMITS.login);
  }
}

describe("régua do bloqueio progressivo por conta", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("5 falhas devolvem 5 minutos — e a conta volta a entrar quando eles vencem", async () => {
    const { bloqueioProgressivoDeConta } = await regua();
    const email = "cinco@example.com";

    await falhar(email, 5);

    const agora = await bloqueioProgressivoDeConta(email);
    expect(agora).toMatchObject({ bloqueado: true, degrau: 1 });
    // Prazo do degrau, contado da FALHA (não do início da janela alinhada).
    expect(agora.restanteSec).toBe(300);
    expect(agora.acao).toBe("auth.login_bloqueio_5min");

    vi.setSystemTime(Date.now() + 300_000 + 1_000);
    expect(await bloqueioProgressivoDeConta(email)).toMatchObject({
      bloqueado: false,
      degrau: 0,
    });
  });

  it("a conta NÃO zera a cada 5 minutos: 5 erros, 6 min, 5 erros = 30 min de castigo", async () => {
    // Este é o defeito da issue: com só a janela curta, cada 6 minutos devolvia
    // o orçamento inteiro e o atacante fazia 5 tentativas por janela, o dia
    // todo, sem sinal nenhum.
    const { bloqueioProgressivoDeConta, falhasNaJanelaDiaria } = await regua();
    const email = "gotejando@example.com";

    await falhar(email, 5);
    vi.setSystemTime(Date.now() + 6 * MINUTO);
    await falhar(email, 5);

    expect(await falhasNaJanelaDiaria(email)).toBe(10);
    const bloqueio = await bloqueioProgressivoDeConta(email);
    expect(bloqueio).toMatchObject({ bloqueado: true, degrau: 2 });
    expect(bloqueio.restanteSec).toBe(1800);
    expect(bloqueio.acao).toBe("auth.login_bloqueio_30min");

    // 6 minutos depois a janela CURTA já teria vencido; a régua não.
    vi.setSystemTime(Date.now() + 6 * MINUTO);
    expect(await bloqueioProgressivoDeConta(email)).toMatchObject({
      bloqueado: true,
      degrau: 2,
    });

    vi.setSystemTime(Date.now() + 1800_000 + 1_000);
    expect(await bloqueioProgressivoDeConta(email)).toMatchObject({ bloqueado: false });
  });

  it("o castigo de 30 min sobrevive à virada do dia UTC, e a conta do dia recomeça", async () => {
    const { bloqueioProgressivoDeConta, falhasNaJanelaDiaria } = await regua();
    const email = "virada@example.com";

    // 10 falhas terminando às 23:59 UTC: o castigo de 30 min atravessa a
    // meia-noite, mas a conta do dia é de um dia novo.
    vi.setSystemTime(Date.parse("2026-03-10T23:50:00.000Z"));
    await falhar(email, 10, MINUTO);
    vi.setSystemTime(Date.parse("2026-03-11T00:05:00.000Z"));

    expect(await bloqueioProgressivoDeConta(email)).toMatchObject({ bloqueado: true, degrau: 2 });
    expect(await falhasNaJanelaDiaria(email)).toBe(0);
  });

  it("redefinir a senha destranca na hora e zera a janela diária", async () => {
    const { bloqueioProgressivoDeConta, falhasNaJanelaDiaria, liberarBloqueioProgressivo } =
      await regua();
    const email = "redefine@example.com";

    await falhar(email, 10);
    expect((await bloqueioProgressivoDeConta(email)).bloqueado).toBe(true);

    await liberarBloqueioProgressivo(email);

    expect(await bloqueioProgressivoDeConta(email)).toMatchObject({
      bloqueado: false,
      degrau: 0,
      restanteSec: 0,
    });
    expect(await falhasNaJanelaDiaria(email)).toBe(0);
  });

  it("o castigo já ativo não vira um segundo evento de auditoria", async () => {
    // Cada evento de degrau é um incidente, não uma linha por tentativa: quem
    // lê a auditoria não pode achar que houve 15 incidentes onde houve um.
    const { registrarFalhaNaRegua } = await regua();
    const email = "evento@example.com";

    for (let i = 0; i < 5; i++) {
      const degrau = await registrarFalhaNaRegua(email);
      expect(i === 4 ? degrau?.acao : null).toBe(
        i === 4 ? "auth.login_bloqueio_5min" : null,
      );
    }
    // Já bloqueado no degrau 1: nova falha renova o prazo, mas não é evento novo.
    expect(await registrarFalhaNaRegua(email)).toBeNull();
  });

  it("os degraus são 5 e 10 falhas no dia, e o mais alto é 30 min — sem degrau até redefinir", async () => {
    const { degrauDeFalhas, DEGRAUS_DO_BLOQUEIO, JANELA_DIARIA_DA_CONTA_SEC } = await regua();

    expect(DEGRAUS_DO_BLOQUEIO.map((d) => [d.falhas, d.segundos])).toEqual([
      [5, 300],
      [10, 1800],
    ]);
    expect(JANELA_DIARIA_DA_CONTA_SEC).toBe(86_400);

    expect([0, 4, 5, 9, 10, 19, 20, 400].map(degrauDeFalhas)).toEqual([
      0, 0, 1, 1, 2, 2, 2, 2,
    ]);
  });

  it("400 falhas no mesmo dia seguem num castigo de 30 min, que tem fim", async () => {
    const { bloqueioProgressivoDeConta } = await regua();
    const email = "insistente@example.com";

    await falhar(email, 400);
    expect(await bloqueioProgressivoDeConta(email)).toMatchObject({
      bloqueado: true,
      degrau: 2,
      restanteSec: 1800,
    });

    vi.setSystemTime(Date.now() + 1800_000 + 1_000);
    expect(await bloqueioProgressivoDeConta(email)).toMatchObject({ bloqueado: false });
  });
});
