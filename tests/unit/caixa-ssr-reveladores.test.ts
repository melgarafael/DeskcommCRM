/**
 * A regra de "caixa órfã" da spec `buffer-ssr-caixa-orfa` (issue #1374), vigiada
 * no `verify`. Os scripts abaixo são o trecho do documento REAL servido para
 * `/app/settings/atendimento` sem JavaScript no run 36015154699 (PR #1600):
 * `S:0` drenada por `$RC`, `S:1` drenada por `$RS`. A primeira versão da sonda
 * só conhecia `$RC` e acusou `S:1` como órfã num documento correto.
 */
import { describe, expect, it } from "vitest";

import { caixasSemRevelador } from "../e2e/helpers/caixa-ssr";

const RS_MEDIDO = '$RS("S:1","P:1")';
const RC_MEDIDO = '$RC("B:0","S:0")';

describe("caixasSemRevelador", () => {
  it("o documento medido no CI não tem caixa órfã: $RC e $RS drenam", () => {
    expect(caixasSemRevelador(["S:0", "S:1"], [RS_MEDIDO, RC_MEDIDO])).toEqual([]);
  });

  it("sem o $RS, a caixa do segmento fica órfã", () => {
    expect(caixasSemRevelador(["S:0", "S:1"], [RC_MEDIDO])).toEqual(["S:1"]);
  });

  it("$RR (boundary com folhas de estilo) também drena", () => {
    expect(caixasSemRevelador(["S:2"], ['$RR("B:2","S:2",[["/_next/a.css","high"]])'])).toEqual([]);
  });

  it("S:1 não é confundida com S:10", () => {
    expect(caixasSemRevelador(["S:1", "S:10"], ['$RC("B:10","S:10")'])).toEqual(["S:1"]);
  });

  it("id citado fora de revelador não conta", () => {
    expect(caixasSemRevelador(["S:0"], ['self.__next_f.push([1,"\\"S:0\\""])'])).toEqual(["S:0"]);
  });
});
