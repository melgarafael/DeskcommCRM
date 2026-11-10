/**
 * A cota de campos do funil não conta junto os campos do CONTATO (issue #3111).
 *
 * O defeito, medido pelo autor na 1.86: `pipelineConfigPatchSchema.fields` aceita
 * no máximo 50 campos, e desde a #2791 os campos do CONTATO são declarados no
 * MESMO array (`escopo: "contato"`) — então 20 do negócio + 20 do contato já
 * chegavam a 40 de 50 e o funil travava antes de cobrir o negócio.
 *
 * O conserto é de CONTAGEM, não de teto: a cota continua 50 e continua valendo
 * para o NEGÓCIO. Quem não conta é o campo do contato — ele não aparece no card
 * e o valor dele mora em `contacts.custom_fields`, não em `crm_leads.custom_fields`.
 *
 * Os quatro casos que o defeito exige estão nomeados abaixo: aceito no teto do
 * negócio com contato junto, recusado acima do teto com mensagem legível, o
 * contato fora da conta, e o CONTROLE de que a régua antiga do negócio segue
 * inteira.
 */
import { describe, it, expect } from "vitest";

import {
  MAX_CAMPOS_DO_NEGOCIO,
  MENSAGEM_DO_TETO_DE_CAMPOS_DO_NEGOCIO,
  pipelineConfigPatchSchema,
  type CustomFieldDef,
} from "@/lib/schemas/settings";
import {
  MAX_CAMPOS_DO_FUNIL,
  comNovoCampo,
} from "@/lib/webhooks/campo-da-captacao";

/** Campos do NEGÓCIO: sem `escopo`, como toda definição que já existe. */
function doNegocio(quantidade: number, prefixo = "n"): CustomFieldDef[] {
  return Array.from({ length: quantidade }, (_, i) => ({
    key: `${prefixo}${i}`,
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

function validar(fields: CustomFieldDef[]) {
  return pipelineConfigPatchSchema.safeParse({ fields });
}

function mensagens(resultado: ReturnType<typeof validar>): string {
  return resultado.success ? "" : resultado.error.issues.map((i) => i.message).join(" · ");
}

describe("cota de campos do funil (#3111)", () => {
  it("aceita o teto de 50 campos do NEGÓCIO com campos do CONTATO junto", () => {
    // O caso do autor: o funil cheio do negócio ainda cabe os campos do contato.
    const r = validar([...doNegocio(MAX_CAMPOS_DO_NEGOCIO), ...doContato(20)]);
    expect(r.success).toBe(true);
  });

  it("recusa 51 campos do NEGÓCIO com mensagem legível", () => {
    const r = validar(doNegocio(MAX_CAMPOS_DO_NEGOCIO + 1));
    expect(r.success).toBe(false);
    expect(mensagens(r)).toContain(MENSAGEM_DO_TETO_DE_CAMPOS_DO_NEGOCIO);
    // A frase diz o número e o que não entra na conta — é ela que o servidor devolve.
    expect(mensagens(r)).toContain("50");
    expect(mensagens(r)).toMatch(/negócio/i);
    expect(mensagens(r)).toContain("contato");
    // E diz QUANTO chegou, para a pessoa saber o que tirar.
    expect(mensagens(r)).toContain("Recebidos 51");
  });

  it("o campo do CONTATO não consome a cota do negócio", () => {
    // 40 do negócio + 30 do contato = 70 no array: acima de 50 no total, mas só
    // 40 do negócio. Antes do conserto isto era recusado; agora passa.
    expect(validar([...doNegocio(40), ...doContato(30)]).success).toBe(true);
    // E o teto do contato não existe: 50 do negócio + 100 do contato.
    expect(validar([...doNegocio(MAX_CAMPOS_DO_NEGOCIO), ...doContato(100)]).success).toBe(true);
    // A recusa segue sendo do NEGÓCIO: 51 do negócio cai MESMO com contato junto.
    expect(validar([...doNegocio(MAX_CAMPOS_DO_NEGOCIO + 1), ...doContato(5)]).success).toBe(false);
  });

  it("CONTROLE: a régua antiga do negócio segue inteira (teto e ausência de escopo)", () => {
    // 50 exatos passam; 51 não — o teto do negócio não afrouxou.
    expect(validar(doNegocio(MAX_CAMPOS_DO_NEGOCIO)).success).toBe(true);
    expect(validar(doNegocio(MAX_CAMPOS_DO_NEGOCIO + 1)).success).toBe(false);
    // A ausência de `escopo` é `negocio` (toda definição que já existe): 50 sem
    // escopo + 1 do contato passa, 51 sem escopo não.
    expect(validar([...doNegocio(MAX_CAMPOS_DO_NEGOCIO), ...doContato(1)]).success).toBe(true);
    // Um array só de contato não tem teto nenhum do lado do negócio.
    expect(validar(doContato(200)).success).toBe(true);
  });
});

describe("captação de campo do funil (#3111)", () => {
  it("a captação não trava com o funil cheio de campo do CONTATO", () => {
    // 20 do negócio + 30 do contato = 50 no array: a captação acrescenta um campo
    // do NEGÓCIO e isto passa (antes do conserto era recusado como "limite").
    const misto = [...doNegocio(20), ...doContato(30)];
    const r = comNovoCampo(misto, "novo", "Novo", "text");
    expect(r.ok).toBe(true);
  });

  it("a captação segue recusando quando os 50 campos do NEGÓCIO estão cheios", () => {
    const cheio = [...doNegocio(MAX_CAMPOS_DO_FUNIL), ...doContato(10)];
    expect(comNovoCampo(cheio, "novo", "Novo", "text")).toEqual({
      ok: false,
      motivo: "limite",
    });
  });
});
