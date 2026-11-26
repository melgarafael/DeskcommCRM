/**
 * Issue #64 — o teto está LIGADO no login, não só disponível numa lib.
 *
 * O helper tem teste próprio (lib/auth/rate-limit.test.ts); este aqui prova a
 * fiação: a action recusa a 6ª tentativa contra a MESMA conta dentro da janela,
 * antes de falar com o GoTrue. Sem a chamada em signInWithPassword.ts, as seis
 * tentativas chegariam ao provedor e o teste fica vermelho.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { reconhecerDispositivoConfiavel } from "@/lib/auth/dispositivo-confiavel";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/dispositivo-confiavel", () => ({ reconhecerDispositivoConfiavel: vi.fn(async () => false) }));

const signIn = vi.fn(async () => ({
  data: { user: null, session: null },
  error: { message: "Invalid login credentials", status: 400 },
}));

describe("signInWithPassword — teto de tentativas", () => {
  beforeEach(() => {
    vi.resetModules();
    signIn.mockClear();
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) => (k === "x-forwarded-for" ? "203.0.113.77" : null),
    } as never);
    signIn.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials", status: 400 },
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        signInWithPassword: signIn,
        mfa: { listFactors: vi.fn(async () => ({ data: { totp: [{ id: "f1" }] } })) },
      },
    } as never);
  });

  it("recusa a 6ª tentativa contra a mesma conta sem chamar o provedor", async () => {
    const { signInWithPassword } = await import("./signInWithPassword");
    const input = { email: "alvo@example.com", password: "senha-errada-123" };

    const resultados = [];
    for (let i = 0; i < 6; i++) {
      resultados.push(await signInWithPassword(input));
    }

    // AUTH_LIMITS.login.id = 5 → as 5 primeiras passam do teto e falham no
    // provedor; a 6ª nem chega lá.
    expect(resultados.slice(0, 5).map((r) => r.error)).toEqual(
      Array(5).fill("invalid_credentials"),
    );
    expect(resultados[5]?.error).toBe("rate_limited");
    expect(signIn).toHaveBeenCalledTimes(5);
  });

  it("acertar a senha não gasta o orçamento de bloqueio da conta", async () => {
    const { signInWithPassword } = await import("./signInWithPassword");
    const input = { email: "certo@example.com", password: "senha-certa-123" };

    // Provedor aceita, e a conta tem MFA — o retorno é mfa_required, o que
    // basta: o ponto é que o caminho de SUCESSO não incrementa o contador.
    signIn.mockResolvedValue({
      data: { user: { id: "u1" }, session: {} },
      error: null,
    } as never);

    const resultados = [];
    for (let i = 0; i < 10; i++) {
      resultados.push(await signInWithPassword(input));
    }

    // Nenhuma das dez foi barrada: se o sucesso contasse, a 6ª seria.
    expect(resultados.filter((r) => r?.error === "rate_limited")).toHaveLength(0);
    expect(signIn).toHaveBeenCalledTimes(10);
  });
});

describe("signInWithPassword — dispositivo confiável", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(headers).mockResolvedValue({ get: () => null } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        signInWithPassword: vi.fn(async () => ({
          data: { user: { id: "u1" }, session: { access_token: "jwt-novo" } },
          error: null,
        })),
        mfa: { listFactors: vi.fn(async () => ({ data: { totp: [{ id: "f1", status: "verified" }] } })) },
      },
    } as never);
  });

  it("conta com fator, navegador sem confiança: pede o código", async () => {
    const { signInWithPassword } = await import("./signInWithPassword");
    const r = await signInWithPassword({ email: "dono@example.com", password: "senha-certa-123" });
    expect(r?.error).toBe("mfa_required");
  });

  it("conta com fator, navegador confiável: entra sem o código, com a sessão NOVA", async () => {
    vi.mocked(reconhecerDispositivoConfiavel).mockResolvedValueOnce(true);
    const { signInWithPassword } = await import("./signInWithPassword");
    await signInWithPassword({ email: "dona@example.com", password: "senha-certa-123" }, "/app/inbox");
    expect(vi.mocked(reconhecerDispositivoConfiavel)).toHaveBeenCalledWith("u1", "f1", "jwt-novo");
    expect(vi.mocked(redirect)).toHaveBeenCalledWith("/app/inbox");
  });
});

/**
 * Issue #4743, item 1 — a janela do dia está LIGADA no login, e com castigo
 * crescente. A régua em si tem teste próprio (`lib/auth/bloqueio-progressivo`);
 * aqui se prova a fiação: o login recusa a tentativa antes de falar com o
 * GoTrue, emite o evento do degrau e responde IGUAL para conta inexistente.
 *
 * Relógio controlado do começo ao fim — nenhum `sleep`.
 */
