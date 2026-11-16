/**
 * `send_message` com `imagem_url` manda a foto por URL PELA CADEIA `before_send`
 * (Spec 25 R4, a foto que vem de um resultado de ferramenta, ex.: receita do banco externo).
 *
 * A lógica de formato e de guarda de rede mora em `agent/imagem-por-url.ts` e é testada lá,
 * por comportamento. O `execute` do `send_message` é uma closure do turno sem ponto de
 * injeção barato (mesma técnica de `send-message-manda-foto-do-produto.test.ts`): este
 * arquivo prende a FIAÇÃO — a ordem da validação em relação à cadeia, a recusa de
 * `produto_codigo` + `imagem_url` com liberação da reserva, e o envio só de dentro do `send`
 * que o guardrail chama.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";

const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
const corpoDoSend = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();

describe("send_message aceita imagem_url", () => {
  it("o modelo enxerga imagem_url como campo opcional de URL", () => {
    const schema = AGENT_TOOL_DEFS.send_message.inputSchema;
    expect(schema.safeParse({ body: "oi" }).success).toBe(true);
    expect(schema.safeParse({ body: "oi", imagem_url: "https://exemplo.test/x.jpg" }).success).toBe(true);
    expect(schema.safeParse({ body: "oi", imagem_url: "não é url" }).success).toBe(false);
  });

  it("a descrição diz de onde a URL vem, o que acontece com outra e proíbe a combinação com produto_codigo", () => {
    const descricao = AGENT_TOOL_DEFS.send_message.inputSchema.shape.imagem_url.description ?? "";
    expect(descricao).toContain("deste turno");
    expect(descricao).toContain("outra URL não é buscada");
    expect(descricao).toContain("produto_codigo");
  });
});

describe("validação e guarda da foto por URL — antes da cadeia e nunca na prévia", () => {
  it("a recusa de produto_codigo + imagem_url existe e libera a reserva antes de devolver", () => {
    const i = corpoDoSend.indexOf("imagem_e_produto_juntos");
    expect(i).toBeGreaterThan(-1);
    const bloco = corpoDoSend.slice(corpoDoSend.indexOf("const temFotoDoCatalogo"), i);
    expect(bloco).toContain("dupTrava.liberar(body);");
  });

  it("o download e a guarda (baixarImagemSegura) rodam ANTES de runBeforeSend, e só fora da prévia", () => {
    const baixa = corpoDoSend.indexOf("baixarImagemSegura(url)");
    const cadeia = corpoDoSend.indexOf("runBeforeSend(beforeSendArgs)");
    expect(baixa).toBeGreaterThan(-1);
    expect(cadeia).toBeGreaterThan(-1);
    expect(baixa).toBeLessThan(cadeia);
    expect(corpoDoSend.slice(0, baixa)).toContain("temImagemPorUrl && !preview");
  });

  it("só busca URL que uma ferramenta de dados devolveu neste turno; a outra nem chega à rede", () => {
    expect(corpoDoSend).toContain("const baixada = procedenciaDeImagens.viu(url)\n              ? await baixarImagemSegura(url)");
    expect(corpoDoSend).toContain("motivo: 'url_fora_dos_resultados'");
  });

  it("o resultado das ferramentas de dados alimenta a procedência, com os argumentos da chamada", () => {
    const envolve = FONTE.indexOf("for (const nome of FERRAMENTAS_QUE_TRAZEM_IMAGEM)");
    expect(envolve).toBeGreaterThan(FONTE.indexOf("rawTools[name] = mcpTool;"));
    expect(envolve).toBeLessThan(FONTE.indexOf("applyPreviewPolicy("));
    expect(FONTE.slice(envolve, envolve + 600)).toContain("procedenciaDeImagens.registrar(resultado, args[0]);");
    // A procedência entra como argumento do `applyPreviewPolicy`, logo depois do
    // conferidor de fatos. O #4129 acrescentou um slot DEPOIS dela (o preparo do
    // material da empresa), então ela deixou de ser a última linha da chamada —
    // o que a asserção prende é a POSIÇÃO dela na cadeia, não o fim do arquivo.
    expect(FONTE).toContain("conferirAfirmacoes,\n            procedenciaDeImagens.viu,");
  });

  it("a foto é guardada na conversa com o tenant do turno antes de sair", () => {
    const baixa = corpoDoSend.indexOf("baixarImagemSegura(url)");
    const guarda = corpoDoSend.indexOf("guardarImagemNaConversa(createAdminClient(), {");
    expect(guarda).toBeGreaterThan(baixa);
    const chamada = corpoDoSend.slice(guarda, corpoDoSend.indexOf("});", guarda));
    expect(chamada).toContain("tenantId,");
    expect(chamada).toContain("conversationId: input.conversationId,");
    expect(corpoDoSend).toContain("fotosDoProduto = [{ kind: 'image', storagePath: guardada.storagePath, mime: guardada.mime }];");
  });

  it("a foto recusada não derruba o texto: o motivo é registrado e o envio segue só com texto", () => {
    expect(corpoDoSend).toContain("motivoFotoRecusada = motivo;");
    expect(corpoDoSend).toContain("runLog.warn('imagem_url recusada");
  });

  it("a recusa de duas fotos na mesma mensagem vem antes de qualquer preparo da foto do catálogo", () => {
    expect(corpoDoSend.indexOf("imagem_e_produto_juntos")).toBeLessThan(
      corpoDoSend.indexOf("prepararFotosDoProduto("),
    );
  });
});

describe("entrega — o canal recebe só storagePath, de DENTRO do send do guardrail", () => {
  it("enviar volta a receber só FotoParaEnvio (sem media por URL)", () => {
    expect(corpoDoSend).toContain("media?: FotoParaEnvio,");
    expect(corpoDoSend).toContain("...(media ? { media } : {}),");
    expect(corpoDoSend).not.toContain("paraMidiaDoCanal");
  });

  it("a foto sai de dentro do send (com o corpo que a cadeia aprovou) e obedece restantes()", () => {
    const send = corpoDoSend.slice(corpoDoSend.indexOf("send: (finalBody: string) =>"));
    // #4129 — a MESMA `enviarComFotos` do produto, com o material da empresa
    // como alternativa ÚNICA (as duas listas competem pela legenda): o anexo
    // escolhido continua saindo de dentro do `send`, nunca fora dele.
    expect(send).toContain("enviarComFotos(");
    expect(send).toContain("anexoDoMaterial !== null ? [anexoDoMaterial] : fotosDoProduto,");
    expect(send).toContain("restantes: () => maxSendsPerTurn - seq,");
  });

  it("registra se a foto saiu (OK_KINDS), não só que foi tentada", () => {
    expect(corpoDoSend).toContain("if (temImagemPorUrl && OK_KINDS.has(resultado.kind)) fotoUrlEnviada = true;");
  });
});

describe("rastro — o resultado do send_message diz se a foto saiu", () => {
  it("o sucesso devolve foto_enviada e, quando recusada, foto_recusada", () => {
    expect(corpoDoSend).toContain("...(temImagemPorUrl ? { foto_enviada: fotoUrlEnviada } : {}),");
    expect(corpoDoSend).toContain(
      "...(motivoFotoRecusada !== null ? { foto_recusada: motivoFotoRecusada } : {}),",
    );
  });
});
