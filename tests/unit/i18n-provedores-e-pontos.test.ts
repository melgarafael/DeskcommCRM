/**
 * TEXTO DE PROVEDOR E DE PONTO DE IA TEM ESPANHOL.
 *
 * Esses textos chegam à tela por `t(variavel)` — `t(provedor.quandoUsar)`,
 * `t(ponto.rotulo)` —, e o guarda de tela (`i18n-espanhol-cobre-a-tela`) só
 * enxerga `t("literal")`. Sem este arquivo, texto novo sai em português numa
 * tela em espanhol sem nenhum gate reclamar: foi o que aconteceu com o
 * `quandoUsar` da DeepSeek.
 *
 * O `rotulo` do PROVEDOR fica de fora de propósito: é nome de marca
 * ("Anthropic (Claude)", "Jev (TypeSafe AI)"), igual nos dois idiomas, e a
 * falta de entrada já degrada para ele mesmo.
 */
import { describe, expect, it } from "vitest";

import { TAREFAS_DO_JEV } from "@/lib/ai/decisao/tarefas";
import { PROVEDORES_COM_CHAVE } from "@/lib/ai/pontos/provedores";
import { PAPEIS, PONTOS_DE_IA } from "@/lib/ai/pontos/registro";
import { EXPLICACAO_DA_ORIGEM } from "@/lib/ai/pontos/resolver";
import { DICIONARIO } from "@/lib/i18n/dicionario";

function semEspanhol(textos: readonly string[]): string[] {
  return textos.filter((t) => !DICIONARIO[t]?.es);
}

describe("espanhol dos textos que vêm de lista, não de literal", () => {
  it("todo `quandoUsar` de provedor com chave", () => {
    expect(semEspanhol(PROVEDORES_COM_CHAVE.map((p) => p.quandoUsar))).toEqual([]);
  });

  it("todo texto de ponto de IA — rótulo, descrição, sintoma, razão de ser fixo e o que o Jev faz", () => {
    const textos = PONTOS_DE_IA.flatMap((p) => [
      p.rotulo,
      p.oQueFaz,
      p.sintomaDeFalha,
      // `t(ponto.fixo.razao)` no cartão do ponto (PainelDeProvedores).
      ...(p.fixo ? [p.fixo.razao] : []),
      ...(p.decisaoRapida ? [p.decisaoRapida.oQueOJevFaz] : []),
    ]);
    expect(textos.length, "a varredura não enxergou o registro").toBeGreaterThan(30);
    expect(semEspanhol(textos)).toEqual([]);
  });

  it("todo papel — o título e a explicação de cada grupo do painel de provedores", () => {
    const textos = Object.values(PAPEIS).flatMap((p) => [p.rotulo, p.explicacao]);
    expect(textos.length, "a varredura não enxergou os papéis").toBeGreaterThan(5);
    expect(semEspanhol(textos)).toEqual([]);
  });

  it("toda tarefa do Jev — o nome, o que muda quando ela decide e o que o diálogo avisa antes", () => {
    const textos = TAREFAS_DO_JEV.flatMap((x) => [x.rotulo, x.oQueFaz, x.aoDecidir, x.aoDecidirNoPonto, x.aoConfirmarDecidir]);
    expect(textos.length, "a varredura não enxergou as tarefas").toBeGreaterThan(8);
    expect(semEspanhol(textos)).toEqual([]);
  });

  it("toda explicação de origem — o \"por que este modelo\" de IA › Execuções", () => {
    expect(semEspanhol(Object.values(EXPLICACAO_DA_ORIGEM))).toEqual([]);
  });
});
