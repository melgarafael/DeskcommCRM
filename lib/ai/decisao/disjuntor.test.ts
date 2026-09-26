/**
 * O DISJUNTOR para de bater num fornecedor que não responde — e volta sozinho.
 *
 * O relógio é injetado (`agora`) em vez de falsificado: o que se prova é a
 * regra, e cada caso usa uma organização própria porque o estado é do processo.
 */
import { describe, expect, it } from "vitest";

import { falhasSeguidas, podeTentar, registrarFalha, registrarSucesso } from "@/lib/ai/decisao/disjuntor";

const T0 = 1_000_000;
const MIN = 60_000;
let seq = 0;
const novaOrg = () => `org-disjuntor-${++seq}`;

describe("disjuntor do Jev", () => {
  it("fechado por padrão: organização nunca vista pode tentar", () => {
    expect(podeTentar(novaOrg(), T0)).toBe(true);
  });

  it("3 falhas seguidas abrem por 5 minutos, e depois ele deixa tentar de novo", () => {
    const org = novaOrg();
    registrarFalha(org, "provedor_indisponivel", T0);
    registrarFalha(org, "provedor_indisponivel", T0);
    expect(podeTentar(org, T0), "duas falhas ainda não abrem").toBe(true);

    registrarFalha(org, "provedor_indisponivel", T0);
    expect(podeTentar(org, T0)).toBe(false);
    expect(podeTentar(org, T0 + 5 * MIN - 1)).toBe(false);
    expect(podeTentar(org, T0 + 5 * MIN)).toBe(true);
  });

  it("depois de reabrir, UMA falha nova fecha de novo — a contagem só zera com sucesso", () => {
    const org = novaOrg();
    for (let i = 0; i < 3; i++) registrarFalha(org, "credencial_invalida", T0);
    const volta = T0 + 5 * MIN;
    registrarFalha(org, "credencial_invalida", volta);
    expect(podeTentar(org, volta + 1)).toBe(false);
  });

  it("sucesso zera a contagem", () => {
    const org = novaOrg();
    registrarFalha(org, "resposta_ilegivel", T0);
    registrarFalha(org, "resposta_ilegivel", T0);
    registrarSucesso(org);
    registrarFalha(org, "resposta_ilegivel", T0);
    registrarFalha(org, "resposta_ilegivel", T0);
    expect(podeTentar(org, T0)).toBe(true);
  });

  it("limite de taxa abre NA HORA, pelo tempo que o fornecedor pediu", () => {
    const org = novaOrg();
    registrarFalha(org, "limite_de_taxa", T0, 30_000);
    expect(podeTentar(org, T0 + 29_999)).toBe(false);
    expect(podeTentar(org, T0 + 30_000)).toBe(true);
  });

  it("sobrecarga sem retry-after espera 60 s", () => {
    const org = novaOrg();
    registrarFalha(org, "provedor_sobrecarregado", T0);
    expect(podeTentar(org, T0 + MIN - 1)).toBe(false);
    expect(podeTentar(org, T0 + MIN)).toBe(true);
  });

  it("retry-after absurdo não desliga o Jev pelo dia: teto de 10 minutos", () => {
    const org = novaOrg();
    registrarFalha(org, "limite_de_taxa", T0, 24 * 60 * MIN);
    expect(podeTentar(org, T0 + 10 * MIN)).toBe(true);
  });

  it("sem credencial não conta: é configuração, e nada saiu para a rede", () => {
    const org = novaOrg();
    for (let i = 0; i < 5; i++) registrarFalha(org, "sem_credencial", T0);
    expect(podeTentar(org, T0)).toBe(true);
  });

  it("organizações não se contaminam", () => {
    const a = novaOrg();
    const b = novaOrg();
    for (let i = 0; i < 3; i++) registrarFalha(a, "provedor_indisponivel", T0);
    expect(podeTentar(a, T0)).toBe(false);
    expect(podeTentar(b, T0)).toBe(true);
  });
});

/**
 * POR (ORGANIZAÇÃO, TAREFA) SÓ NA PERGUNTA RECUSADA: a API derruba a chamada
 * inteira por uma pergunta malformada, e a das outras tarefas está certa. Chave,
 * crédito, limite e queda são da CONTA e param toda tarefa.
 */
