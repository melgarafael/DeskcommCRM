/**
 * O cartão da conexão diz o defeito do número de pé — e deixa de dizer só
 * "Conectado". O vigia de saúde grava o defeito em `status_reason`
 * (`lib/channels/health.ts`); aqui se prova que a tela o mostra, nos dois
 * idiomas servidos, e que um número inteiro continua sem linha nenhuma.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DETALHE_NAO_RECEBE, PREFIXO_ENVIO_RESTRITO } from "@/lib/channels/defeito-do-numero";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

import { DefeitoDoNumero, numeroComDefeito } from "./DefeitoDoNumero";

function abrir(status: string, motivo: string | null, locale = "pt-BR") {
  return render(
    <IdiomaProvider locale={locale}>
      <DefeitoDoNumero status={status} motivo={motivo} />
    </IdiomaProvider>,
  );
}

describe("o defeito do número no cartão de Conexões", () => {
  it("⭐ não recebe: a linha de alerta diz o quê e o que fazer", () => {
    abrir("WORKING", DETALHE_NAO_RECEBE);
    const linha = screen.getByTestId("defeito-do-numero");
    expect(linha).toHaveAttribute("role", "alert");
    expect(linha).toHaveTextContent("A Meta informa que este número não recebe mensagens. Reconecte o número.");
  });

  it("⭐ em espanhol", () => {
    abrir("WORKING", DETALHE_NAO_RECEBE, "es");
    expect(screen.getByTestId("defeito-do-numero")).toHaveTextContent(
      "Meta informa que este número no recibe mensajes. Vuelve a conectar el número.",
    );
  });

  it("envio restrito: o código da plataforma no texto", () => {
    abrir("WORKING", `${PREFIXO_ENVIO_RESTRITO}131042`, "es");
    expect(screen.getByTestId("defeito-do-numero")).toHaveTextContent(
      "Meta restringió el envío de este número (código 131042).",
    );
  });

  it("controle: número inteiro, ou motivo de outro dono, não desenha nada", () => {
    abrir("WORKING", null);
    expect(screen.queryByTestId("defeito-do-numero")).toBeNull();
    abrir("WORKING", "connection_repair_required");
    expect(screen.queryByTestId("defeito-do-numero")).toBeNull();
  });

  it("número caído não ganha a linha de defeito — a queda já tem selo e faixa próprios", () => {
    abrir("FAILED", DETALHE_NAO_RECEBE);
    expect(screen.queryByTestId("defeito-do-numero")).toBeNull();
    expect(numeroComDefeito("FAILED", DETALHE_NAO_RECEBE)).toBe(false);
  });

  it("o selo troca 'Conectado' por 'Atenção' só no número de pé com defeito", () => {
    expect(numeroComDefeito("WORKING", DETALHE_NAO_RECEBE)).toBe(true);
    expect(numeroComDefeito("WORKING", `${PREFIXO_ENVIO_RESTRITO}368`)).toBe(true);
    expect(numeroComDefeito("WORKING", null)).toBe(false);
  });
});
