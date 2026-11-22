/**
 * O AVISO DE REPETIÇÃO DIZ O PRÓXIMO PASSO — e diz em espanhol também.
 *
 * O defeito medido na #4943: quem recebia "A mesma mensagem estava se repetindo
 * em massa por este número" entendia que precisava DESLIGAR a proteção, não
 * achava onde, e pedia a remoção da trava. O aviso dizia o que aconteceu e
 * parava aí — faltava o que fazer, e faltava dizer o que a trava NÃO conta
 * (mensagens curtas e links de pagamento), que é o medo que faz o operador
 * parar de cobrar.
 *
 * O texto é chave de `DICIONARIO` (a chave é o português), então este arquivo
 * cobra as duas coisas de uma vez: a frase portuguesa carrega o próximo passo e
 * a entrada em espanhol existe e diz o mesmo. Sem a segunda, a cerca
 * `i18n-espanhol-cobre-a-tela` reprova no mesmo commit — mas reprovaria pelo
 * motivo genérico, sem dizer que ESTE aviso ficou sem tradução.
 */
import { describe, expect, it } from "vitest";

import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";

import { retentionCopy, type RetentionContext } from "./retention-copy";

const ctx: RetentionContext = {
  window_start_hour: 8,
  window_end_hour: 21,
  allow_sunday: false,
  timezone: "America/Sao_Paulo",
};

/** O texto português que a copy entregou a `t()` — é a chave do dicionário. */
function chaveDaCopy(code: string): string {
  const chaves: string[] = [];
  retentionCopy(code, ctx, (texto) => {
    chaves.push(texto);
    return texto;
  });
  const chave = chaves.find((c) => c.startsWith("A mesma mensagem estava se repetindo"));
  if (!chave) throw new Error(`a copy de ${code} não passou a frase pelo t(): ${chaves.join(" | ")}`);
  return chave;
}

describe("o aviso de mass_identical diz o que fazer", () => {
  it("continua sendo proteção do número, não erro nem conformidade", () => {
    expect(retentionCopy("mass_identical", ctx).kind).toBe("protection");
  });

  it("diz o próximo passo em linguagem de quem opera: objetivo no prompt, não o texto exato", () => {
    const { description } = retentionCopy("mass_identical", ctx);
    expect(description).toContain("Para liberar:");
    expect(description).toContain("descreva o objetivo de cada mensagem em vez do texto exato");
    expect(description).toContain("personalizar com o nome e o contexto do lead");
  });

  // O mesmo trace mass_identical chega quando quem colidiu foi um passo de
  // follow-up com uma redação só (followup-turn.ts passa pelo runBeforeSend com
  // o spinning armado) — e esse texto mora no passo, não no prompt. Sem esta
  // frase, o aviso manda o operador mexer no lugar que não controla o envio.
  it("diz a saída do follow-up de texto fixo: outras redações no passo, em pt e es", () => {
    expect(retentionCopy("mass_identical", ctx).description).toContain(
      "se for um passo de follow-up com texto fixo, acrescente outras redações ao passo",
    );
    const es = retentionCopy("mass_identical", ctx, (texto) => traduzir(texto, "es")).description;
    expect(es).toContain("si es un paso de seguimiento con texto fijo, agrega otras redacciones al paso");
  });

  it("diz o que a trava NÃO conta — curtas e links de pagamento", () => {
    expect(retentionCopy("mass_identical", ctx).description).toContain(
      "Mensagens curtas e links de pagamento não entram nessa conta.",
    );
  });

  it("a chave portuguesa tem espanhol no dicionário e a tradução diz o mesmo próximo passo", () => {
    const chave = chaveDaCopy("mass_identical");
    const es = DICIONARIO[chave]?.es;
    expect(es, `a frase de mass_identical ficou sem espanhol: ${chave}`).toBeTruthy();
    expect(es).toContain("Para liberarlo:");
    expect(es).toContain("en el prompt");
    expect(es).toContain("nombre y el contexto del lead");
    expect(es).toContain("enlaces de pago no cuentan");
    // Degradar para português é a regra do dicionário; passar batido não é.
    expect(traduzir(chave, "es")).not.toBe(chave);
  });

  it("a tela em espanhol entrega a frase traduzida, não o português", () => {
    const emEspanhol = retentionCopy("mass_identical", ctx, (texto) => traduzir(texto, "es"));
    expect(emEspanhol.description).toContain("Para liberarlo:");
    expect(emEspanhol.description).not.toContain("Para liberar:");
  });

  it("os vizinhos de proteção e conformidade não herdam a frase do próximo passo", () => {
    for (const code of ["daily_cap", "warmup_cap", "contato_bloqueado"]) {
      const { description } = retentionCopy(code, ctx);
      expect(description, `${code} ganhou o texto de mass_identical`).not.toContain("Para liberar:");
      expect(description, `${code} ganhou o texto de mass_identical`).not.toContain(
        "descreva o objetivo de cada mensagem",
      );
    }
    // O motivo de cada um continua o de antes: nada de "prompt" onde o defeito
    // é limite diário ou opt-out.
    expect(retentionCopy("contato_bloqueado", ctx).kind).toBe("compliance");
    expect(retentionCopy("daily_cap", ctx).description).toContain("limite diário");
    expect(retentionCopy("warmup_cap", ctx).description).toContain("aquecimento");
  });
});
