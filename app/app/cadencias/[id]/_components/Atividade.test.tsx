import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Atividade } from "./Atividade";
const t = (s: string) => s;
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => t }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
const linha = (id: string, incerta = false) => ({ id, status: incerta ? "parada" : "ativa", motivo_parada: incerta ? "falha" : null, ultimo_erro: incerta ? "cadencia_delivery_unconfirmed" : null, emails_enviados: 0, aberturas: 0, rastreio_consentido: false, created_at: "2026-10-26T12:00:00Z", proximo_em: "2026-10-27T12:00:00Z", crm_leads: { title: `Negócio ${id}` } });
function pagina(data: unknown[], cursor: string | null) { return new Response(JSON.stringify({ data, meta: { cursor } })); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("alcança inscrições e eventos antigos e explica envio incerto", async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValueOnce(pagina([linha("incerta", true)], "inscricoes-2"))
    .mockResolvedValueOnce(pagina([linha("antiga")], null))
    .mockResolvedValueOnce(pagina([{ id: "evt-1", enrollment_id: "incerta", tipo: "email_falhou", passo_id: "email-1", created_at: "2026-10-26T12:00:00Z" }], "eventos-2"))
    .mockResolvedValueOnce(pagina([{ id: "evt-0", enrollment_id: "incerta", tipo: "inscrito", passo_id: null, created_at: "2026-10-25T12:00:00Z" }], null));
  vi.stubGlobal("fetch", http);
  render(<Atividade id="cad-1" ativa />);
  expect(await screen.findByText(/O provedor pode ter aceitado/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais inscrições" }));
  expect(await screen.findByText("Negócio antiga")).toBeInTheDocument();
  expect(screen.getByText("Negócio incerta")).toBeInTheDocument();
  expect(http.mock.calls[1]![0]).toContain("cursor=inscricoes-2");
  expect(screen.queryByRole("button", { name: "Carregar mais inscrições" })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Ver histórico" })[0]!);
  const painel = await screen.findByLabelText("Histórico da inscrição");
  expect(await within(painel).findByText("Falha no passo")).toBeInTheDocument();
  fireEvent.click(within(painel).getByRole("button", { name: "Carregar mais eventos" }));
  expect(await within(painel).findByText("Inscrição criada.")).toBeInTheDocument();
  expect(within(painel).getByText("Falha no passo")).toBeInTheDocument();
  expect(http.mock.calls[3]![0]).toContain("enrollment_id=incerta&cursor=eventos-2");
  expect(within(painel).queryByRole("button", { name: "Carregar mais eventos" })).toBeNull();
});
it("falha da página seguinte preserva linhas e cursor para tentar de novo", async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValueOnce(pagina([linha("primeira")], "p2"))
    .mockResolvedValueOnce(new Response("falhou", { status: 500 }))
    .mockResolvedValueOnce(pagina([linha("segunda")], null));
  vi.stubGlobal("fetch", http); render(<Atividade id="cad-1" ativa />);
  fireEvent.click(await screen.findByRole("button", { name: "Carregar mais inscrições" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar mais inscrições.");
  expect(screen.getByText("Negócio primeira")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Carregar mais inscrições" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais inscrições" }));
  expect(await screen.findByText("Negócio segunda")).toBeInTheDocument();
  expect(http.mock.calls[2]![0]).toContain("cursor=p2");
});