describe("disjuntor do Jev por tarefa", () => {
  const na = (organizationId: string, tarefa: string) => ({ organizationId, tarefa });

  it("pergunta recusada abre só a tarefa: a outra tarefa e o resto da organização seguem", () => {
    const org = novaOrg();
    for (let i = 0; i < 3; i++) registrarFalha(na(org, "roteador"), "contrato_invalido", T0);
    expect(podeTentar(na(org, "roteador"), T0)).toBe(false);
    expect(podeTentar(na(org, "clima"), T0)).toBe(true);
    expect(podeTentar(org, T0)).toBe(true);
  });

  it.each(["credencial_invalida", "sem_credito"] as const)(
    "%s numa tarefa abre a organização inteira",
    (motivo) => {
      const org = novaOrg();
      for (let i = 0; i < 3; i++) registrarFalha(na(org, "clima"), motivo, T0);
      expect(podeTentar(na(org, "roteador"), T0)).toBe(false);
      expect(podeTentar(org, T0)).toBe(false);
    },
  );

  it.each(["provedor_indisponivel", "resposta_ilegivel"] as const)(
    "%s é da tarefa: três só do roteador não cortam o clima nem a manipulação",
    (motivo) => {
      const org = novaOrg();
      for (let i = 0; i < 3; i++) registrarFalha(na(org, "roteador"), motivo, T0);
      expect(podeTentar(na(org, "roteador"), T0)).toBe(false);
      expect(podeTentar(na(org, "clima"), T0)).toBe(true);
      expect(podeTentar(na(org, "manipulacao"), T0)).toBe(true);
    },
  );

  /**
   * O roteador estoura o teto em todo turno, e a manipulação responde no mesmo
   * turno. Com a demora na conta da organização, o sucesso da manipulação a
   * zerava: medido, `podeTentar(roteador)` ficava `true` dez turnos seguidos.
   */
  it("o sucesso de outra tarefa não zera a demora do roteador: com as tarefas alternadas, o dele abre", () => {
    const org = novaOrg();
    for (let turno = 0; turno < 3; turno++) {
      registrarFalha(na(org, "roteador"), "provedor_indisponivel", T0);
      registrarSucesso(na(org, "manipulacao"));
    }
    expect(podeTentar(na(org, "roteador"), T0)).toBe(false);
    expect(podeTentar(na(org, "manipulacao"), T0)).toBe(true);
  });

  it("as falhas seguidas de uma tarefa somam as da conta e as dela, e o sucesso dela zera as duas", () => {
    const org = novaOrg();
    registrarFalha(na(org, "clima"), "provedor_indisponivel", T0);
    registrarFalha(na(org, "roteador"), "sem_credito", T0);
    expect(falhasSeguidas(na(org, "clima"))).toBe(2);
    expect(falhasSeguidas(na(org, "manipulacao"))).toBe(1);
    registrarSucesso(na(org, "clima"));
    expect(falhasSeguidas(na(org, "clima"))).toBe(0);
  });

  it("limite de taxa numa tarefa segura todas, na hora", () => {
    const org = novaOrg();
    registrarFalha(na(org, "clima"), "limite_de_taxa", T0, 30_000);
    expect(podeTentar(na(org, "manipulacao"), T0)).toBe(false);
  });

  it("o sucesso de uma tarefa não fecha o disjuntor da pergunta de outra", () => {
    const org = novaOrg();
    for (let i = 0; i < 3; i++) registrarFalha(na(org, "roteador"), "contrato_invalido", T0);
    registrarSucesso(na(org, "clima"));
    expect(podeTentar(na(org, "roteador"), T0)).toBe(false);
    registrarSucesso(na(org, "roteador"));
    expect(podeTentar(na(org, "roteador"), T0)).toBe(true);
  });

  it("quem chama só com a organização (a onda 1) segue no disjuntor dela para tudo", () => {
    const org = novaOrg();
    for (let i = 0; i < 3; i++) registrarFalha(org, "contrato_invalido", T0);
    expect(podeTentar(org, T0)).toBe(false);
    expect(podeTentar(na(org, "clima"), T0)).toBe(false);
  });
});
