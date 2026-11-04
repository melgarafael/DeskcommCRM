import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HandoffDeliveryForm } from "./_handoff-form";
import { configEntregaSchema } from "@/lib/schemas/handoff-delivery";
vi.mock("@/hooks/contacts/useTelefoneExemplo", () => ({ useTelefoneExemplo: () => "+351 912 345 678" }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
const a = "aaaaaaaa-0000-4000-8000-000000000001";
describe("controle da passagem humana", () => {
  it("nasce desligado sem vendedor inventado e não faz envio", () => {
    render(<HandoffDeliveryForm initial={configEntregaSchema.parse({})} members={[]} />);
    expect(
      screen.getByRole("checkbox", { name: "Ativar passagem humana nesta empresa" }),
    ).not.toBeChecked();
    expect(
      screen.getByText("Cadastre os vendedores na equipe antes de ativar."),
    ).toBeInTheDocument();
  });
  it("não ativa sem WhatsApp do vendedor e não chama API", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(
      <HandoffDeliveryForm
        initial={configEntregaSchema.parse({})}
        members={[{ id: a, name: "Vendedor sintético" }]}
      />,
    );
    fireEvent.click(screen.getByLabelText("Ativar passagem humana nesta empresa"));
    fireEvent.click(screen.getByLabelText("Vendedor sintético"));
    fireEvent.click(screen.getByText("Salvar passagem"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Confira vendedores"));
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("salva escolha dos links pelo mesmo endpoint sem disparo", async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      json: async () => ({ data: JSON.parse(options.body as string) }),
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<HandoffDeliveryForm initial={configEntregaSchema.parse({})} members={[]} />);
    fireEvent.change(screen.getByLabelText("Links no aviso ao vendedor"), {
      target: { value: "both" },
    });
    fireEvent.click(screen.getByText("Salvar passagem"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Configuração salva"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/settings/handoff-delivery");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string).notice_links).toBe("both");
    vi.unstubAllGlobals();
  });

  it("remove seleção e destino invisíveis antes de salvar, sem tocar nos controles", async () => {
    const oldId = "aaaaaaaa-0000-4000-8000-000000000099";
    const newId = "aaaaaaaa-0000-4000-8000-000000000002";
    const initial = configEntregaSchema.parse({
      enabled: true,
      seller_user_ids: [oldId, a],
      seller_destinations: { [oldId]: "+5511000000099", [a]: "+5511000000001" },
      supervisor_destinations: ["+5511000000003"],
      notice_links: "both",
      max_attempts: 20,
      retry_seconds: 60,
    });
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      json: async () => ({ data: JSON.parse(options.body as string) }),
    }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <HandoffDeliveryForm
        initial={initial}
        members={[
          { id: a, name: "Vendedor ativo" },
          { id: newId, name: "Vendedor novo" },
        ]}
      />,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Vendedor ativo")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Vendedor novo"));
    fireEvent.change(screen.getByLabelText("WhatsApp de Vendedor novo"), {
      target: { value: "+5511000000002" },
    });
    fireEvent.click(screen.getByText("Salvar passagem"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const sent = JSON.parse(fetcher.mock.calls[0]?.[1].body as string);
    expect(sent.seller_user_ids).toEqual([a, newId]);
    expect(sent.seller_destinations).toEqual({ [a]: "+5511000000001", [newId]: "+5511000000002" });
    expect(sent.supervisor_destinations).toEqual(initial.supervisor_destinations);
    expect(sent.notice_links).toBe("both");
    expect(sent.enabled).toBe(true);
    expect(sent.max_attempts).toBe(20);
    expect(sent.retry_seconds).toBe(60);
    expect(initial.seller_user_ids).toEqual([oldId, a]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/settings/handoff-delivery");
    vi.unstubAllGlobals();
  });
});

it("salva atribuição sem avisos e sem pedir telefone", async () => {
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => ({
    ok: true,
    json: async () => ({ data: JSON.parse(options.body as string) }),
  }));
  vi.stubGlobal("fetch", fetcher);
  render(
    <HandoffDeliveryForm
      initial={configEntregaSchema.parse({})}
      members={[{ id: a, name: "Atendente de teste" }]}
    />,
  );
  fireEvent.click(screen.getByLabelText("Ativar passagem humana nesta empresa"));
  fireEvent.click(screen.getByLabelText("Enviar avisos pelo WhatsApp após atribuir"));
  fireEvent.click(screen.getByLabelText("Atendente de teste"));
  expect(screen.queryByLabelText("WhatsApp de Atendente de teste")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Salvar passagem"));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toMatchObject({
    notifications_enabled: false,
    enabled: true,
    seller_user_ids: [a],
  });
  vi.unstubAllGlobals();
});
