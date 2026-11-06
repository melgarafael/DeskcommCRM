/**
 * O DIÁLOGO PEDE LEGENDA SÓ ONDE A LEGENDA CHEGA (#3151).
 *
 * O defeito medido na main: o campo "Legenda" aparecia SEMPRE, mas os
 * adaptadores de canal em `lib/channels/` mandam a nota de
 * voz sem `caption`. O atendente escrevia um texto que nunca chegava.
 *
 * O que cada caso prova, e por que nesta forma:
 *
 *   ⭐ ÁUDIO — com fila só de áudio o campo NÃO é renderizado e o envio não leva
 *      texto nenhum. É o alvo da issue.
 *   CONTROLE imagem, vídeo e documento — o campo continua e a legenda digitada
 *      chega ao `onSend`: é o comportamento que NÃO podia mudar, porque esses
 *      três tipos levam `caption` nos canais.
 *   CONTROLE fila MISTA (imagem + áudio) — o campo continua, com a legenda da
 *      resposta rápida, e ela chega ao `onSend`. Esconder o campo aqui seria
 *      perder o texto que o operador já tinha; a legenda sai com a imagem, que
 *      é o anexo que a leva.
 *
 * A régua pura (`anexoLevaLegenda`/`indiceDaLegenda`) também é medida aqui: é
 * ela que o envio do compositor usa para escolher COM QUAL anexo da fila a
 * legenda viaja — uma fila [áudio, imagem] leva o texto na imagem, não no
 * índice 0.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { AttachmentPreviewDialog } from "./AttachmentPreviewDialog";
import { anexoLevaLegenda, indiceDaLegenda } from "@/components/inbox/media/legenda-do-anexo";

const arquivo = (nome: string, tipo: string) =>
  new File([new Uint8Array([1, 2, 3])], nome, { type: tipo });

const AUDIO = arquivo("recado.ogg", "audio/ogg");
const IMAGEM = arquivo("tabela.jpg", "image/jpeg");
const VIDEO = arquivo("tour.mp4", "video/mp4");
const DOCUMENTO = arquivo("contrato.pdf", "application/pdf");

/** CAMPOS_QUE_LEVAM: os três tipos que o canal entrega COM legenda. */
const CAMPOS_QUE_LEVAM: [string, File][] = [
  ["imagem", IMAGEM],
  ["vídeo", VIDEO],
  ["documento", DOCUMENTO],
];

function montar(files: File[], legendaInicial: string | null = null, notaInterna = false) {
  const onSend = vi.fn();
  render(
    <AttachmentPreviewDialog
      files={files}
      legendaInicial={legendaInicial}
      notaInterna={notaInterna}
      sending={false}
      onCancel={vi.fn()}
      onSend={onSend}
    />,
  );
  return { onSend, enviar: () => fireEvent.click(screen.getByRole("button", { name: "Enviar" })) };
}

describe("o diálogo pede legenda só onde ela chega (#3151)", () => {
  it("⭐ anexo de ÁUDIO: o campo de legenda não é renderizado", () => {
    montar([AUDIO]);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByLabelText("Legenda")).toBeNull();
    expect(screen.queryByPlaceholderText("Legenda (opcional)")).toBeNull();
  });

  it("⭐ áudio com a legenda inicial do recurso: o envio NÃO leva texto", () => {
    // O caminho do recurso/resposta rápida de áudio — que é onde o corpo do
    // template virava "legenda". O texto não sai com o áudio (o canal o
    // descarta); quem o devolve ao campo é o compositor.
    const { onSend, enviar } = montar([AUDIO], "Segue o áudio do preço");

    enviar();

    expect(onSend).toHaveBeenCalledWith("");
  });

  it.each(CAMPOS_QUE_LEVAM)(
    "CONTROLE: %s mantém o campo e a legenda digitada chega ao onSend",
    (_tipo, file) => {
      const { onSend, enviar } = montar([file]);

      fireEvent.change(screen.getByLabelText("Legenda"), { target: { value: "  Olha isso  " } });
      enviar();

      expect(onSend).toHaveBeenCalledWith("Olha isso");
    },
  );

  it("CONTROLE: fila MISTA (imagem + áudio) mantém o campo e a legenda inicial", () => {
    const { onSend, enviar } = montar([IMAGEM, AUDIO], "Olha a tabela");

    expect(screen.getByLabelText("Legenda")).toHaveValue("Olha a tabela");
    enviar();

    expect(onSend).toHaveBeenCalledWith("Olha a tabela");
  });

  it("CONTROLE: fila MISTA com o ÁUDIO na frente também mantém o campo", () => {
    // A capa é o áudio, mas a imagem da fila leva a legenda: o campo não pode
    // sumir só porque a CAPA não a leva.
    const { onSend, enviar } = montar([AUDIO, IMAGEM], "Olha a tabela");

    expect(screen.getByLabelText("Legenda")).toHaveValue("Olha a tabela");
    enviar();

    expect(onSend).toHaveBeenCalledWith("Olha a tabela");
  });

  it("CONTROLE: NOTA INTERNA com áudio mantém o campo — o texto é o corpo da nota", () => {
    // A nota não sai pelo canal: o corpo aparece ao lado do áudio no card da
    // nota. Esconder o campo aqui tiraria o texto da nota, não um texto morto.
    const { onSend, enviar } = montar([AUDIO], null, true);

    fireEvent.change(screen.getByLabelText("Legenda"), { target: { value: " Ouvir antes de ligar " } });
    enviar();

    expect(onSend).toHaveBeenCalledWith("Ouvir antes de ligar");
  });
});

describe("a régua pura do envio (#3151)", () => {
  it("anexoLevaLegenda: áudio não leva; imagem, vídeo e documento levam", () => {
    expect(anexoLevaLegenda(AUDIO)).toBe(false);
    expect(anexoLevaLegenda(IMAGEM)).toBe(true);
    expect(anexoLevaLegenda(VIDEO)).toBe(true);
    expect(anexoLevaLegenda(DOCUMENTO)).toBe(true);
  });

  it("indiceDaLegenda: o PRIMEIRO que a aceita — e `-1` quando nenhum aceita", () => {
    expect(indiceDaLegenda([IMAGEM, AUDIO])).toBe(0);
    expect(indiceDaLegenda([AUDIO, IMAGEM])).toBe(1);
    expect(indiceDaLegenda([AUDIO, AUDIO])).toBe(-1);
    expect(indiceDaLegenda([])).toBe(-1);
  });
});
