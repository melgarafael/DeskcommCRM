/**
 * A TRAVA DA ROTAÇÃO E A MEMÓRIA DE REVOGAÇÃO — o que este teste guarda.
 *
 *  1. DOIS refreshes concorrentes fazem UM só POST. Sem a trava, a segunda
 *     chamada envia um `refresh_token` que a primeira acabou de trocar, o
 *     provedor recusa (ou pior, derruba a sessão) e a instalação inteira perde
 *     o login por causa de duas mensagens que chegaram juntas.
 *  2. `refresh_token_revoked` NÃO tenta de novo: repetir é mandar de propósito
 *     um token sabidamente revogado — e o motivo vira decisão de queda pelas
 *     funções que já existem em `reserva-da-assinatura.ts` (reserva se houver,
 *     humano se não houver).
 *  3. Falha de rede NÃO marca revogada: ela pode acontecer uma vez e o passo
 *     seguinte pode tentar de novo.
 *
 * Sabotagem que confirma que a guarda vigia: remover a trava (o `if` que
 * devolve a promessa em curso) deixa o primeiro caso vermelho — previsão
 * escrita antes de rodar, no corpo do PR.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErroDeToken, type TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";
import {
  comTravaDeRotacao,
  esquecerEstadosDeRefresh,
  quedaPorTokenRevogado,
  renovarComTrava,
} from "@/lib/ai/pontos/renovacao-da-assinatura";

const CHAVE = "login_codex";

function tokens(sufixo: string): TokensDoCodex {
  return {
    access_token: `access_${sufixo}`,
    refresh_token: `refresh_${sufixo}`,
    expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
}

beforeEach(() => {
  esquecerEstadosDeRefresh();
});

describe("dois refreshes concorrentes fazem UM só POST", () => {
  it("as duas chamadas recebem o MESMO resultado, e o `renovar` roda uma vez", async () => {
    let liberar: () => void = () => {};
    const porta = new Promise<void>((resolver) => {
      liberar = resolver;
    });
    const renovar = vi.fn(async () => {
      await porta;
      return tokens("novo");
    });

    const primeira = renovarComTrava({ chave: CHAVE, renovar });
    const segunda = renovarComTrava({ chave: CHAVE, renovar });
    liberar();

    const [r1, r2] = await Promise.all([primeira, segunda]);
    expect(renovar).toHaveBeenCalledTimes(1);
    // `expires_at` é `Date.now()` no instante da chamada — compara-se a forma,
    // não o instante (os dois resultados são o MESMO objeto, provado abaixo).
    expect(r1).toMatchObject({
      ok: true,
      tokens: { access_token: "access_novo", refresh_token: "refresh_novo" },
    });
    expect(r2).toBe(r1);
  });

  it("travas de chaves DIFERENTES rodam em paralelo — a trava é por chave", async () => {
    let liberar: () => void = () => {};
    const porta = new Promise<void>((resolver) => {
      liberar = resolver;
    });
    const renovar = vi.fn(async () => {
      await porta;
      return tokens("paralelo");
    });

    const a = comTravaDeRotacao("chave_a", renovar);
    const b = comTravaDeRotacao("chave_b", renovar);
    liberar();
    await Promise.all([a, b]);
    expect(renovar).toHaveBeenCalledTimes(2);
  });

  it("depois de terminar, a chave fica livre — a próxima janela renova de novo", async () => {
    const renovar = vi.fn(async () => tokens("primeira"));
    await renovarComTrava({ chave: CHAVE, renovar });
    await renovarComTrava({ chave: CHAVE, renovar });
    expect(renovar).toHaveBeenCalledTimes(2);
  });
});

describe("refresh_token_revoked não tenta de novo", () => {
  it("a primeira recusa marca a chave; a segunda volta sem chamar a rede", async () => {
    const renovar = vi.fn(async () => {
      throw new ErroDeToken("refresh_token_revoked", 400, "refresh_token_revoked");
    });

    const primeira = await renovarComTrava({ chave: CHAVE, renovar });
    expect(primeira).toEqual({ ok: false, motivo: "refresh_token_revoked" });
    expect(renovar).toHaveBeenCalledTimes(1);

    const segunda = await renovarComTrava({ chave: CHAVE, renovar });
    expect(segunda).toEqual({ ok: false, motivo: "refresh_token_revoked" });
    expect(renovar).toHaveBeenCalledTimes(1);
  });

  it("o motivo revogado aciona a queda que já existe: reserva se há, humano se não há", () => {
    expect(quedaPorTokenRevogado(true)).toEqual({
      acao: "tentar_reserva",
      provedorDeReserva: "openai",
      motivo: "sem_autorizacao",
    });
    expect(quedaPorTokenRevogado(false)).toEqual({
      acao: "passar_para_humano",
      motivo: "sem_autorizacao",
    });
  });

  it("cada chave tem a memória dela: revogar uma não revoga a outra", async () => {
    const revogado = vi.fn(async () => {
      throw new ErroDeToken("refresh_token_revoked", 400);
    });
    const outro = vi.fn(async () => tokens("outro"));

    await renovarComTrava({ chave: "chave_revogada", renovar: revogado });
    const resultado = await renovarComTrava({ chave: "chave_boa", renovar: outro });

    expect(revogado).toHaveBeenCalledTimes(1);
    expect(resultado.ok).toBe(true);
    expect(outro).toHaveBeenCalledTimes(1);
  });
});

describe("falha de rede NÃO marca revogada", () => {
  it("a segunda tentativa chega à rede de novo", async () => {
    const renovar = vi
      .fn()
      .mockRejectedValueOnce(new ErroDeToken("rede", null, "timeout"))
      .mockResolvedValueOnce(tokens("depois"));

    const primeira = await renovarComTrava({ chave: CHAVE, renovar });
    expect(primeira).toEqual({ ok: false, motivo: "rede" });

    const segunda = await renovarComTrava({ chave: CHAVE, renovar });
    expect(segunda.ok).toBe(true);
    expect(renovar).toHaveBeenCalledTimes(2);
  });

  it("erro desconhecido vira 'recusado' e também não trava a chave", async () => {
    const renovar = vi.fn(async () => {
      throw new Error("estranho");
    });
    await expect(renovarComTrava({ chave: CHAVE, renovar })).resolves.toEqual({
      ok: false,
      motivo: "recusado",
    });
    await renovarComTrava({ chave: CHAVE, renovar });
    expect(renovar).toHaveBeenCalledTimes(2);
  });
});
