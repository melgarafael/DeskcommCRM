/**
 * O DISJUNTOR para de bater num fornecedor que não responde — e volta sozinho.
 *
 * O relógio é injetado (`agora`) em vez de falsificado: o que se prova é a
 * regra, e cada caso usa uma organização própria porque o estado é do processo.
 */
import { describe, expect, it } from "vitest";

import { podeTentar, registrarFalha, registrarSucesso } from "@/lib/ai/decisao/disjuntor";

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
