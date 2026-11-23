/**
 * O formulário de links do funil com a escolha da organização (#5128).
 *
 * O caso que importa é o (c) do critério: salvar o formulário com um tipo
 * ESCONDIDO e preenchido NÃO pode apagar o valor dele. `aplicarLinks` regrava o
 * catálogo inteiro a partir da tela e apagaria; `aplicarLinksAlterados` toca só
 * o que mudou. A sabotagem combinada com este teste devolve o formulário a
 * `aplicarLinks` e deixa o caso vermelho.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/types/contacts";

const mutateAsync = vi.fn(async (_patch: { custom_fields: Record<string, unknown> }) => undefined);
const invalidarQuadro = vi.fn(async () => undefined);

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({ chaveDoQuadro: (id: string) => ["board", id] }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidarQuadro }),
}));

import { FormularioDeLinks } from "./FormularioDeLinks";

beforeEach(() => {
  mutateAsync.mockClear();
  invalidarQuadro.mockClear();
});

function contato(customFields: Record<string, unknown>): Contact {
  return {
    id: "c1",
    updated_at: "2026-11-22T12:00:00.000Z",
    custom_fields: customFields,
  } as unknown as Contact;
}

/** Um `Contact` mínimo, mas com o campo que o formulário renderiza. */
function renderizar(customFields: Record<string, unknown>, tiposPermitidos?: string[]) {
  return render(
    <FormularioDeLinks
      contato={contato(customFields)}
      pipelineId="p1"
      tiposPermitidos={tiposPermitidos as never}
    />,
  );
}

describe("FormularioDeLinks — só os tipos marcados aparecem", () => {
  it("⭐ com [instagram, linkedin], os outros campos nem existem na tela", () => {
    renderizar({}, ["instagram", "linkedin"]);

    expect(screen.getByLabelText("Instagram")).toBeInTheDocument();
    expect(screen.getByLabelText("LinkedIn")).toBeInTheDocument();
    expect(screen.queryByLabelText("YouTube")).toBeNull();
    expect(screen.queryByLabelText("Site")).toBeNull();
  });

  it("ausente = catálogo inteiro (quem nunca ajustou vê a tela de antes)", () => {
    renderizar({});

    expect(screen.getByLabelText("Instagram")).toBeInTheDocument();
    expect(screen.getByLabelText("YouTube")).toBeInTheDocument();
    expect(screen.getByLabelText("Site")).toBeInTheDocument();
  });
});

describe("FormularioDeLinks — salvar não apaga o que está escondido", () => {
  it("⭐ tipo escondido e preenchido continua no custom_fields depois de salvar", async () => {
    renderizar(
      {
        link_youtube: "https://youtube.com/@loja",
        cor_favorita: "azul",
      },
      ["instagram", "linkedin"],
    );

    fireEvent.change(screen.getByLabelText("Instagram"), {
      target: { value: "instagram.com/loja" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar links" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const enviado = mutateAsync.mock.calls[0]![0];
    expect(enviado.custom_fields.link_youtube).toBe("https://youtube.com/@loja");
    expect(enviado.custom_fields.link_instagram).toBe("instagram.com/loja");
    expect(enviado.custom_fields.cor_favorita).toBe("azul");
  });

  it("⭐ escondido com valor INVÁLIDO não trava o salvamento (não está na tela para consertar)", async () => {
    renderizar({ link_youtube: "@canal" }, ["instagram"]);

    fireEvent.change(screen.getByLabelText("Instagram"), {
      target: { value: "instagram.com/loja" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar links" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const enviado = mutateAsync.mock.calls[0]![0];
    expect(enviado.custom_fields.link_youtube).toBe("@canal");
  });

  it("tipo visível com valor inválido continua barrando o salvamento", async () => {
    renderizar({}, ["instagram"]);

    fireEvent.change(screen.getByLabelText("Instagram"), { target: { value: "@loja" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar links" }));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText("Endereço inválido.")).toBeInTheDocument();
  });

  it("apagar o texto de um tipo visível apaga a chave dele", async () => {
    renderizar({ link_instagram: "instagram.com/loja" }, ["instagram"]);

    fireEvent.change(screen.getByLabelText("Instagram"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar links" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const enviado = mutateAsync.mock.calls[0]![0];
    expect("link_instagram" in enviado.custom_fields).toBe(false);
  });
});
