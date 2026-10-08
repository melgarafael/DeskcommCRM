/**
 * A TRAVA DA ROTAÇÃO E O QUE SOBROU DELA — o que este teste guarda.
 *
 *  1. DOIS refreshes concorrentes fazem UM só POST — mas essa garantia AGORA
 *     mora no banco (`renovarComTravaDeBanco`, com o UPDATE condicional), não
 *     num `Map` de processo: `app`, `worker` e `scheduler` são contêineres
 *     separados e o mapa de um deles não atravessa os outros. A trava em
 *     memória (`rotacoesEmCurso`) foi apagada na fiação da assinatura
 *     (#1639, parte 2); reimportá-la agora erra no IMPORT, não em produção.
 *     A cobertura com dois processos está em
 *     `credenciais-login-codex-por-empresa.test.ts`.
 *  2. `refresh_token_revoked` NÃO tenta de novo: repetir é mandar de propósito
 *     um token sabidamente revogado — e o motivo vira decisão de queda pelas
 *     funções que já existem em `reserva-da-assinatura.ts` (reserva se há,
 *     humano se não há).
 *  3. A janela de renovação continua sendo de 8 dias, e `expires_at` nulo
 *     nunca decide sozinho: renovar sem precisar troca um token bom por nada.
 *
 * Sabotagem que confirma a guarda: recolar `const rotacoesEmCurso = new Map()`
 * em `lib/ai/pontos/renovacao-da-assinatura.ts` deixa o caso 1 vermelho —
 * previsão escrita antes de rodar, no corpo do PR.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  JANELA_DE_RENOVACAO_MS,
  quedaPorTokenRevogado,
  renovacaoProxima,
  renovarSeProxima,
} from "@/lib/ai/pontos/renovacao-da-assinatura";

const FONTE_DA_RENOVACAO = path.join(process.cwd(), "lib/ai/pontos/renovacao-da-assinatura.ts");
const FONTE_DO_LOGIN = path.join(process.cwd(), "lib/ai/credenciais/login-codex.ts");
const renovacao = fs.readFileSync(FONTE_DA_RENOVACAO, "utf8");
const login = fs.readFileSync(FONTE_DO_LOGIN, "utf8");

describe("a trava em memória não existe mais — ninguém a usa por engano", () => {
  it("rotacoesEmCurso, comTravaDeRotacao, chavesRevogadas e renovarComTrava saíram do módulo", () => {
    expect(renovacao, "a trava de processo voltou — ela não atravessa contêineres").not.toContain(
      "rotacoesEmCurso",
    );
    expect(renovacao).not.toContain("comTravaDeRotacao");
    expect(renovacao).not.toContain("chavesRevogadas");
    expect(renovacao, "renovarComTrava prometia uma trava que não existe mais").not.toContain(
      "renovarComTrava(",
    );
  });

  it("quem renova usa a trava DO BANCO, que vale em todos os processos", () => {
    expect(login, "a rotação simultânea precisa do UPDATE condicional").toContain(
      "renovarComTravaDeBanco",
    );
  });
});

describe("a janela de renovação continua sendo a mesma", () => {
  it("8 dias — e a folga contada inteira ainda não é hora de renovar", () => {
    expect(JANELA_DE_RENOVACAO_MS).toBe(8 * 24 * 60 * 60 * 1000);
    const agora = 1_700_000_000_000;
    expect(renovacaoProxima(agora + JANELA_DE_RENOVACAO_MS, agora)).toBe(true);
    expect(renovacaoProxima(agora + JANELA_DE_RENOVACAO_MS + 1, agora)).toBe(false);
  });

  it("`expires_at` nulo nunca decide sozinho", () => {
    expect(renovacaoProxima(null)).toBe(false);
  });

  it("renovarSeProxima só chama o provedor quando a janela abriu", async () => {
    const renovar = vi.fn(async () => ({ access_token: "x", refresh_token: "y", expires_at: null }));
    expect(await renovarSeProxima({ expiraEm: null, renovar })).toBe(false);
    expect(renovar).not.toHaveBeenCalled();

    expect(await renovarSeProxima({ expiraEm: Date.now() + 60 * 60 * 1000, renovar })).toBe(true);
    expect(renovar).toHaveBeenCalledTimes(1);
  });
});

describe("refresh_token_revoked vira decisão de queda — pelas funções que já existem", () => {
  it("havendo reserva, a chamada cai na chave da empresa", () => {
    expect(quedaPorTokenRevogado(true)).toEqual({
      acao: "tentar_reserva",
      provedorDeReserva: "openai",
      motivo: "sem_autorizacao",
    });
  });

  it("sem reserva, a conversa passa para um humano — nunca fica calada", () => {
    expect(quedaPorTokenRevogado(false)).toEqual({
      acao: "passar_para_humano",
      motivo: "sem_autorizacao",
    });
  });
});
