import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DocumentCard } from "@/components/inbox/media/DocumentCard";
import {
  mediaFileLabel,
  nomeOriginalDoDocumento,
} from "@/components/inbox/media/media-utils";

/**
 * #2613 — o Inbox mostrava só a extensão (`XLSX`) do documento recebido.
 * O nome original só aparece quando o payload o trouxe; sem ele, o rótulo de
 * extensão de hoje continua sendo a resposta.
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

  it("sem nome, mantém a extensão de hoje", () => {
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

  it("sem nome no payload, continua mostrando a extensão", () => {
    const { rerender } = render(
      <DocumentCard
        messageId="m2"
        mime="application/pdf"
        sizeBytes={3179614}
        storagePath="org/conv/m2.pdf"
        isOutbound={false}
      />,
    );
    expect(screen.getByText("PDF")).toBeInTheDocument();

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
    expect(screen.getByText("XLSX")).toBeInTheDocument();
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
    expect(
      screen.getByRole("link", { name: new RegExp(NOME_LONGO.replace(/\./g, "\\.")) }),
    ).toBeInTheDocument();
  });
});
