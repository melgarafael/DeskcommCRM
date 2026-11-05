import { describe, expect, it } from "vitest";

import {
  frameMediaBody,
  falaDoClienteSemMoldura,
  MARCADOR_IMAGEM_NAO_VISTA,
} from "@/lib/agent-engine/edge/crm/moldura-de-midia";
import { montarBriefingDaPassagem } from "@/lib/escalacao/briefing-da-passagem";

/**
 * A MOLDURA DA MÍDIA NÃO CHEGA A QUEM LÊ.
 *
 * O turno entrega ao modelo a transcrição de um áudio embrulhada numa instrução
 * ("NUNCA responda que não consegue ver/ouvir mídia…"). As mesmas falas
 * pendentes viram "Últimas palavras do cliente" no cartão da passagem — e o
 * atendente lia a instrução do sistema entre aspas, como se o cliente a tivesse
 * dito. Relatado numa instalação real: a última mensagem era um áudio, e o cartão
 * mostrava "[Mídia do cliente: ele enviou um áudio e o sistema já processou…]".
 *
 * Os casos de ida e volta usam o `frameMediaBody` de verdade: se alguém mudar a
 * moldura sem mudar o desembrulho, eles ficam vermelhos.
 */
const INSTRUCAO = "NUNCA responda";

describe("falaDoClienteSemMoldura", () => {
  it("áudio: fica a transcrição, que é a fala do cliente", () => {
    const corpo = frameMediaBody("audio", null, "Eu fui eliminado no concurso");
    expect(falaDoClienteSemMoldura(corpo)).toBe("[áudio] Eu fui eliminado no concurso");
  });

  it("áudio com transcrição de várias linhas: nada se perde", () => {
    const corpo = frameMediaBody("audio", null, "primeira parte\nsegunda parte");
    expect(falaDoClienteSemMoldura(corpo)).toBe("[áudio] primeira parte\nsegunda parte");
  });

  it("imagem: fica a legenda do cliente, não a descrição feita pela IA", () => {
    const corpo = frameMediaBody("image", "segue o print", "Captura de tela de um edital com a nota 6,5");
    expect(falaDoClienteSemMoldura(corpo)).toBe("[imagem] segue o print");
  });

  it("documento sem legenda: só o rótulo", () => {
    const corpo = frameMediaBody("document", null, "Texto extraído do PDF: nome, CPF, endereço");
    expect(falaDoClienteSemMoldura(corpo)).toBe("[documento]");
  });

  it("moldura cortada ao meio pelo orçamento de contexto: rótulo, nunca a instrução", () => {
    const corpo = frameMediaBody("audio", null, "Eu fui eliminado no concurso");
    const cortado = corpo.slice(0, Math.floor(corpo.length / 3));
    const fala = falaDoClienteSemMoldura(cortado);
    expect(fala).toBe("[áudio]");
    expect(fala).not.toContain(INSTRUCAO);
  });

  it("foto para o agente que não vê imagens: o rótulo é [imagem], com a legenda dele", () => {
    // O motor escreve a legenda depois do marcador (`corpoDaMensagem`, get-lead-context.ts).
    expect(falaDoClienteSemMoldura(`${MARCADOR_IMAGEM_NAO_VISTA}\nLegenda do cliente: x`)).toBe("[imagem] x");
    expect(falaDoClienteSemMoldura(MARCADOR_IMAGEM_NAO_VISTA)).toBe("[imagem]");
  });

  it("texto que não é mídia passa intacto, inclusive o que fala de mídia", () => {
    expect(falaDoClienteSemMoldura("quero falar com uma pessoa")).toBe("quero falar com uma pessoa");
    expect(falaDoClienteSemMoldura("Conteúdo: o áudio não abriu")).toBe("Conteúdo: o áudio não abriu");
  });
});

describe("cartão da passagem com áudio como última mensagem", () => {
  const briefing = montarBriefingDaPassagem({
    checkpoint: null,
    pendentesDoCliente: [frameMediaBody("audio", null, "Eu fui eliminado no concurso")],
    motivo: { codigo: "critical_stage", texto: "Triagem concluída" },
  });

  it("'Últimas palavras do cliente' mostra a transcrição, sem a instrução ao modelo", () => {
    expect(briefing.notes).toBe("[áudio] Eu fui eliminado no concurso");
  });

  it("o resumo que vai para a Central também não leva a instrução", () => {
    expect(briefing.body).toContain('"[áudio] Eu fui eliminado no concurso"');
    expect(briefing.body).not.toContain(INSTRUCAO);
    expect(briefing.body).not.toContain("[Mídia do cliente:");
  });
});
