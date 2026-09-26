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
  avisoAoExcluirAChaveDoJev,
  AVISO_DO_JEV,
  avisoDoJevNaCentral,
  JEV_FALHOU_AO_LADO,
  JEV_FALHOU_E_A_IA_COBRIU,
  JEV_FALHOU_SEM_RESERVA,
  O_QUE_FAZER_DO_JEV,
} from "@/lib/ai/decisao/textos";
import { TAREFA_DO_CLIMA, TAREFA_DO_ROTEADOR } from "@/lib/ai/decisao/tarefas";
import { EXPLICACAO_DA_ORIGEM } from "@/lib/ai/pontos/resolver";
import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";

const TEXTOS = [
  ...Object.values(O_QUE_FAZER_DO_JEV),
  ...Object.values(AVISO_DO_JEV),
  EXPLICACAO_DA_ORIGEM.jev,
  EXPLICACAO_DA_ORIGEM.jev_observacao,
  EXPLICACAO_DA_ORIGEM.jev_teste,
  EXPLICACAO_DA_ORIGEM.reserva_do_jev,
  EXPLICACAO_DA_ORIGEM.jev_cobriu,
  JEV_FALHOU_SEM_RESERVA,
  JEV_FALHOU_AO_LADO,
  JEV_FALHOU_E_A_IA_COBRIU,
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

  // A mesma linha vem do turno e da tela "Testar classificação" do roteador
  // (`./pool.ts`): um clique de teste não atendeu ninguém.
  it("a falha do Jev ao lado não afirma que houve atendimento", () => {
    expect(JEV_FALHOU_AO_LADO).not.toMatch(/atendimento/i);
  });

  /**
   * O aviso de exclusão sai das tarefas que a chave serve agora (o "Usada em"),
   * e não só da chave: com o clima pausado, ele afirmava que "o clima deixa de
   * ser medido" — efeito que já valia — e dizia "O Jev usa esta chave" com o
   * "Usada em" vazio.
   */
  describe("o aviso ao excluir a chave do Jev", () => {
    const CLIMA = TAREFA_DO_CLIMA.rotulo;
    const ROTEADOR = TAREFA_DO_ROTEADOR.rotulo;
    it("sobrando outra chave apta, o Jev não desliga", () => {
      expect(avisoAoExcluirAChaveDoJev({ temOutraChave: true, tarefas: [CLIMA], temIaPrincipal: false })).toEqual([
        AO_EXCLUIR_A_CHAVE_DO_JEV.outraChave,
      ]);
    });
    it("clima entre as tarefas: diz quem mede sem ele", () => {
      expect(avisoAoExcluirAChaveDoJev({ temOutraChave: false, tarefas: [CLIMA, ROTEADOR], temIaPrincipal: true })).toEqual([
        AO_EXCLUIR_A_CHAVE_DO_JEV.usada,
        AO_EXCLUIR_A_CHAVE_DO_JEV.climaComIa,
      ]);
      expect(avisoAoExcluirAChaveDoJev({ temOutraChave: false, tarefas: [CLIMA], temIaPrincipal: false })).toContain(
        AO_EXCLUIR_A_CHAVE_DO_JEV.climaSemIa,
      );
    });
    it("clima pausado: não fala do clima", () => {
      const aviso = avisoAoExcluirAChaveDoJev({ temOutraChave: false, tarefas: [ROTEADOR], temIaPrincipal: false });
      expect(aviso).toEqual([AO_EXCLUIR_A_CHAVE_DO_JEV.usada]);
      expect(aviso.join(" ")).not.toMatch(/clima/);
    });
    it("nenhuma tarefa rodando: não diz que o Jev usa a chave", () => {
      const aviso = avisoAoExcluirAChaveDoJev({ temOutraChave: false, tarefas: [], temIaPrincipal: true });
      expect(aviso).toEqual([AO_EXCLUIR_A_CHAVE_DO_JEV.nenhumaTarefa]);
      expect(aviso.join(" ")).not.toMatch(/O Jev usa esta chave/);
    });
  });

  it("o aviso sai no idioma da organização", () => {
    const es = avisoDoJevNaCentral("contrato_invalido", true, (t) => traduzir(t, "es"));
    expect(es.title).toBe(DICIONARIO[AVISO_DO_JEV.titulo]?.es);
    expect(es.body).not.toContain("Enquanto isso");
  });
});
