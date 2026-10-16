/**
 * Saída truncada nunca vira mensagem parcial.
 *
 * O defeito que este gate cobre: o modelo bate no teto de tokens de saída
 * (`finish_reason === 'length'`) e o que produziu veio cortado. Três invariantes,
 * na ordem em que o código as garante:
 *
 *  1. O campo `finishReason` CHEGA ao consumidor nos DOIS ramos do seam — o
 *     `generateText` devolve sozinho, mas o ramo de assinatura (SIWC/streamText)
 *     monta o resultado À MÃO e sem repassar o campo a detecção ficaria cega
 *     exatamente no provedor de assinatura (o mesmo defeito da #2657, em outro
 *     campo: o cast escondia o que faltava).
 *  2. A detecção mora no ponto que CONSUME o resultado (`finishReason === 'length'`),
 *     com log distinto `output_truncated`.
 *  3. Truncamento que não se recupera (nada despachado depois da UMA correção do
 *     turno mudo) vira FALHA TERMINAL VISÍVEL: caso humano (`openCase`, gated por
 *     `agentConfig.casesEnabled`) com `kind: 'problema'` (TIPOS_DE_CASO) e
 *     blocker/summary em português simples, e log `output_truncated_recovered_failed`
 *     — nunca envio parcial, nunca retry além do limitado, nunca silêncio mudo.
 *     O MESMO bloco escala quando a correção TAMBÉM trunca (`correcaoTruncou`),
 *     e só com sinal de falha: silêncio deliberado autorizado pela correção não
 *     abre caso (ver o teste irmão correcao-do-turno-mudo-so-escala-com-falha.test.ts).
 *
 * Por que contrato de fonte (mesma técnica de send-message-corpo-vazio.test.ts):
 * o detect fica no meio do closure do turno, sem ponto de injeção barato; o que
 * dá pra prender com segurança é a estrutura — presença, ordem e as condições que
 * isentam as razões LEGÍTIMAS de silêncio (descartado/handoff/teto/veto).
 *
 * "Nunca parcial" é estrutural e é coberto aqui: texto fora de `send_message` não
 * sai, e argumento de tool cortado falha no schema zod (min(1)/safeParse) antes de
 * qualquer execução — ver as asserções de schema do fim do arquivo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const seam = ler("lib/agent-engine/edge/llm/run-model-call.ts");
const turno = ler("lib/agent-engine/agent/inbound-turn.ts");

describe("seam: finishReason chega nos dois ramos", () => {
  it("o tipo do seam EXIGE finishReason (tirar vira erro de tipo na hora)", () => {
    expect(seam).toMatch(
      /'text' \| 'usage' \| 'response' \| 'responseMessages' \| 'steps' \| 'toolCalls' \| 'finishReason'/,
    );
  });

  it("o ramo de assinatura captura streamed.finishReason no Promise.all e o repassa no resultado", () => {
    // Sem isto o campo FALTARIA no runtime só nesse ramo — a detecção cegaria
    // exatamente onde o resultado é montado à mão (lição da #2657).
    expect(seam).toMatch(/\[text, usage, response, steps, responseMessages, toolCalls, finishReason\] = await Promise\.all\(\[/);
    expect(seam).toMatch(/streamed\.finishReason,/);
    expect(seam).toMatch(/toolCalls,\s*\n\s*finishReason,\s*\n\s*\} satisfies ResultadoDoModeloDoSeam/);
  });
});

describe("turno: detecção, retry limitado e falha terminal visível", () => {
  it("detecta truncamento pelo finishReason === 'length' com log distinto", () => {
    expect(turno).toContain("const saidaTruncada = turn.result.finishReason === 'length';");
    expect(turno).toMatch(/runLog\.warn\('output_truncated — resposta do modelo cortada no teto de tokens'/);
  });

  it("a falha terminal exige truncamento SEM nenhuma mensagem despachada", () => {
    const i = turno.indexOf("output_truncated_recovered_failed");
    expect(i).toBeGreaterThan(-1);
    const bloco = turno.slice(i - 700, i);
    expect(bloco).toContain("saidaTruncada");
    expect(bloco).toContain("outcomes.length === 0");
    expect(bloco).toContain("seq === 0");
    expect(bloco).toContain("tentativasDeEnvio === 0");
  });

  it("isenta toda razão LEGÍTIMA de silêncio — só o trucamento sobra", () => {
    const i = turno.indexOf("output_truncated_recovered_failed");
    const bloco = turno.slice(i - 900, i);
    expect(bloco).toContain("!turnoDescartado");
    expect(bloco).toContain("!passouParaAEquipe");
    expect(bloco).toContain("!capDeEnvioAtingido()");
    // `tentativasDeEnvio === 0` cobre o caso do veto: o modelo CHAMOU e levou
    // veto → o veto é a razão (e já ensinou), não o trucamento.
    expect(bloco).toContain("tentativasDeEnvio === 0");
    // Preview nunca abre caso humano real.
    expect(bloco).toContain("!preview");
  });

  it("o desfecho terminal abre caso humano visível com causa própria", () => {
    // A condição única de escala vem logo acima do desfecho.
    expect(turno).toContain(
      "if (silencioSemRazaoLegitima && (saidaTruncada || correcaoTruncou)) {",
    );
    const i = turno.indexOf("output_truncated_recovered_failed");
    const bloco = turno.slice(i, i + 2600);
    expect(bloco).toContain("openCase(");
    // `kind` vem de TIPOS_DE_CASO ('problema') — senão a tela do time mostra "Outro".
    expect(bloco).toContain("kind: 'problema'");
    // blocker/summary são exibidos ao time ("Por que a IA travou"/"O que o
    // cliente precisa") — português simples, sem código de máquina neles.
    expect(bloco).not.toContain("saida_truncada");
    expect(bloco).not.toContain("finish_reason=length");
    expect(bloco).toContain("source: 'guardrail_autofallback'");
    // Falha do openCase também fica visível (não engole o erro).
    expect(turno).toContain("`${desfechoTerminal} — openCase lançou`");
  });

  it("o retry é a UMA correção do turno mudo — não há segundo loop de recuperação", () => {
    // O único retry é o bloco existente do turno mudo (UMA correção). O bloco
    // terminal não re-tenta envio: só registra e abre caso.
    const i = turno.indexOf("output_truncated_recovered_failed");
    const bloco = turno.slice(i, i + 1600);
    expect(bloco).not.toContain("runModelCall");
    expect(bloco).not.toContain("runBeforeSend");
  });
});

describe("nunca parcial: o schema barra corpo/argumento cortado antes de executar", () => {
  it("send_message exige corpo não-vazio (min(1)) — tool arg cortado nem executa", async () => {
    const { AGENT_TOOL_DEFS } = await import("@/lib/agent-engine/agent/inbound-turn");
    const corpo = AGENT_TOOL_DEFS.send_message.inputSchema.safeParse({ body: "" });
    expect(corpo.success).toBe(false);
    const ok = AGENT_TOOL_DEFS.send_message.inputSchema.safeParse({ body: "oi" });
    expect(ok.success).toBe(true);
    // O import de inbound-turn é pesado (pg/AI SDK/supabase no grafo) — timeout
    // folgado porque o boot do arquivo sob carga concorrente passa de 15s.
  }, 120000);
});