describe("signInWithPassword — bloqueio progressivo por conta (issue #4743)", () => {
  /** Meio-dia UTC: longe da virada do dia (meia-noite UTC). */
  const AGORA = Date.parse("2026-03-10T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
    signIn.mockClear();
    signIn.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials", status: 400 },
    } as never);
    // O `createClient` daqui é o do login por senha: a suíte anterior troca o
    // dublê pelo caminho do MFA, e sem esta linha o teste mediria outro fluxo.
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        signInWithPassword: signIn,
        mfa: { listFactors: vi.fn(async () => ({ data: { totp: [] } })) },
      },
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("o atacante que tenta uma vez por minuto o dia UTC inteiro chega a 57, não a 1.440", async () => {
    // Do primeiro ao último minuto do mesmo dia UTC: a conta do dia não vira no
    // meio. A conta à mão: 5 falhas seguidas, mais 5 espaçadas pelo castigo de
    // 5 min (a 10ª no minuto 29), e depois uma a cada 30 min até o minuto
    // 1.439 — 9 + 48 = 57.
    vi.setSystemTime(Date.parse("2026-03-10T00:00:00.000Z"));
    const { signInWithPassword } = await import("./signInWithPassword");
    const { audit } = await import("@/lib/audit");
    vi.mocked(audit).mockClear();
    const input = { email: "o-dia-todo@empresa.test", password: "senha-errada-123" };

    for (let i = 0; i < 1440; i++) {
      if (i > 0) vi.setSystemTime(Date.now() + 60_000);
      await signInWithPassword(input);
    }

    expect(signIn).toHaveBeenCalledTimes(57);

    // Um evento de degrau por castigo que NASCE: aqui cada falha que passou
    // chegou com o castigo anterior já vencido, então cada uma abre um castigo
    // novo — 5 de 5 min (falhas 5 a 9) e 48 de 30 min (da 10ª em diante). As
    // 1.383 tentativas barradas NÃO viram evento de degrau: seguem no registro
    // de sempre, com o degrau anotado ao lado.
    const eventos = vi.mocked(audit).mock.calls.map(([evento]) => evento);
    const acoes = eventos.map((e) => e.action);
    expect(acoes.filter((a) => a === "auth.login_bloqueio_5min").length).toBe(5);
    expect(acoes.filter((a) => a === "auth.login_bloqueio_30min").length).toBe(48);
    expect(acoes.filter((a) => a === "auth.login_rate_limited").length).toBe(1440 - 57);
    expect(
      eventos.find((e) => e.action === "auth.login_rate_limited" && e.metadata?.degrau === 2),
    ).toBeDefined();
  });

  it("a cadência de 5 erros a cada 5 minutos não rende 1.440 tentativas por dia", async () => {
    const { signInWithPassword } = await import("./signInWithPassword");
    const input = { email: "gotejando@empresa.test", password: "senha-errada-123" };

    // 66 tentativas, uma por minuto. Com SÓ a janela curta, todas chegariam ao
    // provedor — 66 em 66 minutos, e ~1.440 por dia, para sempre. O castigo de
    // 5 minutos quebra a cadência, e o contador do dia não zera quando a janela
    // curta vence.
    const resultados = [];
    for (let i = 0; i < 66; i++) {
      if (i > 0) vi.setSystemTime(Date.now() + 60_000);
      resultados.push(await signInWithPassword(input));
    }

    // MEDIDO: 11 chegam ao provedor em 66 minutos (eram 66), e o dia fecha em 11
    // falhas — não em 1.440.
    expect(signIn.mock.calls.length).toBe(11);
    expect(resultados.filter((r) => r.error === "rate_limited").length).toBe(55);

    const { falhasNaJanelaDiaria } = await import("@/lib/auth/rate-limit");
    expect(await falhasNaJanelaDiaria("gotejando@empresa.test")).toBe(11);
  });

  it("a resposta é a mesma para e-mail que não existe — o bloqueio não enumera contas", async () => {
    const { signInWithPassword } = await import("./signInWithPassword");
    const { falhasNaJanelaDiaria } = await import("@/lib/auth/rate-limit");

    // Uma tentativa a cada 6 minutos: a janela CURTA vence entre elas, então
    // quem barra é só a régua diária — é ela que não pode saber se a conta
    // existe. Com o ataque em rajada as duas sequências concordariam por
    // acidente (a janela de 5 min barra os dois), e o teste não provaria nada.
    const sequencia = async (email: string) => {
      const respostas: Array<string | undefined> = [];
      for (let i = 0; i < 11; i++) {
        if (i > 0) vi.setSystemTime(Date.now() + 6 * 60_000);
        respostas.push(
          (await signInWithPassword({ email, password: "senha-errada-123" })).error,
        );
      }
      return respostas;
    };

    const existente = await sequencia("conta-real@empresa.test");
    const inexistente = await sequencia("ninguem-aqui@empresa.test");

    expect(existente).toEqual(Array(10).fill("invalid_credentials").concat("rate_limited"));
    expect(inexistente).toEqual(existente);
    // As duas contas acumularam o mesmo dia — a inexistente inclusive.
    expect(await falhasNaJanelaDiaria("ninguem-aqui@empresa.test")).toBe(
      await falhasNaJanelaDiaria("conta-real@empresa.test"),
    );
  });
});
