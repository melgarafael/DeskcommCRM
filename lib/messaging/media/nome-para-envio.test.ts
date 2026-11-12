/**
 * O nome que o destinatário vê no documento enviado pela API (#4524).
 *
 * Antes: o ramo de `media_url` mandava `media` sem `filename`, e o adaptador gravava
 * o literal `file`. Medido no `_handler.ts:1352` de antes deste PR. O caso
 * "chega com o nome original" abaixo é o REPRO da issue; os de borda existem
 * porque o nome vem de fora — inclusive de uma URL de terceiro.
 */
import { describe, expect, it } from "vitest";

import { NOME_DE_ARQUIVO_MAX } from "@/lib/messaging/media/nome-de-arquivo";
import {
  nomeDeArquivoSeguro,
  nomeDeReserva,
  nomeDoDocumentoParaEnvio,
  temExtensao,
  ultimoSegmentoDoCaminho,
} from "@/lib/messaging/media/nome-para-envio";

const URL_DO_EXEMPLO = "https://armazenamento.exemplo/whatsapp-media/9f2c1a7b3d.pdf";

describe("nomeDoDocumentoParaEnvio — de onde sai o nome", () => {
  it("o campo novo `media_filename` vence os outros dois candidatos", () => {
    expect(
      nomeDoDocumentoParaEnvio({
        nomeExplicito: "Contrato assinado.pdf",
        metadata: { media_filename: "Da metadata.pdf" },
        url: "https://armazenamento.exemplo/Da-url.pdf",
        mime: "application/pdf",
      }),
    ).toBe("Contrato assinado.pdf");
  });

  it("CASO DA ISSUE: só `metadata.media_filename` já chega com o nome original", () => {
    // Este é o corpo exato da #4524. Antes do conserto ele saía como `file`.
    expect(
      nomeDoDocumentoParaEnvio({
        metadata: { media_filename: "Diagnostico-Clinica-Exemplo.pdf" },
        url: URL_DO_EXEMPLO,
        mime: "application/pdf",
      }),
    ).toBe("Diagnostico-Clinica-Exemplo.pdf");
  });

  it("sem nome nenhum, o último segmento da URL com extensão serve", () => {
    expect(nomeDoDocumentoParaEnvio({ url: URL_DO_EXEMPLO, mime: "application/pdf" })).toBe(
      "9f2c1a7b3d.pdf",
    );
  });

  it("URL com nome de verdade e espaço escapado: decodifica em vez de mostrar `%20`", () => {
    expect(
      nomeDoDocumentoParaEnvio({
        url: "https://armazenamento.exemplo/Laudo%20Final%20v2.pdf",
        mime: "application/pdf",
      }),
    ).toBe("Laudo Final v2.pdf");
  });

  it("último segmento SEM extensão não vira nome: cai na reserva do MIME", () => {
    expect(
      nomeDoDocumentoParaEnvio({
        url: "https://armazenamento.exemplo/9f2c1a7b3d",
        mime: "application/pdf",
      }),
    ).toBe("documento.pdf");
  });

  it("sem MIME conhecido a reserva ainda é legível — nunca o literal `file`", () => {
    const nome = nomeDoDocumentoParaEnvio({ url: "https://armazenamento.exemplo/x" });
    expect(nome).toBe("documento");
    expect(nome.toLowerCase()).not.toBe("file");
  });

  it("URL terminando em `file` (o defeito) não devolve `file`", () => {
    expect(
      nomeDoDocumentoParaEnvio({
        url: "https://armazenamento.exemplo/file",
        mime: "application/pdf",
      }),
    ).toBe("documento.pdf");
  });

  it("`media_filename` literal `file` explícito também não passa — é o sintoma voltando", () => {
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "file", mime: "application/pdf" })).toBe(
      "documento.pdf",
    );
  });
});

describe("nomeDoDocumentoParaEnvio — bordas que não podem virar 500", () => {
  it("nome vazio cai para o próximo candidato, não para o erro", () => {
    expect(
      nomeDoDocumentoParaEnvio({
        nomeExplicito: "",
        metadata: { media_filename: "  " },
        url: URL_DO_EXEMPLO,
      }),
    ).toBe("9f2c1a7b3d.pdf");
  });

  it("nome VAZIO em todos os candidatos termina na reserva legível", () => {
    expect(
      nomeDoDocumentoParaEnvio({
        nomeExplicito: "   ",
        metadata: { media_filename: "" },
        url: "https://armazenamento.exemplo/",
        mime: "image/png",
      }),
    ).toBe("imagem.png");
  });

  it("nome só de barras é recusado e não vira nome de arquivo", () => {
    expect(nomeDeArquivoSeguro("///")).toBeNull();
    expect(nomeDeArquivoSeguro("\\\\\\")).toBeNull();
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "///", mime: "application/pdf" })).toBe(
      "documento.pdf",
    );
  });

  it("nome gigante é cortado no teto PRESERVANDO a extensão", () => {
    const gigante = `${"a".repeat(600)}.pdf`;
    const nome = nomeDoDocumentoParaEnvio({ nomeExplicito: gigante });
    expect(Array.from(nome).length).toBeLessThanOrEqual(NOME_DE_ARQUIVO_MAX);
    expect(nome.endsWith(".pdf")).toBe(true);
    expect(nome.startsWith("aaa")).toBe(true);
  });

  it("nome gigante e sem extensão é cortado no teto, sem sobra", () => {
    const nome = nomeDoDocumentoParaEnvio({ nomeExplicito: "b".repeat(600) });
    expect(Array.from(nome).length).toBe(NOME_DE_ARQUIVO_MAX);
    expect(nome).toBe("b".repeat(NOME_DE_ARQUIVO_MAX));
  });

  it("nome que não é string (metadata de fora) é ignorado", () => {
    expect(nomeDeArquivoSeguro(42)).toBeNull();
    expect(nomeDeArquivoSeguro(null)).toBeNull();
    expect(nomeDeArquivoSeguro({ nome: "x.pdf" })).toBeNull();
    expect(nomeDoDocumentoParaEnvio({ metadata: { media_filename: 42 }, mime: "text/csv" })).toBe(
      "documento.csv",
    );
  });

  it("metadata que não é objeto (array, string) não derruba o envio", () => {
    expect(nomeDoDocumentoParaEnvio({ metadata: ["x"], mime: "application/pdf" })).toBe(
      "documento.pdf",
    );
    expect(nomeDoDocumentoParaEnvio({ metadata: "x", mime: "application/pdf" })).toBe(
      "documento.pdf",
    );
  });
});

