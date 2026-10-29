/**
 * RESPOSTA EM ÁUDIO — a FIAÇÃO entre o turno, o sink de envio e o handler.
 *
 * A decisão e o fallback são testados por comportamento em
 * `resposta-em-audio.test.ts`. Aqui fica o que só se prova pela forma:
 *
 *  - o sink manda a nota de voz como `type: "audio"` com o texto no `body`
 *    (o texto fica no CRM) — por comportamento, em `corpoDoEnvio`;
 *  - o handler NÃO manda esse `body` como legenda do áudio;
 *  - no turno, o áudio sai de DENTRO do `send` do guardrail (por fora, pularia
 *    opt-out, LGPD e o ritmo anti-ban), só com a opção do agente ligada, só em
 *    turno de resposta e nunca no preview;
 *  - a opção do agente é `false` por padrão e o PATCH grava só ela.
 *
 * Mesma técnica de `send-message-manda-foto-do-produto.test.ts`: o `execute` do
 * `send_message` é uma closure do turno sem ponto de injeção barato.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { corpoDoEnvio } from "@/lib/agent-engine/edge/crm/send-message";
import { AGENT_CONFIG_DEFAULTS, agentConfigPatchSchema } from "@/lib/ai/guardrails-schema";
import { sendMessageSchema } from "@/lib/schemas/messaging";

const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const base = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  leadId: "00000000-0000-4000-8000-000000000002",
  jobId: "00000000-0000-4000-8000-000000000003",
  seq: 1,
  conversationId: "00000000-0000-4000-8000-000000000004",
};

describe("sink de envio — a nota de voz leva o texto no body", () => {
  it("storagePath com type audio vira type audio, com o body preservado", () => {
    const corpo = corpoDoEnvio(
      {
        ...base,
        body: "Olá, seu processo está em andamento.",
        media: {
          storagePath: `${base.tenantId}/${base.conversationId}/voz-ia-${base.jobId}-1.ogg`,
          mime: "audio/ogg;codecs=opus",
          type: "audio",
        },
      },
      "chave",
    );
    expect(corpo).toMatchObject({
      type: "audio",
      body: "Olá, seu processo está em andamento.",
      media_storage_path: `${base.tenantId}/${base.conversationId}/voz-ia-${base.jobId}-1.ogg`,
      media_mime: "audio/ogg;codecs=opus",
    });
    expect(sendMessageSchema.safeParse(corpo).success).toBe(true);
  });

  it("sem type, o arquivo do Storage continua sendo imagem (foto de produto)", () => {
    const corpo = corpoDoEnvio(
      { ...base, body: "", media: { storagePath: "a/b/c.jpg", mime: "image/jpeg" } },
      "chave",
    );
    expect(corpo).toMatchObject({ type: "image", media_storage_path: "a/b/c.jpg" });
  });
});

describe("handler — o áudio não leva legenda", () => {
  it("a legenda do envio por Storage é nula para áudio", () => {
    const fonte = ler("app/api/v1/messages/_handler.ts");
    expect(fonte).toContain('caption: input.type === "audio" ? null : corpoDoCanal(input.body ?? null),');
  });
});

describe("turno — o áudio sai pela cadeia, só quando pedido", () => {
  const fonte = ler("lib/agent-engine/agent/inbound-turn.ts");
  const corpoDoSend = (() => {
    const i = fonte.indexOf("send_message: tool({");
    const j = fonte.indexOf("update_lead_state: tool({", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return fonte.slice(i, j);
  })();

  it("enviarComoAudio mora dentro do `send` do guardrail, com o corpo aprovado", () => {
    const send = corpoDoSend.slice(corpoDoSend.indexOf("send: (finalBody: string) =>"));
    const fim = send.indexOf("let chain = await runBeforeSend(beforeSendArgs)");
    const dentro = send.slice(0, fim);
    expect(dentro).toContain("return enviarComoAudio(finalBody, {");
    expect(dentro).toContain("enviar(finalBody, { storagePath: caminho, mime: MIME_DA_VOZ, type: 'audio' })");
    // Com foto de produto, o caminho é o de sempre.
    expect(dentro).toContain("if (vozDoTurno !== null && fotosDoProduto.length === 0) {");
  });

  it("a decisão exige a opção do agente, turno de resposta, e não roda no preview", () => {
    const i = fonte.indexOf("const vozDoTurno: VozDoTurno | null =");
    expect(i).toBeGreaterThan(-1);
    const decisao = fonte.slice(i, fonte.indexOf(": null;", i));
    expect(decisao).toContain("!preview");
    expect(decisao).toContain("agentConfig?.respostaEmAudio === true");
    expect(decisao).toContain("eTurnoDeResposta(liveJob())");
    expect(decisao).toContain("preferenciaDeAudio(openingContext.context.messages)");
    // A voz vem da ORGANIZAÇÃO do job, com a voz escolhida no agente.
    expect(decisao).toContain("await vozDaOrganizacao({");
    expect(decisao).toContain("organizationId: tenantId,");
    expect(decisao).toContain("vozDoAgente: agentConfig?.vozDaRespostaEmAudio ?? null,");
  });

  it("o modelo recebe a instrução de áudio no lugar da de bolhas", () => {
    expect(fonte).toContain("vozDoTurno !== null ? INSTRUCAO_DE_AUDIO : instrucaoDeBolhas(");
  });
});

describe("config do agente — resposta_em_audio", () => {
  it("nasce desligada", () => {
    expect(AGENT_CONFIG_DEFAULTS.resposta_em_audio).toBe(false);
  });

  it("o PATCH grava só a chave enviada", () => {
    expect(agentConfigPatchSchema.parse({ resposta_em_audio: true })).toEqual({ resposta_em_audio: true });
    expect(agentConfigPatchSchema.safeParse({ resposta_em_audio: "sim" }).success).toBe(false);
  });

  it("a tela do agente monta o cartão", () => {
    const form = ler("app/app/ai/agents/[id]/_components/AgentForm.tsx");
    expect(form).toContain("<RespostaEmAudio");
    expect(form).toContain("(props.agent.config ?? {}).resposta_em_audio");
    expect(form).toContain("vozInicial={(props.agent.config ?? {}).voz_da_resposta_em_audio}");
  });

  it("a voz nasce sem escolha (padrão da instalação)", () => {
    expect(AGENT_CONFIG_DEFAULTS.voz_da_resposta_em_audio).toBeNull();
  });

  it("o painel de Provedores monta o cartão de voz, e Credenciais esconde a chave de voz", () => {
    expect(ler("app/app/ai/providers/_components/PainelDeProvedores.tsx")).toContain("<CartaoDeVoz />");
    expect(ler("app/app/ai/credentials/page.tsx")).toContain("c.provider !== PROVEDOR_DA_VOZ");
  });
});
