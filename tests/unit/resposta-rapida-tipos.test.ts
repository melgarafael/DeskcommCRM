/**
 * A RÉGUA ÚNICA DA RESPOSTA RÁPIDA (#3009).
 *
 * A #3009 enumera SETE conteúdos — texto, imagem, áudio e as quatro combinações
 * — e cobra que a escolha seja "totalmente flexível": nenhum campo obrigatório,
 * e o operador pode cadastrar só um áudio, só uma imagem, ou uma mensagem com
 * texto e imagem. Até aqui o produto conhecia três deles: a tela tinha um MODO
 * (texto com mensagem obrigatória, ou áudio sozinho), e o tipo do recurso era um
 * booleano "tem áudio" repetido em cada leitor.
 *
 * Este arquivo prende a régua em si, longe do React: os sete tipos, as duas
 * recusas (sem conteúdo nenhum, mais de um áudio) e a leitura da linha gravada —
 * em que o tipo de cada mídia sai do CAMINHO do arquivo, nunca do `media_mime`
 * da linha, que é gravável pelo PostgREST.
 *
 * Quem lê a régua: a barra do Inbox (renderiza o botão), o envio
 * (`Composer.applyTemplate`, que recusa com motivo visível) e o cadastro
 * (`TemplateFormDialog`, que não deixa salvar vazio). Os três casos de tela
 * estão em `resposta-rapida-tipos-no-inbox.test.tsx`.
 */
import { describe, expect, it } from "vitest";

import {
  MOTIVO_RESPOSTA_RAPIDA_AUDIOS_DEMAIS,
  MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO,
  TIPOS_DE_RESPOSTA_RAPIDA,
  conteudoDaRespostaRapida,
  lerRespostaRapida,
  lerRespostaRapidaGravada,
} from "@/lib/inbox/resposta-rapida";

const ORG = "11111111-1111-4111-8111-111111111111";
const TPL = "22222222-2222-4222-8222-222222222222";
const caminho = (arquivo: string) => `${ORG}/templates/${TPL}/${arquivo}`;
const imagem = (n: number) => ({
  storage_path: caminho(`aaaaaaa${n}-0000-4000-8000-000000000000.jpg`),
  media_mime: "image/jpeg",
  media_size_bytes: 10,
});
const audio = (n: number) => ({
  storage_path: caminho(`bbbbbbb${n}-0000-4000-8000-000000000000.ogg`),
  media_mime: "audio/ogg",
  media_size_bytes: 10,
});

describe("os sete tipos de resposta rápida (#3009)", () => {
  it.each([
    ["texto", { texto: "Oi", imagens: 0, audios: 0 }, ["texto"]],
    ["imagem", { texto: "", imagens: 1, audios: 0 }, ["imagem"]],
    ["audio", { texto: "", imagens: 0, audios: 1 }, ["audio"]],
    ["texto+imagem", { texto: "Oi", imagens: 2, audios: 0 }, ["texto", "imagem"]],
    ["texto+audio", { texto: "Oi", imagens: 0, audios: 1 }, ["texto", "audio"]],
    ["imagem+audio", { texto: "", imagens: 1, audios: 1 }, ["imagem", "audio"]],
    [
      "texto+imagem+audio",
      { texto: "Oi", imagens: 1, audios: 1 },
      ["texto", "imagem", "audio"],
    ],
  ] as const)("%s é aceito e vira um discriminante", (tipo, conteudo, conteudos) => {
    const leitura = lerRespostaRapida(conteudo);
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.tipo).toBe(tipo);
    expect(leitura.conteudos).toEqual(conteudos);
    // O tipo é SEMPRE um dos sete — o vocabulário é fechado e o nome é a ordem
    // canônica, não a ordem em que o operador preencheu a tela.
    expect(TIPOS_DE_RESPOSTA_RAPIDA).toContain(leitura.tipo);
  });

  it("a ordem do nome é canônica: imagem+áudio não vira 'audio+imagem'", () => {
    const leitura = lerRespostaRapida({ texto: "", imagens: 3, audios: 1 });
    expect(leitura.ok && leitura.tipo).toBe("imagem+audio");
  });

  it("as contagens voltam como vieram — é delas que a tela tira os ícones", () => {
    const leitura = lerRespostaRapida({ texto: "Oi", imagens: 3, audios: 1 });
    expect(leitura).toMatchObject({ ok: true, texto: "Oi", imagens: 3, audios: 1 });
  });

  it("o texto volta como o operador escreveu, sem aparo da régua", () => {
    // Quem envia usa o corpo do jeito que está — a régua só decide se ele CONTA
    // como conteúdo (espaço em branco não conta).
    const leitura = lerRespostaRapida({ texto: "  Oi  ", imagens: 0, audios: 1 });
    expect(leitura.ok && leitura.texto).toBe("  Oi  ");
  });
});

