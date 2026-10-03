import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { soChavesAlteradas } from "@/lib/leads/custom-fields-so-diff";

/**
 * O payload de `custom_fields` é o DIFF contra o valor carregado ao abrir
 * (issue #2132).
 *
 * O defeito, medido na `main`: a ficha do dossiê (`LeadFieldsForm`) e o painel
 * do CRM na inbox (`CRMSidePanel`) enviavam o objeto INTEIRO que carregaram.
 * O servidor soma o que chega com o que já está gravado (`{ ...prev, ...input }`),
 * então quem salvava por último devolvia ao valor velho o que outra pessoa — ou
 * o assistente, MCP `crm_update_lead` — mudou enquanto a ficha estava aberta.
 * Sem erro: o salvamento dava certo e o campo voltava.
 *
 * O que reprova SEM o conserto: montar o payload como ele é feito HOJE entrega
 * as chaves intocadas no JSON e sobrescreve o valor que outro mudou. É o caso
 * "a chave intocada fica FORA", mais a sonda de fiação nos dois componentes —
 * elas leem o fonte e pegam `custom_fields: customFields`, que é o corpo do
 * defeito.
 *
 * Limpeza não pode ser engolida: apagar um valor preenchido viaja como chave
 * presente com string vazia, e o merge do servidor continua mandando.
 */

const CARREGADO = { orcamento: "3000", prazo: "15 dias" };

describe("soChavesAlteradas — só o que a pessoa alterou", () => {
  it("a chave alterada vai no payload, com o valor novo", () => {
    const payload = soChavesAlteradas(CARREGADO, { ...CARREGADO, orcamento: "5000" });
    expect(payload.orcamento).toBe("5000");
  });

  it("a chave intocada fica FORA do payload", () => {
    // Hoje (sem o conserto) o payload é o objeto inteiro: `orcamento` viaja
    // sem ninguém tê-lo mexido e devolve ao valor velho quem mudou por fora.
    const payload = soChavesAlteradas(CARREGADO, { ...CARREGADO, prazo: "30 dias" });
    expect(payload).toEqual({ prazo: "30 dias" });
  });

  it("limpar um valor preenchido é transmitido: chave presente com string vazia", () => {
    const payload = soChavesAlteradas(CARREGADO, { ...CARREGADO, prazo: "" });
    expect(payload).toHaveProperty("prazo", "");
  });

  it("campo que ainda não existia é transmitido", () => {
    const payload = soChavesAlteradas(CARREGADO, { ...CARREGADO, entrega: "15 dias" });
    expect(payload).toHaveProperty("entrega", "15 dias");
  });

  it("sem nenhuma alteração o payload é vazio", () => {
    expect(soChavesAlteradas(CARREGADO, { ...CARREGADO })).toEqual({});
    expect(soChavesAlteradas(undefined, undefined)).toEqual({});
  });

  it("dois salvos concorrentes sobre chaves diferentes não se apagam", () => {
    // As duas fichas abriram com a MESMA base: A mexe no orçamento enquanto B,
    // do outro lado, mexe no prazo. Cada uma manda só o que mudou; o servidor
    // soma cada payload no que já está gravado.
    const payloadA = soChavesAlteradas(CARREGADO, { ...CARREGADO, orcamento: "5000" });
    const payloadB = soChavesAlteradas(CARREGADO, { ...CARREGADO, prazo: "30 dias" });
    const gravado = { ...CARREGADO, ...payloadA, ...payloadB };
    expect(gravado).toEqual({ orcamento: "5000", prazo: "30 dias" });
  });
});

describe("fiação — os dois componentes montam o patch pelo diff", () => {
  const ARQUIVOS = [
    "components/kanban/LeadFieldsForm.tsx",
    "components/inbox/CRMSidePanel.tsx",
  ];

  for (const arquivo of ARQUIVOS) {
    it(`${arquivo} passa o custom_fields pelo diff`, () => {
      const fonte = readFileSync(join(process.cwd(), arquivo), "utf8");
      expect(fonte, `${arquivo} não chama soChavesAlteradas`).toMatch(/soChavesAlteradas\(/);
      // O corpo do defeito: o objeto carregado indo para o patch inteiro.
      expect(fonte, `${arquivo} ainda envia o objeto carregado`).not.toMatch(
        /custom_fields:\s*customFields\b/,
      );
    });
  }
});