describe("nomeDoDocumentoParaEnvio — acento, espaço e extensão", () => {
  it("acento e espaço atravessam intactos", () => {
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "Orçamento Ação 2026.pdf" })).toBe(
      "Orçamento Ação 2026.pdf",
    );
  });

  it("extensão preservada quando o nome tem ponto no meio", () => {
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "Laudo v1.2 revisado.pdf" })).toBe(
      "Laudo v1.2 revisado.pdf",
    );
  });

  it("nome sem extensão é aceito como veio — o teto é o que decide, não a forma", () => {
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "relatorio-final" })).toBe("relatorio-final");
  });

  it("caractere que sistema de arquivos recusa sai do nome", () => {
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: 'a<b>c:d"e|f?g*h.pdf' })).toBe("abcdefgh.pdf");
  });

  it("caractere invisível/controle sai do nome", () => {
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "no\u0007me\u200f.pdf" })).toBe("nome.pdf");
  });
});

describe("nomeDoDocumentoParaEnvio — travessia de caminho", () => {
  it("`../../etc/passwd.pdf` não atravessa: sobra o último segmento", () => {
    const nome = nomeDoDocumentoParaEnvio({ nomeExplicito: "../../etc/passwd.pdf" });
    expect(nome).toBe("passwd.pdf");
    expect(nome).not.toContain("..");
    expect(nome).not.toContain("/");
  });

  it("travessia com barra invertida (Windows) também não passa", () => {
    const nome = nomeDoDocumentoParaEnvio({ nomeExplicito: "..\\..\\Windows\\nota.pdf" });
    expect(nome).toBe("nota.pdf");
    expect(nome).not.toContain("\\");
  });

  it("caminho absoluto: o diretório fica para trás", () => {
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "/etc/shadow.pdf" })).toBe("shadow.pdf");
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "C:\\temp\\laudo.pdf" })).toBe("laudo.pdf");
  });

  it("travessia escapada em URL (%2F) é decodificada e neutralizada", () => {
    const nome = nomeDoDocumentoParaEnvio({ nomeExplicito: "..%2F..%2Fetc%2Fpasswd.pdf" });
    expect(nome).toBe("passwd.pdf");
    expect(nome).not.toContain("..");
  });

  it("`..` que sobrou sem barra não fica no nome", () => {
    expect(nomeDeArquivoSeguro("..")).toBeNull();
    expect(nomeDeArquivoSeguro("..pdf")).toBe("pdf");
    expect(nomeDoDocumentoParaEnvio({ nomeExplicito: "..", mime: "application/pdf" })).toBe(
      "documento.pdf",
    );
  });

  it("a URL de origem não contribui com diretório para o nome", () => {
    expect(
      nomeDoDocumentoParaEnvio({ url: "https://armazenamento.exemplo/a/b/../../c/x.pdf" }),
    ).toBe("x.pdf");
  });
});

describe("peças soltas", () => {
  it("ultimoSegmentoDoCaminho ignora query e fragmento", () => {
    expect(ultimoSegmentoDoCaminho("https://x.exemplo/a/b.pdf?token=1#p2")).toBe("b.pdf");
    expect(ultimoSegmentoDoCaminho("https://x.exemplo/a/")).toBe("a");
    expect(ultimoSegmentoDoCaminho("/")).toBeNull();
  });

  it("temExtensao não confunde ponto solto nem extensão gigante", () => {
    expect(temExtensao("a.pdf")).toBe(true);
    expect(temExtensao("a.PDF")).toBe(true);
    expect(temExtensao("a.")).toBe(false);
    expect(temExtensao(".pdf")).toBe(false);
    expect(temExtensao("a.arquivomuitolongo")).toBe(false);
  });

  it("nomeDeReserva segue a família do MIME e tira o charset", () => {
    expect(nomeDeReserva("application/pdf")).toBe("documento.pdf");
    expect(nomeDeReserva("text/plain; charset=utf-8")).toBe("documento.txt");
    expect(nomeDeReserva("image/jpeg")).toBe("imagem.jpg");
    expect(nomeDeReserva("video/mp4")).toBe("video.mp4");
    expect(nomeDeReserva("audio/ogg")).toBe("audio.ogg");
    expect(nomeDeReserva("application/octet-stream")).toBe("documento");
    expect(nomeDeReserva(null)).toBe("documento");
  });
});