describe("as duas recusas da régua", () => {
  it("sem conteúdo nenhum: motivo, não uma resposta vazia", () => {
    for (const conteudo of [
      { texto: "", imagens: 0, audios: 0 },
      { texto: "   \n\t ", imagens: 0, audios: 0 },
      { texto: null, imagens: 0, audios: 0 },
    ]) {
      expect(lerRespostaRapida(conteudo)).toEqual({
        ok: false,
        motivo: MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO,
      });
    }
  });

  it("texto em branco com mídia continua valendo (o branco não conta, a mídia conta)", () => {
    expect(lerRespostaRapida({ texto: "   ", imagens: 1, audios: 0 })).toMatchObject({
      ok: true,
      tipo: "imagem",
    });
  });

  it("mais de um áudio: recusado, porque dois áudios são uma fila e não um tipo", () => {
    expect(lerRespostaRapida({ texto: "", imagens: 0, audios: 2 })).toEqual({
      ok: false,
      motivo: MOTIVO_RESPOSTA_RAPIDA_AUDIOS_DEMAIS,
    });
    // Com texto ou imagem junto, a recusa é a mesma: o problema é o segundo
    // áudio, não o que veio acompanhando.
    expect(lerRespostaRapida({ texto: "Oi", imagens: 1, audios: 2 })).toEqual({
      ok: false,
      motivo: MOTIVO_RESPOSTA_RAPIDA_AUDIOS_DEMAIS,
    });
  });

  it("as contagens não podem ser negativas (nem viram tipo por acidente)", () => {
    const leitura = lerRespostaRapida({ texto: "", imagens: -1, audios: -1 });
    expect(leitura).toEqual({ ok: false, motivo: MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO });
  });
});

describe("a leitura da LINHA gravada", () => {
  it("`midias` ausente ou null é só texto — a linha anterior à 0643 chega assim", () => {
    expect(conteudoDaRespostaRapida({ body: "Oi" })).toEqual({
      texto: "Oi",
      imagens: 0,
      audios: 0,
    });
    expect(conteudoDaRespostaRapida({ body: "Oi", midias: null })).toEqual({
      texto: "Oi",
      imagens: 0,
      audios: 0,
    });
    expect(lerRespostaRapidaGravada({ body: "Oi" })).toMatchObject({ ok: true, tipo: "texto" });
  });

  it("o TIPO de cada mídia sai do caminho, não do `media_mime` da coluna", () => {
    // A coluna é gravável pelo PostgREST: um `.ogg` com mime mentiroso continua
    // sendo áudio, e um `.jpg` "declarado" áudio continua sendo imagem.
    expect(
      conteudoDaRespostaRapida({
        body: "Oi",
        midias: [{ ...audio(1), media_mime: "image/jpeg" }],
      }),
    ).toEqual({ texto: "Oi", imagens: 0, audios: 1 });
    expect(
      conteudoDaRespostaRapida({
        body: "Oi",
        midias: [{ ...imagem(1), media_mime: "audio/ogg" }],
      }),
    ).toEqual({ texto: "Oi", imagens: 1, audios: 0 });
  });

  it("uma linha com imagem E áudio lê como texto+imagem+audio", () => {
    const leitura = lerRespostaRapidaGravada({
      body: "Olha o áudio e a tabela",
      midias: [imagem(1), audio(1)],
    });
    expect(leitura).toMatchObject({
      ok: true,
      tipo: "texto+imagem+audio",
      imagens: 1,
      audios: 1,
    });
  });

  it("a resposta de áudio da #2833 (corpo vazio + 1 áudio) continua válida", () => {
    // O caso que o modo áudio criava: `body` vazio e uma entrada de áudio. Se a
    // régua passasse a exigir texto, todo recurso de áudio da base viraria
    // inválido — e o botão da barra pararia de funcionar.
    expect(lerRespostaRapidaGravada({ body: "", midias: [audio(1)] })).toMatchObject({
      ok: true,
      tipo: "audio",
      texto: "",
    });
  });
});
