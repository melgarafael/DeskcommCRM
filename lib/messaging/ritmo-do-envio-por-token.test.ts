import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { CHANNEL_CAPABILITIES } from "@/lib/channels/capabilities";
import type { DecisaoDeEspacamento } from "@/lib/agent-engine/pacing/ledger-supabase";

import {
  ESPERA_MAXIMA_MS,
  registrarEnvioPorToken,
  segurarEnvioPorToken,
  type DepsDoRitmo,
} from "./ritmo-do-envio-por-token";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
// Pergunta a CAPACIDADE, não o nome: um canal com e um sem risco de ban.
function providerCom(risco: boolean): string {
  return Object.entries(CHANNEL_CAPABILITIES).find(([, c]) => c.banRisk === risco)![0];
}
const COM_RISCO = providerCom(true);
const SEM_RISCO = providerCom(false);
const AGORA = new Date("2026-09-22T15:00:00.000Z");

function deps(
  canal: { channelSessionId: string; provider: string | null } | null,
  decisao: DecisaoDeEspacamento,
): DepsDoRitmo & { decide: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> } {
  const decide = vi.fn(async () => decisao);
  const sleep = vi.fn(async () => {});
  return {
    lerCanalDaConversa: vi.fn(async () => canal),
    lerCanalDaSessao: vi.fn(async () => canal),
    pacing: { decide, registraEnvio: vi.fn(async () => {}) },
    sleep,
    agora: () => AGORA,
    decide,
  };
}

const entrada = { organizationId: ORG, conversationId: CONVERSA, requestId: "req-1" };

describe("segurarEnvioPorToken", () => {
  it("libera na hora quando o ledger do número está folgado", async () => {
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, { liberado: true });
    await expect(segurarEnvioPorToken(d, entrada)).resolves.toEqual({ channelSessionId: SESSAO });
    expect(d.decide).toHaveBeenCalledWith(ORG, SESSAO, AGORA);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("aceita channelSessionId direto antes de a conversa existir", async () => {
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, { liberado: true });
    await expect(
      segurarEnvioPorToken(d, { organizationId: ORG, channelSessionId: SESSAO, requestId: "req-1" }),
    ).resolves.toEqual({ channelSessionId: SESSAO });
    expect(d.lerCanalDaSessao).toHaveBeenCalledWith(ORG, SESSAO);
    expect(d.lerCanalDaConversa).not.toHaveBeenCalled();
    expect(d.decide).toHaveBeenCalledWith(ORG, SESSAO, AGORA);
  });

  it("espera o espaçamento curto em vez de recusar", async () => {
    const liberaEm = new Date(AGORA.getTime() + 1_500);
    const d = deps(
      { channelSessionId: SESSAO, provider: COM_RISCO },
      { liberado: false, motivo: "espacamento", liberaEm },
    );
    await expect(segurarEnvioPorToken(d, entrada)).resolves.toEqual({ channelSessionId: SESSAO });
    expect(d.sleep).toHaveBeenCalledWith(1_500);
  });

  it("recusa com 429 quando o espaçamento passa da espera máxima", async () => {
    const liberaEm = new Date(AGORA.getTime() + ESPERA_MAXIMA_MS + 1);
    const d = deps(
      { channelSessionId: SESSAO, provider: COM_RISCO },
      { liberado: false, motivo: "espacamento", liberaEm },
    );
    const erro = await segurarEnvioPorToken(d, entrada).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(429);
    expect(d.sleep).not.toHaveBeenCalled();
    // O MCP só repassa a mensagem: os segundos têm de estar no texto.
    expect((erro as ApiError).message).toContain(`${Math.ceil((ESPERA_MAXIMA_MS + 1) / 1000)}s`);
  });

  it("recusa com 429 e diz quando volta quando o teto diário do número estourou", async () => {
    const liberaEm = new Date("2026-09-23T03:00:00.000Z");
    const d = deps(
      { channelSessionId: SESSAO, provider: COM_RISCO },
      { liberado: false, motivo: "teto_diario", liberaEm },
    );
    const erro = (await segurarEnvioPorToken(d, entrada).catch((e: unknown) => e)) as ApiError;
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.status).toBe(429);
    expect(erro.code).toBe("rate_limited");
    expect(erro.details).toMatchObject({
      motivo: "teto_diario",
      libera_em: liberaEm.toISOString(),
      retry_after_seconds: 43_200,
    });
    // O MCP só repassa a mensagem: o horário e os segundos têm de estar no texto.
    expect(erro.message).toContain(liberaEm.toISOString());
    expect(erro.message).toContain("43200s");
  });

  it("não freia canal sem risco de banimento", async () => {
    const d = deps(
      { channelSessionId: SESSAO, provider: SEM_RISCO },
      { liberado: false, motivo: "teto_diario", liberaEm: AGORA },
    );
    await expect(segurarEnvioPorToken(d, entrada)).resolves.toBeNull();
    expect(d.decide).not.toHaveBeenCalled();
  });

  it("trata provider ausente ou desconhecido como canal com risco (falha fechada)", async () => {
    for (const provider of [null, "provider-que-nao-existe"]) {
      const d = deps(
        { channelSessionId: SESSAO, provider },
        { liberado: false, motivo: "teto_diario", liberaEm: AGORA },
      );
      const erro = await segurarEnvioPorToken(d, entrada).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ApiError);
    }
  });

  it("deixa o handler decidir quando a conversa não é desta organização", async () => {
    const d = deps(null, { liberado: true });
    await expect(segurarEnvioPorToken(d, entrada)).resolves.toBeNull();
    expect(d.decide).not.toHaveBeenCalled();
  });
});

describe("registrarEnvioPorToken", () => {
  it("conta no ledger o envio que não falhou", async () => {
    const d = deps(null, { liberado: true });
    await registrarEnvioPorToken(d, ORG, { channelSessionId: SESSAO }, "sent");
    expect(d.pacing.registraEnvio).toHaveBeenCalledWith(ORG, SESSAO, AGORA);
  });

  it("não conta envio que falhou nem envio que não passou pelo freio", async () => {
    const d = deps(null, { liberado: true });
    await registrarEnvioPorToken(d, ORG, { channelSessionId: SESSAO }, "failed");
    await registrarEnvioPorToken(d, ORG, null, "sent");
    expect(d.pacing.registraEnvio).not.toHaveBeenCalled();
  });
});
