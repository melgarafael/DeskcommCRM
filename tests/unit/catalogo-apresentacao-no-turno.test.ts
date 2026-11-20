/**
 * A ferramenta da apresentação no turno. Contrato de fonte, mesma técnica de
 * `correcao-do-turno-mudo-so-escala-com-falha.test.ts`: as duas decisões ficam no
 * meio do closure do turno, sem ponto de injeção barato.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const turno = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

describe("present_catalog_items no turno", () => {
  it("só é registrada depois de perguntar pela capacidade e pela apresentação ativa", () => {
    const registro = turno.indexOf("rawTools.present_catalog_items = tool({");
    expect(registro).toBeGreaterThan(-1);
    const guarda = turno.slice(turno.lastIndexOf("if (", registro), registro);
    expect(guarda).toContain("await apresentacaoOferecidaNoTurno(deps.crmCfg.supabase, pool, tenantId, runLog)");
  });

  it("a apresentação feita na correção do turno mudo encerra antes do desfecho de turno mudo", () => {
    const correcao = turno.indexOf("const correcao = await runModelCall(");
    const medida = turno.indexOf("correcaoTruncou = correcao.result.finishReason === 'length';");
    expect(correcao).toBeGreaterThan(-1);
    expect(medida).toBeGreaterThan(correcao);
    expect(turno.slice(correcao, medida)).toContain("if (apresentacaoEncerrouOTurno()) return;");
  });

  it("veto do gate não lança: devolve ao modelo, e o envio dele começa na seq vetada", () => {
    const veto = turno.indexOf("if (resumed.disposition === 'vetoed') {");
    const disposicao = turno.indexOf("disposicaoDaApresentacao = resumed.disposition;");
    expect(veto).toBeGreaterThan(-1);
    expect(disposicao).toBeGreaterThan(veto);
    const ramo = turno.slice(veto, disposicao);
    expect(ramo).toContain("seq = Math.max(seq, resumed.nextSeq - 1);");
    expect(ramo).toContain("vetoDaApresentacao = { code: resumed.code, message: resumed.message };");
    expect(ramo).toContain("return respostaAoVetoDaApresentacao(resumed.sent, vetoDaApresentacao);");
    expect(ramo).not.toContain("throw");
  });

  it("a chamada principal e a correção usam a mesma parada, composta com o envio final", () => {
    expect(turno.split("...paradaDoLaco,").length - 1).toBe(2);
    expect(turno).toContain("apresentacaoAcionada || (paradaAposEnvio?.(estado) ?? false)");
  });
});
