/**
 * `ImportarLeads` avisa por `onImportado` quando a planilha foi aceita (#3933): a tela do Cold
 * Call precisa disso para reler a fila, porque o QueryClient não refaz consulta no foco. Recusa
 * e falha de rede NÃO avisam, e sem a prop (o quadro) nada muda.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportarLeads } from "@/app/app/kanban/_components/ImportarLeads";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const RESUMO = { total_linhas: 1, criados: 1, contatos_criados: 1, erros: [], colunas_ignoradas: [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function importarCom(resposta: { ok: boolean; corpo: unknown }, onImportado?: () => void) {
  const fetchFalso = vi.fn(async () => ({ ok: resposta.ok, json: async () => resposta.corpo }));
  vi.stubGlobal("fetch", fetchFalso);
  render(<ImportarLeads funis={[{ id: "funil", name: "Cold Call" } as never]} onImportado={onImportado} />);
  fireEvent.click(screen.getByTestId("abrir-importar-leads"));
  const entrada = (await screen.findByTestId("arquivo-de-leads")) as HTMLInputElement;
  fireEvent.change(entrada, { target: { files: [new File(["nome,telefone\nAna,11999999999"], "leads.csv", { type: "text/csv" })] } });
  await waitFor(() => expect(fetchFalso).toHaveBeenCalledTimes(1));
  return fetchFalso;
}

describe("ImportarLeads avisa quem importou", () => {
  it("planilha aceita: onImportado é chamado uma vez", async () => {
    const onImportado = vi.fn();
    await importarCom({ ok: true, corpo: { data: RESUMO } }, onImportado);
    await waitFor(() => expect(onImportado).toHaveBeenCalledTimes(1));
  });

  it("planilha recusada: não avisa", async () => {
    const onImportado = vi.fn();
    await importarCom({ ok: false, corpo: { error: { message: "não li" } } }, onImportado);
    await screen.findByText("não li");
    expect(onImportado).not.toHaveBeenCalled();
  });

  it("sem a prop (o quadro): importa e mostra o resumo como antes", async () => {
    await importarCom({ ok: true, corpo: { data: RESUMO } });
    expect(await screen.findByTestId("resumo-da-importacao")).toBeTruthy();
  });
});
