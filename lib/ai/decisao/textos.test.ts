/**
 * O QUE O JEV DIZ A QUEM OPERA — em espanhol também, e sem jargão.
 *
 * As frases chegam à tela por `t(variável)` (Execuções) ou são traduzidas no
 * insert (Central), e o guarda de tela só enxerga `t("literal")`: sem este
 * arquivo, frase nova sai em português numa instalação em espanhol sem gate
 * nenhum reclamar.
 */
import { describe, expect, it } from "vitest";

import {
  AO_EXCLUIR_A_CHAVE_DO_JEV,
  AVISO_DO_JEV,
  avisoDoJevNaCentral,
  JEV_FALHOU_SEM_RESERVA,
  O_QUE_FAZER_DO_JEV,
} from "@/lib/ai/decisao/textos";
import { EXPLICACAO_DA_ORIGEM } from "@/lib/ai/pontos/resolver";
import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";

const TEXTOS = [
  ...Object.values(O_QUE_FAZER_DO_JEV),
  ...Object.values(AVISO_DO_JEV),
  EXPLICACAO_DA_ORIGEM.jev,
  EXPLICACAO_DA_ORIGEM.jev_observacao,
  EXPLICACAO_DA_ORIGEM.reserva_do_jev,
  EXPLICACAO_DA_ORIGEM.jev_cobriu,
  JEV_FALHOU_SEM_RESERVA,
  ...Object.values(AO_EXCLUIR_A_CHAVE_DO_JEV),
];

describe("textos do Jev para quem opera", () => {
  it("a varredura enxerga os textos (controle positivo)", () => {
    expect(TEXTOS.length).toBeGreaterThanOrEqual(13);
  });

  it("todo texto tem espanhol", () => {
    expect(TEXTOS.filter((t) => !DICIONARIO[t]?.es)).toEqual([]);
  });

  it("nenhum texto fala a língua do engenheiro", () => {
    const jargao = /\b(400|401|402|403|422|429|5\d\d|HTTP|status|timeout|token|prompt|API|score|provider|JSON)\b/i;
    expect(TEXTOS.filter((t) => jargao.test(t))).toEqual([]);
  });

  it("o aviso da Central diz o que fazer, se a IA de sempre cobre, e que se fecha sozinho", () => {
    const comReserva = avisoDoJevNaCentral("credencial_invalida", true, (t) => t);
    expect(comReserva.title).toBe(AVISO_DO_JEV.titulo);
    expect(comReserva.body).toContain(O_QUE_FAZER_DO_JEV.jev_credencial_invalida);
    expect(comReserva.body).toContain(AVISO_DO_JEV.comReserva);
    expect(comReserva.body).toContain(AVISO_DO_JEV.rearme);

    const semReserva = avisoDoJevNaCentral("sem_credito", false, (t) => t);
    expect(semReserva.body).toContain(AVISO_DO_JEV.semReserva);
    expect(semReserva.body).not.toContain(AVISO_DO_JEV.comReserva);
  });

  it("o aviso sai no idioma da organização", () => {
    const es = avisoDoJevNaCentral("contrato_invalido", true, (t) => traduzir(t, "es"));
    expect(es.title).toBe(DICIONARIO[AVISO_DO_JEV.titulo]?.es);
    expect(es.body).not.toContain("Enquanto isso");
  });
});
