/**
 * A ÂNCORA DA AGENDA NASCE DO RELÓGIO DA ORGANIZAÇÃO — dos dois lados.
 *
 * Decisão do dono do produto (2026-09-20, #1350): *"Seria da organização com
 * divisão entre pessoas. Uma organização pode por exemplo ter 5 pessoas/agendas
 * diferentes."* A divisão entre pessoas é sobre DE QUEM é cada compromisso
 * dentro da semana comum — filtro e trilha de cor —, não sobre fuso.
 *
 * A condição que não pode falhar, e é o que este arquivo vigia: **servidor e
 * cliente leem a MESMA fonte**. Se o servidor resolver pela organização e o
 * cliente seguir com `new Date()` do navegador, a divergência volta inteira — e
 * aí para todo usuário fora do fuso da organização, não só na janela de sábado
 * que abriu a issue.
 *
 * Por que uma cerca de FONTE e não um teste de comportamento: o defeito não
 * aparece na máquina de quem escreve (navegador e servidor no mesmo fuso), e a
 * janela em que ele aparece em produção é de três horas por semana. Uma cerca
 * que lê o código reprova no minuto em que alguém escrever `new Date()` ali de
 * novo — que é como isto voltaria.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CLIENTE = "app/app/agenda/_client.tsx";
const SERVIDOR = "app/app/agenda/page.tsx";

const semProsa = (caminho: string) =>
  readFileSync(caminho, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/.*$/gm, "");

describe("a âncora da agenda", () => {
  it("no CLIENTE, não nasce nem volta ao relógio do navegador", () => {
    const fonte = semProsa(CLIENTE);

    expect(
      /useState\(\(\)\s*=>\s*new Date\(\)\)/.test(fonte),
      "a âncora voltou a nascer de `new Date()` — é o relógio do NAVEGADOR, e o " +
        "servidor desenha no da organização. Use `ancoraLocalDoDia(hojeNaOrganizacao)`.",
    ).toBe(false);

    expect(
      /setAncora\(\s*new Date\(\)\s*\)/.test(fonte),
      'o botão "Hoje" voltou a usar o relógio do navegador: ele desfaz a âncora do ' +
        "servidor a um clique, e o defeito volta sem passar por nenhum outro teste.",
    ).toBe(false);

    expect(
      fonte.includes("ancoraLocalDoDia(hojeNaOrganizacao)"),
      "o cliente não ancora mais na data que o servidor resolveu",
    ).toBe(true);
  });

  it("no SERVIDOR, a semana sai do fuso da ORGANIZAÇÃO e a data viaja como prop", () => {
    const fonte = semProsa(SERVIDOR);

    expect(
      /fusoUtilizavel\(\s*activeOrg\.timezone\s*\)/.test(fonte),
      "a semente da semana deixou de sair de `organizations.timezone`",
    ).toBe(true);

    // ⚠️ `user.timezone` como degrau de cima traz de volta a divergência: o
    // servidor não conhece o fuso do NAVEGADOR de quem abre, então qualquer
    // degrau dependente da pessoa vira palpite no primeiro render.
    expect(
      /fusoUtilizavel\([^)]*fusoDeApresentacao/.test(fonte),
      "o fuso da PESSOA voltou a decidir a semana — a decisão do dono é que o " +
        "relógio é da organização (#1350)",
    ).toBe(false);

    expect(
      fonte.includes("hojeNaOrganizacao={hojeNaOrganizacao}"),
      "a data resolvida parou de viajar ao cliente — sem ela ele recalcula sozinho",
    ).toBe(true);
  });

  it("a varredura ENCONTRA os dois arquivos — regex quebrado passaria por vacuidade", () => {
    expect(semProsa(CLIENTE)).toMatch(/setAncora/);
    expect(semProsa(SERVIDOR)).toMatch(/semanaSemente\(/);
  });
});
