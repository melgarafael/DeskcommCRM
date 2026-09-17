import { describe, expect, it } from "vitest";

import { ancoraAoFecharPainel } from "@/lib/agenda/ancora-depois-de-marcar";

/**
 * ⚠️ O relato que puxou este arquivo ("fiz um agendamento que não aparece ao
 * sair da agenda", 2026-09-12) **NÃO se confirmou** — o compromisso aparecia nas
 * três visões. Está escrito aqui e no módulo porque prova que caiu não sustenta
 * código, e quem ler depois merece saber disso antes de confiar.
 *
 * O que sustenta é a simetria com um defeito JÁ relatado e já documentado no
 * produto: o comentário do botão "Ver na agenda" descreve o caso (um compromisso
 * de 8 de setembro, marcado da semana corrente) e conserta só o caminho do
 * botão. Fechar no X, clicar fora ou apertar Esc continuava sem levar a grade.
 */

/** `startOfDay` de mentira, e é de propósito: a regra não pode depender de fuso. */
const inicioDoDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

describe("para onde a grade vai quando o painel de marcação fecha", () => {
  it("⛔ leva até o dia do compromisso recém-marcado", () => {
    const destino = ancoraAoFecharPainel("2026-09-24T11:30:00.000Z", inicioDoDia);
    expect(destino).not.toBeNull();
    expect(destino?.getDate()).toBe(24);
    expect(destino?.getMonth()).toBe(8); // setembro
  });

  it("⛔ NÃO mexe na grade de quem só abriu e desistiu", () => {
    // O caso degenerado, e o que decide o desenho: mover a âncora sempre que o
    // painel fecha teleporta quem abriu, olhou e fechou — para o dia de um
    // compromisso que ele não criou. É o caminho MAIS comum dos dois.
    expect(ancoraAoFecharPainel(null, inicioDoDia)).toBeNull();
    expect(ancoraAoFecharPainel(undefined, inicioDoDia)).toBeNull();
    expect(ancoraAoFecharPainel("", inicioDoDia)).toBeNull();
  });

  it("data ilegível não teleporta para lugar nenhum", () => {
    // Não mexer é sempre recuperável; ancorar em `Invalid Date` deixa a grade
    // em branco sem uma linha de explicação.
    expect(ancoraAoFecharPainel("nao é data", inicioDoDia)).toBeNull();
  });

  it("devolve o DIA, com a hora zerada — a âncora é o dia da visão", () => {
    // Mandar o instante exato funciona por acidente na visão de semana e escolhe
    // a hora errada na de dia. É a mesma razão escrita no `onVerNaAgenda`.
    const destino = ancoraAoFecharPainel("2026-09-24T23:45:00.000Z", inicioDoDia);
    expect(destino?.getHours()).toBe(0);
    expect(destino?.getMinutes()).toBe(0);
  });

  it("CONTROLE: usa a função de data que recebe, não uma de dentro", () => {
    // Guarda de vacuidade com dentes: se a implementação ignorasse o parâmetro e
    // chamasse um `startOfDay` importado, este caso não teria como notar — então
    // o marcador é uma data IMPOSSÍVEL de produzir por acaso.
    const marcador = new Date(1999, 0, 1);
    expect(ancoraAoFecharPainel("2026-09-24T11:30:00.000Z", () => marcador)).toBe(marcador);
  });
});
