/**
 * O teto de campos do NEGÓCIO por funil passa de 50 para 100 (issue #4780).
 *
 * O caso medido pelo autor: uma agência de viagens precisa de +5 campos
 * condicionais no funil e bate no teto de 50 — a issue oferece três saídas e
 * diz que a 1 ("aumentar o limite, ex.: 100") é a que resolve agora. Esta
 * entrega faz SÓ a saída 1: o número sobe, a contagem não muda.
 *
 * O que estes casos prendem, e por quê:
 *
 *  1. o número do teto é 100 — o único lugar que o declara é
 *     `MAX_CAMPOS_DO_NEGOCIO`, e é ele que a tela do funil lê para esconder o
 *     botão "Adicionar campo";
 *  2. 100 campos do negócio são ACEITOS, mesmo com 20 do contato no MESMO
 *     array (a conta da #3111: contato não entra);
 *  3. 101 campos do negócio são RECUSADOS, e a mensagem diz o literal `100` e
 *     a frase de que os campos do contato não entram nesta conta — é ela que o
 *     servidor devolve e a pessoa lê.
 *
 * O CONTROLE da #3111 segue no arquivo vizinho
 * (`cota-de-campos-do-funil.test.ts`), que conta pelo `escopo` e continua
 * verde por construção.
 */
import { describe, it, expect } from "vitest";

import {
  MAX_CAMPOS_DO_NEGOCIO,
  MENSAGEM_DO_TETO_DE_CAMPOS_DO_NEGOCIO,
  pipelineConfigPatchSchema,
  type CustomFieldDef,
} from "@/lib/schemas/settings";
import { MAX_CAMPOS_DO_FUNIL } from "@/lib/webhooks/campo-da-captacao";

/** Campos do NEGÓCIO: sem `escopo`, como toda definição que já existe. */
function doNegocio(quantidade: number): CustomFieldDef[] {
  return Array.from({ length: quantidade }, (_, i) => ({
    key: `n${i}`,
    label: `Negócio ${i}`,
    type: "text" as const,
  }));
}

/** Campos do CONTATO: `escopo: "contato"` (a marca que a #2791 trouxe). */
function doContato(quantidade: number): CustomFieldDef[] {
  return Array.from({ length: quantidade }, (_, i) => ({
    key: `c${i}`,
    label: `Contato ${i}`,
    type: "text" as const,
    escopo: "contato" as const,
  }));
}

function mensagens(fields: CustomFieldDef[]): string {
  const r = pipelineConfigPatchSchema.safeParse({ fields });
  return r.success ? "" : r.error.issues.map((i) => i.message).join(" · ");
}

describe("teto de 100 campos do negócio (#4780)", () => {
  it("o teto do negócio é 100, e a captação deriva dele", () => {
    // O número é a entrega: sem ele, o resto destes casos passaria com 50.
    expect(MAX_CAMPOS_DO_NEGOCIO).toBe(100);
    // A captação de campo não declara teto próprio — ela lê o mesmo número.
    expect(MAX_CAMPOS_DO_FUNIL).toBe(100);
    // E a frase que o servidor devolve carrega o número novo.
    expect(MENSAGEM_DO_TETO_DE_CAMPOS_DO_NEGOCIO).toContain("100");
    expect(MENSAGEM_DO_TETO_DE_CAMPOS_DO_NEGOCIO).toContain(
      "Os campos do contato não entram nesta conta.",
    );
  });

  it("aceita 100 campos do NEGÓCIO com 20 do CONTATO junto", () => {
    // O caso da agência: o funil cheio do negócio ainda cabe o contato.
    const r = pipelineConfigPatchSchema.safeParse({
      fields: [...doNegocio(100), ...doContato(20)],
    });
    expect(r.success).toBe(true);
  });

  it("recusa 101 campos do NEGÓCIO com mensagem que diz 100", () => {
    const r = pipelineConfigPatchSchema.safeParse({ fields: doNegocio(101) });
    expect(r.success).toBe(false);
    const texto = mensagens(doNegocio(101));
    expect(texto).toContain("máximo 100 campos do negócio");
    expect(texto).toContain("Os campos do contato não entram nesta conta.");
    // E diz QUANTO chegou, para a pessoa saber o que tirar.
    expect(texto).toContain("Recebidos 101.");
    // O 50 NÃO é mais o teto: 51 campos do negócio passam a ser aceitos.
    expect(pipelineConfigPatchSchema.safeParse({ fields: doNegocio(51) }).success).toBe(true);
  });

  it("o campo do CONTATO segue fora da conta com o teto novo", () => {
    // 100 do negócio + 100 do contato = 200 no array: só 100 do negócio contam.
    expect(
      pipelineConfigPatchSchema.safeParse({
        fields: [...doNegocio(100), ...doContato(100)],
      }).success,
    ).toBe(true);
    // E o teto novo recusa do NEGÓCIO mesmo com contato junto.
    expect(
      pipelineConfigPatchSchema.safeParse({
        fields: [...doNegocio(101), ...doContato(5)],
      }).success,
    ).toBe(false);
  });
});
