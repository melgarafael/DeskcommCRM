import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  lerLimiteDoPlano,
  lerLimiteEstourado,
  mensagemDoLimite,
  traduzirLimiteDoPlano,
} from "./limites";

/**
 * O LIMITE DO PLANO FALA COM QUEM CLICOU (spec da cobrança do revendedor §5).
 *
 * Quem recusa é o banco: os gatilhos de assentos e de canais levantam `PT402`
 * com a mensagem `limite_do_plano:<recurso>:<teto>`. Sem a tradução, a rota
 * devolvia 500 `internal_error` — e o dono do negócio lia "erro interno" onde
 * devia ler "seu plano permite 2 números".
 */
describe("traduzirLimiteDoPlano", () => {
  it("⭐ o PT402 do gatilho de canais vira 409 plan_limit_reached com o número", () => {
    expect(
      traduzirLimiteDoPlano({ code: "PT402", message: "limite_do_plano:canais:2" }, "pt-BR"),
    ).toEqual({
      code: "plan_limit_reached",
      message:
        "Seu plano permite 2 números conectados. Exclua um número em Conexões ou peça a quem administra o sistema para trocar de plano.",
      details: { recurso: "canais", limite: 2 },
    });
  });

  it("a recusa que chega como STRING também é lida — save*Session devolve só error.message", () => {
    expect(lerLimiteEstourado("limite_do_plano:assentos:3")).toEqual({ recurso: "assentos", limite: 3 });
  });

  it.each([
    null,
    undefined,
    "deadlock detected",
    { code: "23505", message: "duplicate key value" },
    { code: "PT402", message: 42 },
  ])("%j não é limite do plano", (erro) => {
    expect(traduzirLimiteDoPlano(erro, "pt-BR")).toBeNull();
  });

  it("as duas frases têm espanhol", () => {
    expect(mensagemDoLimite("assentos", 5, "es")).toBe(
      "Tu plan permite 5 personas y todas las plazas están ocupadas. Revoca el acceso de alguien en Equipo o pide a quien administra el sistema que cambie el plan.",
    );
    expect(mensagemDoLimite("canais", 1, "es")).toBe(
      "Tu plan permite 1 número conectado. Elimina un número en Conexiones o pide a quien administra el sistema que cambie el plan.",
    );
  });

  it("teto 1 fala no singular — plano de uma pessoa só é comum, e '1 pessoas' é a tela dizendo que ninguém a leu", () => {
    expect(mensagemDoLimite("assentos", 1, "pt-BR")).toBe(
      "Seu plano permite 1 pessoa e a vaga está ocupada. Revogue o acesso de alguém em Equipe ou peça a quem administra o sistema para trocar de plano.",
    );
    expect(mensagemDoLimite("canais", 1, "pt-BR")).toBe(
      "Seu plano permite 1 número conectado. Exclua um número em Conexões ou peça a quem administra o sistema para trocar de plano.",
    );
  });
});

describe("lerLimiteDoPlano", () => {
  it("devolve o teto e null para 'sem limite', perguntando à função do banco", async () => {
    const rpc = vi.fn(async (): Promise<{ data: number | null; error: null }> => ({ data: 3, error: null }));
    expect(await lerLimiteDoPlano({ rpc } as never, "org-1", "assentos")).toBe(3);
    expect(rpc).toHaveBeenCalledWith("fn_limite_do_plano", { p_org: "org-1", p_recurso: "assentos" });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await lerLimiteDoPlano({ rpc } as never, "org-1", "assentos")).toBeNull();
  });

  it("erro do banco LANÇA com o SQLSTATE — quem chama decide se segue", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42883", message: "function does not exist" } }));
    await expect(lerLimiteDoPlano({ rpc } as never, "org-1", "canais")).rejects.toThrow(/42883/);
  });
});

describe("o contrato com os gatilhos do banco", () => {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

  it.each(["assentos", "canais"])(
    "o gatilho de %s levanta PT402 com a mensagem que este módulo lê",
    (recurso) => {
      expect(
        baseline,
        `o baseline não tem \`raise exception 'limite_do_plano:${recurso}:%' ... errcode = 'PT402'\` — ` +
          "se a mensagem do gatilho mudou, toda recusa de limite volta a ser 500 na tela",
      ).toMatch(
        new RegExp(`raise\\s+exception\\s+'limite_do_plano:${recurso}:%'[^;]*errcode\\s*=\\s*'PT402'`, "i"),
      );
    },
  );
});
