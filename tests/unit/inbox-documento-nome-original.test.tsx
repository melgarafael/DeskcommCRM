import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DocumentCard } from "@/components/inbox/media/DocumentCard";
import {
  extensaoDoDocumento,
  mediaDownloadSrc,
  mediaFileLabel,
  nomeOriginalDoDocumento,
} from "@/components/inbox/media/media-utils";

/**
 * #2613 — o Inbox mostrava só a extensão (`XLSX`) do documento recebido.
 *
 * Duas metades, medidas separadamente:
 *
 *   1. Com nome no payload, o cartão mostra o NOME.
 *   2. SEM nome (anexo antigo, canal que não manda `filename`), o cartão diz
 *      `Documento XLSX` — a extensão identificada como extensão, nunca sozinha
 *      no lugar do nome. É o fallback que a issue pede nas palavras dela
 *      ("apresentar um fallback claro (por exemplo, `Documento XLSX`)"), e a
 *      diferença importa: `XLSX` sozinho se lê como título do arquivo.
 */
describe("mediaFileLabel com nome original", () => {
  it("prefere o nome do payload à extensão", () => {
    expect(
      mediaFileLabel(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "org/conv/m1.xlsx",
        "Relatorio_Vendas_Outubro.xlsx",
      ),
    ).toBe("Relatorio_Vendas_Outubro.xlsx");
    expect(mediaFileLabel("application/pdf", "org/conv/m2.pdf", "Orcamento.pdf")).toBe(
      "Orcamento.pdf",
    );
  });

  it("sem nome, devolve a extensão crua (o helper é puro; quem compõe é o cartão)", () => {
    expect(mediaFileLabel("application/pdf", "org/conv/m1.pdf")).toBe("PDF");
    expect(
      mediaFileLabel(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "org/conv/m1.xlsx",
        null,
      ),
    ).toBe("XLSX");
    expect(mediaFileLabel("application/pdf", "org/conv/m1.pdf", "   ")).toBe("PDF");
  });
});

describe("extensaoDoDocumento", () => {
  it.each([
    ["application/vnd.ms-excel", "XLS"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "XLSX"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "DOCX"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "PPTX"],
    ["application/pdf", "PDF"],
    ["APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.SPREADSHEETML.SHEET; charset=utf-8", "XLSX"],
  ])("antes do Storage, %s é reconhecido como %s", (mime, extensao) => {
    expect(extensaoDoDocumento(mime, null)).toBe(extensao);
    expect(extensaoDoDocumento(mime, "org/conv/m.bin")).toBe(extensao);
  });

  it("MIME desconhecido não vira extensão inventada", () => {
    expect(extensaoDoDocumento("application/x-formato-desconhecido", null)).toBeNull();
    expect(mediaFileLabel("application/x-formato-desconhecido", null)).toBe("Arquivo");
  });

  it("path persistido continua sendo a fonte antes do MIME", () => {
    expect(extensaoDoDocumento("application/octet-stream", "org/conv/m.xlsx")).toBe("XLSX");
    expect(extensaoDoDocumento("application/pdf", "org/conv/m.xls")).toBe("XLS");
  });

  it("diz a extensão das três do relato, do path e do mime", () => {
    expect(extensaoDoDocumento("application/vnd.ms-excel", "org/conv/m.xls")).toBe("XLS");
    expect(
      extensaoDoDocumento(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "org/conv/m.xlsx",
      ),
    ).toBe("XLSX");
    expect(extensaoDoDocumento("application/pdf", "org/conv/m.pdf")).toBe("PDF");
  });

  it("sem extensão reconhecível, não inventa uma", () => {
    expect(extensaoDoDocumento(null, null)).toBeNull();
    expect(extensaoDoDocumento("application/octet-stream", "org/conv/m.bin")).toBeNull();
  });
});

describe("nomeOriginalDoDocumento", () => {
  it("lê metadata.media_filename quando é nome de verdade", () => {
    expect(nomeOriginalDoDocumento({ media_filename: "Relatorio.xlsx" })).toBe(
      "Relatorio.xlsx",
    );
    expect(nomeOriginalDoDocumento({ media_filename: "  a.xls  " })).toBe("a.xls");
  });

  it("descarta ausente, vazio e tipo errado", () => {
    expect(nomeOriginalDoDocumento(null)).toBeNull();
    expect(nomeOriginalDoDocumento(undefined)).toBeNull();
    expect(nomeOriginalDoDocumento({})).toBeNull();
    expect(nomeOriginalDoDocumento({ media_filename: "" })).toBeNull();
    expect(nomeOriginalDoDocumento({ media_filename: "   " })).toBeNull();
    expect(nomeOriginalDoDocumento({ media_filename: 42 })).toBeNull();
  });
});

