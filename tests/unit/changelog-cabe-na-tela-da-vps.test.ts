import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { candidatasDoPr, medir } from "@/lib/release/cabe-na-tela";

/**
 * A seção mais nova do CHANGELOG é TELA DE PRODUTO, e ela tem um teto.
 *
 * O mecanismo — o `head -c` do `agent.sh`, o `awk` que para no cabeçalho da
 * versão instalada, as três réguas — mora em `lib/release/cabe-na-tela.ts`, com
 * a medição datada que o justifica (v1.4.0: 39.899 bytes contra teto de 30.000,
 * com os dois avisos de ação manual fora do corte). Aqui ficam só as asserções.
 *
 * ─── O QUE ESTE ARQUIVO COBRA, E DE QUEM ────────────────────────────────────
 *
 * Só o que o AUTOR DO PR pode consertar sozinho:
 *
 *   1. a seção numerada mais nova — o que já foi lançado (guarda retroativa);
 *   2. o `[Não lançado]` de agora — o que a PRÓXIMA release vai publicar.
 *
 * A terceira candidata — a seção que os fragmentos acumulados em `.changes/`
 * vão produzir — SAIU daqui, e a saída é o conserto, não uma lacuna. Ela media
 * o ACERVO do repositório, não o que o PR trouxe: medido em 20/09/2026, com 43
 * fragmentos acumulados, os PRs #1377 (@lucasa15) e #1363 ficaram vermelhos no
 * `verify` — status check OBRIGATÓRIO — por `A seção termina no byte 32686`,
 * sem que nenhum dos dois tocasse `.changes/`. A mensagem mandava o
 * contribuidor "enxugar o corpo dos fragmentos", trabalho que não é dele. E o
 * vermelho sumiu sozinho quando a release 1.41.0 consumiu os fragmentos, o que
 * termina de provar de quem era a dívida.
 *
 * Quem responde pelo vermelho tem de poder consertá-lo. O acúmulo é dívida da
 * casa e o remédio é cortar release — ato do mantenedor. Então a medição do
 * acervo continua existindo, com a mesma régua, e roda onde quem a vê pode
 * pagá-la: `pnpm release:acervo-cabe`, chamado pelo `ci.yml` fora de
 * `pull_request`. Que ela não some de lugar nenhum é cobrado em
 * `tests/unit/acervo-do-changelog-cobra-a-casa.test.ts`.
 *
 * CONSERTOS POSSÍVEIS quando este teste ficar vermelho, em ordem de preferência:
 *   1. enxugar a seção (quase sempre certo — item de changelog longo costuma ser
 *      explicação que só interessa a quem escreveu o código);
 *   2. mover `### ⚠️ Requer atenção` para logo depois do parágrafo de abertura —
 *      `findAttentionRange()` acha o bloco em qualquer posição da seção, então o
 *      aviso passa a sobreviver ao corte mesmo se o corpo for truncado.
 */

const RAIZ = process.cwd();
const RAW = fs.readFileSync(path.join(RAIZ, "CHANGELOG.md"), "utf8");
const AGENT_SH = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit", "agent.sh"), "utf8");

const CANDIDATAS = candidatasDoPr(RAW);

describe("o CHANGELOG da versão nova cabe no que a VPS recebe", () => {
  it("há o que medir — o arquivo tem ao menos uma seção candidata", () => {
    // Guarda de vacuidade: se o parser quebrar, os `it.each` abaixo somem e a
    // suíte fica verde por não haver caso — o modo de falha mais silencioso que
    // um gate tem. A seção numerada mais nova SEMPRE existe (o CHANGELOG tem
    // versões publicadas), então zero candidata aqui é defeito do parser.
    expect(CANDIDATAS.length, "nenhuma seção candidata: o parser desta medição quebrou").toBeGreaterThan(0);
  });

  it.each(CANDIDATAS)("$nome termina antes do corte do agente", (candidata) => {
    const m = medir(candidata, AGENT_SH);
    expect(
      m.fim,
      `A seção termina no byte ${m.fim}, além do corte de ${m.teto} bytes que o agent.sh aplica ` +
        `sobre o arquivo TAGUEADO. O dono da VPS receberia o texto cortado no meio. ${m.conserto}`,
    ).toBeLessThanOrEqual(m.teto);
  });

  it.each(CANDIDATAS)("$nome chega inteira ao app, do jeito que o agente a emite", (candidata) => {
    const m = medir(candidata, AGENT_SH);
    // Sem uma versão abaixo não há "instalada" a simular — é o primeiro corte
    // do repositório, e aí não existe ninguém para receber texto truncado.
    if (m.completa === null) return;

    expect(
      m.completa,
      `Quem está na versão de baixo recebe o texto cortado ANTES do cabeçalho da própria versão: ` +
        `a tela troca o histórico por "este histórico pode não alcançar a sua versão". ${m.conserto}`,
    ).toBe(true);
  });

  it.each(CANDIDATAS)("o aviso de ação manual de $nome sobrevive ao corte", (candidata) => {
    const m = medir(candidata, AGENT_SH);
    // Só cobra o que existe: versão sem ação manual não precisa do bloco.
    if (m.avisoSobrevive === null) return;

    expect(
      m.avisoSobrevive,
      `A seção tem "⚠️ Requer atenção", mas o bloco fica FORA dos ${m.teto} bytes que chegam à ` +
        `VPS — o aviso não apareceria para quem vai atualizar. ${m.conserto} Ou mova o bloco ` +
        `para logo depois do parágrafo de abertura.`,
    ).toBe(true);
  });
});
