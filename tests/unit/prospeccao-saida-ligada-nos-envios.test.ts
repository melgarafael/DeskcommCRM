import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * CERCA DE LIGAÇÃO — a saída da prospecção só chega ao cliente se o `send` de
 * cada caminho de envio automático usa `enviarComSaidaConfiguravel`.
 *
 * Sabotagem obrigatória: remover/desviar essa chamada deixa este teste vermelho.
 */

const RAIZ = path.resolve(__dirname, "../..");

function fonte(rel: string): string {
  return fs.readFileSync(path.join(RAIZ, rel), "utf8");
}

describe("saída configurável ligada nos envios automáticos", () => {
  it("inbound-turn usa enviarComSaidaConfiguravel antes de enviarComFotos, com preview ? null", () => {
    const src = fonte("lib/agent-engine/agent/inbound-turn.ts");
    const inicio = src.indexOf("send_message: tool({");
    const fim = src.indexOf("update_lead_state: tool({");
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const trecho = src.slice(inicio, fim);
    expect(trecho).toContain("enviarComSaidaConfiguravel(");
    expect(trecho).toContain("return enviarComFotos(");
    expect(trecho.indexOf("enviarComSaidaConfiguravel(")).toBeLessThan(
      trecho.indexOf("return enviarComFotos("),
    );
    expect(trecho).toContain("preview ? null");
    // A intenção (job, seq da 1ª mensagem física) é o que faz a contagem valer
    // uma vez por mensagem: sem ela o reprocesso conta de novo.
    expect(trecho).toContain("mensagem: { jobId: preview ? \"\" : liveJob().id, seq: seq + 1 }");
  });

  it("followup-turn usa enviarComSaidaConfiguravel com modelo === undefined", () => {
    const src = fonte("lib/agent-engine/agent/followup-turn.ts");
    const idx = src.indexOf("enviarComSaidaConfiguravel(");
    expect(idx).toBeGreaterThan(-1);
    const trecho = src.slice(idx, idx + 900);
    expect(trecho).toContain("modelo === undefined ? conversationId : null");
    // A MESMA intenção do `channel.send` (seq: 1): o `queued` re-tenta o job.
    expect(trecho).toContain("mensagem: { jobId: job.id, seq: 1 }");
    expect(trecho).toContain("jobId: job.id, jobClaim: claimOfJob(job), seq: 1,");
  });

  it("saida-configuravel.ts: enviarComSaidaConfiguravel chama contarEnvioAutomatico, comSaida, desfazerContagem e audita", () => {
    const src = fonte("lib/prospecting/saida-configuravel.ts");
    const inicio = src.indexOf("export async function enviarComSaidaConfiguravel(");
    expect(inicio).toBeGreaterThan(-1);
    const corpo = src.slice(inicio);
    expect(corpo).toContain("contarEnvioAutomatico(");
    expect(corpo).toContain("comSaida(");
    expect(corpo).toContain("desfazerContagem(");
    expect(corpo).toContain('"prospecting.exit_offered"');
  });
});
