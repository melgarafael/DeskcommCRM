// @vitest-environment node
// #2063 — Meet criado já aberto (opção por organização, desligada por padrão).
// Testa o GATE (deveCriarEspacoAberto + meetAbertoLigado + temEscopoDeEspacoAberto)
// e o transporte `criarEspacoAberto` (corpo, endpoint e recusa). O executor
// inteiro não é exercitado aqui: o teste descartável da spec (curl real contra a
// API do Meet) não roda nesta máquina — sem credencial, a API devolve 401. Este
// arquivo prova o estado DESLIGADO (default) e o LIGADO (opção + escopo) no
// contrato puro.
import { describe, it, expect } from "vitest";
import {
  googleTransport,
  GoogleHttpError,
} from "@/lib/agenda/google/transport";
import {
  ESCOPO_MEET_ESPACO_ABERTO,
  deveCriarEspacoAberto,
  temEscopoDeEspacoAberto,
} from "@/lib/agenda/google/oauth";
import { meetAbertoLigado, AVISO_MEET_ABERTO } from "@/lib/schemas/settings";

// ─── estado DESLIGADO (default) ─────────────────────────────────────────────
describe("meet aberto — estado desligado (default)", () => {
  it("sem chave no settings, a opção está desligada (default)", () => {
    expect(meetAbertoLigado(undefined)).toBe(false);
    expect(meetAbertoLigado(null)).toBe(false);
    expect(meetAbertoLigado({})).toBe(false);
    expect(meetAbertoLigado({ google_meet_acesso_aberto: false })).toBe(false);
    // `"true"` em string é lixo, não boolean — desligado, mesma régua do banco.
    expect(meetAbertoLigado({ google_meet_acesso_aberto: "true" })).toBe(false);
  });

  it("o gate fica fechado mesmo com escopo, quando a opção está off", () => {
    expect(deveCriarEspacoAberto({ ligada: false }, [ESCOPO_MEET_ESPACO_ABERTO])).toBe(false);
  });

  it("o gate fica fechado sem o escopo opcional, mesmo com a opção ligada", () => {
    expect(deveCriarEspacoAberto({ ligada: true }, ["https://www.googleapis.com/auth/calendar.events"])).toBe(false);
    expect(deveCriarEspacoAberto({ ligada: true }, undefined)).toBe(false);
    expect(deveCriarEspacoAberto({ ligada: true }, null)).toBe(false);
  });
});

// ─── estado LIGADO (opção + escopo) ─────────────────────────────────────────
describe("meet aberto — estado ligado (opção + escopo)", () => {
  it("só o `true` explícito liga a opção", () => {
    expect(meetAbertoLigado({ google_meet_acesso_aberto: true })).toBe(true);
  });

  it("opção ligada + escopo concedido abre o gate", () => {
    expect(
      deveCriarEspacoAberto({ ligada: true }, [ESCOPO_MEET_ESPACO_ABERTO]),
    ).toBe(true);
  });

  it("o escopo isolado é reconhecido quando concedido", () => {
    expect(temEscopoDeEspacoAberto(ESCOPO_MEET_ESPACO_ABERTO)).toBe(true);
    expect(temEscopoDeEspacoAberto(`a b ${ESCOPO_MEET_ESPACO_ABERTO}`)).toBe(true);
  });

  it("o aviso de risco acompanha a opção", () => {
    expect(AVISO_MEET_ABERTO).toContain("qualquer pessoa com o link entra");
  });
});

// ─── transporte criarEspacoAberto ───────────────────────────────────────────
describe("criarEspacoAberto (transporte Meet)", () => {
  it("cria espaço aberto com accessType OPEN e devolve meetingUri", async () => {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const api = googleTransport("test-token", async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ name: "spaces/abc", meetingUri: "https://meet.google.com/abc-defg-hij", config: { accessType: "OPEN" } }),
        { status: 200 },
      );
    });
    const { meetingUri } = await api.criarEspacoAberto();
    expect(meetingUri).toBe("https://meet.google.com/abc-defg-hij");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(String(call.url)).toBe("https://meet.googleapis.com/v2/spaces");
    expect(call.init!.method).toBe("POST");
    expect(String((call.init!.headers as Record<string, string>).authorization)).toBe("Bearer test-token");
    expect(JSON.parse(String(call.init!.body))).toEqual({ config: { accessType: "OPEN" } });
  });

  it("2xx sem accessType OPEN é recusa, não link", async () => {
    const api = googleTransport("t", async () =>
      new Response(JSON.stringify({ name: "spaces/x", meetingUri: "https://meet.google.com/abc" }), { status: 200 }),
    );
    await expect(api.criarEspacoAberto()).rejects.toThrow("não devolveu um espaço aberto válido");
  });

  it("2xx com meetingUri inválido é recusa", async () => {
    const api = googleTransport("t", async () =>
      new Response(
        JSON.stringify({ name: "spaces/x", meetingUri: "https://evil.example/x", config: { accessType: "OPEN" } }),
        { status: 200 },
      ),
    );
    await expect(api.criarEspacoAberto()).rejects.toThrow("não devolveu um link de vídeo válido");
  });

  it("recusa HTTP vira GoogleHttpError com status", async () => {
    const api = googleTransport("t", async () => new Response("{}", { status: 403 }));
    await expect(api.criarEspacoAberto()).rejects.toBeInstanceOf(GoogleHttpError);
  });
});