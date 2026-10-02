/**
 * O PRÓXIMO PASSO QUE O BANCO ESCREVE CHEGA TRADUZIDO À TELA.
 *
 * `fn_service_inbound` grava em `demandas.proximo_passo` um texto fixo em
 * português quando uma mensagem nova abre uma demanda. A tela o reconhece pelo
 * valor exato e o traduz (`lib/atendimento/proximo-passo-padrao.ts`). As duas
 * pontas são texto solto — uma no SQL, outra no TypeScript —, e se uma mudar sem a
 * outra o painel volta a mostrar português numa operação em espanhol, calado.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PROXIMO_PASSO_DA_MENSAGEM_NOVA } from "@/lib/atendimento/proximo-passo-padrao";
import { traduzir } from "@/lib/i18n/dicionario";

const BASELINE = readFileSync("supabase/baseline.sql", "utf8");
const PAINEL = readFileSync("components/inbox/CRMSidePanel.tsx", "utf8");

/** A ÚLTIMA definição da função vale: o baseline é aplicado inteiro e em ordem. */
function ultimaDefinicao(nome: string): string {
  const i = BASELINE.lastIndexOf(`create or replace function public.${nome}`);
  expect(i, `${nome} não está no baseline`).toBeGreaterThan(0);
  return BASELINE.slice(i, BASELINE.indexOf("$$;", i));
}

describe("o próximo passo padrão da demanda nova", () => {
  it("é o texto exato que a função do banco grava", () => {
    const corpo = ultimaDefinicao("fn_service_inbound");
    expect(corpo).toContain(`'${PROXIMO_PASSO_DA_MENSAGEM_NOVA}'`);
  });

  it("tem tradução para o espanhol", () => {
    expect(traduzir(PROXIMO_PASSO_DA_MENSAGEM_NOVA, "es")).toBe("Responder al nuevo mensaje del cliente");
  });

  it("o painel da conversa o reconhece e o traduz", () => {
    expect(PAINEL).toContain("d.proximo_passo === PROXIMO_PASSO_DA_MENSAGEM_NOVA");
    expect(PAINEL).toContain(`t("${PROXIMO_PASSO_DA_MENSAGEM_NOVA}")`);
  });
});