describe("DocumentCard", () => {
  it("XLSX sem nome nem path mostra o fallback legível antes do worker", () => {
    render(<DocumentCard messageId="mime-only" mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      sizeBytes={2048} storagePath={null} isOutbound={false} />);
    expect(screen.getByText("Documento XLSX")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Documento XLSX \(2,0 KB\)$/ })).toHaveAttribute("href", "/api/v1/messages/mime-only/media");
  });

  const NOME_LONGO = "Relatorio_Vendas_Outubro_Consolidado_Por_Regiao_Versao_Final.xlsx";

  it("com nome no payload, mostra o NOME (não só a extensão)", () => {
    render(
      <DocumentCard
        messageId="m1"
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        sizeBytes={12582912}
        storagePath="org/conv/m1.xlsx"
        isOutbound={false}
        fileName="Relatorio_Vendas_Outubro.xlsx"
      />,
    );
    expect(screen.getByText("Relatorio_Vendas_Outubro.xlsx")).toBeInTheDocument();
    expect(screen.queryByText("XLSX")).toBeNull();
    // O nome inteiro segue acessível no link, mesmo com o texto truncado.
    expect(
      screen.getByRole("link", {
        name: /baixar Relatorio_Vendas_Outubro\.xlsx \(12,0 MB\)/i,
      }),
    ).toBeInTheDocument();
  });

  it("SEM nome, diz `Documento XLSX` — a extensão como extensão, nunca como nome", () => {
    const { rerender } = render(
      <DocumentCard
        messageId="m2"
        mime="application/pdf"
        sizeBytes={3179614}
        storagePath="org/conv/m2.pdf"
        isOutbound={false}
      />,
    );
    expect(screen.getByText("Documento PDF")).toBeInTheDocument();
    expect(screen.queryByText("PDF")).toBeNull();

    rerender(
      <DocumentCard
        messageId="m2"
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        sizeBytes={3179614}
        storagePath="org/conv/m2.xlsx"
        isOutbound={false}
        fileName={null}
      />,
    );
    expect(screen.getByText("Documento XLSX")).toBeInTheDocument();

    rerender(
      <DocumentCard
        messageId="m2"
        mime="application/vnd.ms-excel"
        sizeBytes={3179614}
        storagePath="org/conv/m2.xls"
        isOutbound={false}
        fileName={"   "}
      />,
    );
    expect(screen.getByText("Documento XLS")).toBeInTheDocument();
  });

  it("sem extensão nenhuma, o fallback é `Documento` e não uma extensão inventada", () => {
    render(
      <DocumentCard
        messageId="m5"
        mime="application/octet-stream"
        sizeBytes={10}
        storagePath="org/conv/m5.bin"
        isOutbound={false}
      />,
    );
    expect(screen.getByText("Documento")).toBeInTheDocument();
  });

  it("nome longo fica truncado com o nome inteiro em title", () => {
    const { container } = render(
      <DocumentCard
        messageId="m3"
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        sizeBytes={2048}
        storagePath="org/conv/m3.xlsx"
        isOutbound={false}
        fileName={NOME_LONGO}
      />,
    );
    const rotulo = container.querySelector(".truncate") as HTMLElement;
    expect(rotulo).not.toBeNull();
    expect(rotulo).toHaveTextContent(NOME_LONGO);
    expect(rotulo).toHaveAttribute("title", NOME_LONGO);
    // O nome inteiro chega aos dois links (abrir e baixar) por aria-label.
    expect(
      screen.getAllByRole("link", { name: (nome) => nome.includes(NOME_LONGO) }),
    ).toHaveLength(2);
  });
});

/**
 * O outro critério de aceite da issue, que o PR anterior deixou declarado como
 * "não verificado": o nome ao BAIXAR. O link de download pede `?baixar=1` para
 * a rota poder nomear o arquivo com o nome original; a rota só o usa quando
 * conhece o nome (ver `app/api/v1/messages/[id]/media/route.test.ts`).
 */
describe("DocumentCard — download com nome original", () => {
  it("tem um link de download separado que pede o arquivo pelo nome", () => {
    render(
      <DocumentCard
        messageId="m9"
        mime="application/pdf"
        sizeBytes={2048}
        storagePath="org/conv/m9.pdf"
        isOutbound={false}
        fileName="Orcamento Assinado.pdf"
      />,
    );
    expect(mediaDownloadSrc("m9")).toBe("/api/v1/messages/m9/media?baixar=1");
    const baixar = screen.getByRole("link", { name: /baixar Orcamento Assinado\.pdf/i });
    expect(baixar).toHaveAttribute("href", "/api/v1/messages/m9/media?baixar=1");
  });

  it("o link do arquivo continua abrindo a mídia (preview não vira download)", () => {
    render(
      <DocumentCard
        messageId="m10"
        mime="application/pdf"
        sizeBytes={2048}
        storagePath="org/conv/m10.pdf"
        isOutbound={false}
        fileName="Orcamento.pdf"
      />,
    );
    const abrir = screen.getByRole("link", { name: /^Orcamento\.pdf \(2,0 KB\)$/i });
    expect(abrir).toHaveAttribute("href", "/api/v1/messages/m10/media");
  });
});
