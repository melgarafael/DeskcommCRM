/**
 * A aba Diagnóstico da ficha — o que vai no PATCH.
 *
 * O `PATCH /api/v1/contacts/:id` SUBSTITUI `custom_fields` inteiro
 * (`app/api/v1/contacts/_handler.ts`). Então a prova que importa é o corpo:
 * salvar o diagnóstico manda o objeto COMPLETO, com os `link_*` e os campos da
 * organização que esta aba nem mostra. Mandar só o diagnóstico apagaria o resto
 * em silêncio — e nenhum outro teste veria.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiagnosticoDoContato } from "@/components/contacts/DiagnosticoDoContato";
import type { Contact } from "@/lib/types/contacts";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => useUpdate }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
// Salvar RELÊ a ficha antes do PATCH. Por padrão a releitura devolve o mesmo
// contato que a tela pintou; o caso da gravação concorrente troca o retorno.
vi.mock("@/lib/api/client", () => ({ apiClient: { get: getContato } }));
const { mutateAsync, useUpdate, getContato } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  useUpdate: { mutateAsync: vi.fn(), isPending: false },
  getContato: vi.fn(),
}));

const USUARIO = "22222222-2222-4222-8222-222222222222";
const AGENTE = "11111111-1111-4111-8111-111111111111";

function contato(custom_fields: Record<string, unknown>): Contact {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: "44444444-4444-4444-8444-444444444444",
    name: "Padaria Exemplo",
    custom_fields,
    updated_at: "2026-11-14T12:00:00.000Z",
  } as unknown as Contact;
}

function pintar(c: Contact, podeEditar = true) {
  getContato.mockResolvedValue({ data: c });
  render(<DiagnosticoDoContato contato={c} podeEditar={podeEditar} usuarioId={USUARIO} />);
}

function corpo(): Record<string, unknown> {
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  return (mutateAsync.mock.calls[0]?.[0] as { custom_fields: Record<string, unknown> }).custom_fields;
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdate.mutateAsync = mutateAsync;
  mutateAsync.mockResolvedValue({});
});

describe("salvar o diagnóstico manda o custom_fields completo", () => {
  it("⭐ os link_* e os campos da organização voltam intactos no PATCH", async () => {
    const user = userEvent.setup();
    const antes = {
      link_instagram: "instagram.com/padaria",
      link_bio: "paginadelinks.exemplo.com/padaria",
      convenio: "Unimed",
      numero_de_filiais: 3,
      // Valor que a tela não sabe ler (não é texto): não pode sumir.
      link_site: 42,
    };
    pintar(contato(antes));

    await user.type(screen.getByLabelText("Diagnóstico"), "Sem cardápio online.");
    await user.type(screen.getByLabelText("Segmento"), "Padaria");
    await user.click(screen.getByRole("button", { name: "Salvar diagnóstico" }));

    const enviado = corpo();
    expect(enviado).toMatchObject({
      ...antes,
      segmento: "Padaria",
      diag_resumo: "Sem cardápio online.",
      diag_por: `usuario:${USUARIO}`,
    });
    expect(typeof enviado.diag_em).toBe("string");
  });

  it("o Link na bio é editável aqui e entra como link_bio", async () => {
    const user = userEvent.setup();
    pintar(contato({ convenio: "Unimed" }));

    await user.type(screen.getByLabelText("Link na bio"), "paginadelinks.exemplo.com/loja");
    await user.click(screen.getByRole("button", { name: "Salvar diagnóstico" }));

    expect(corpo()).toEqual({ convenio: "Unimed", link_bio: "paginadelinks.exemplo.com/loja" });
  });

  it("CNPJ inválido não salva e avisa no campo", async () => {
    const user = userEvent.setup();
    pintar(contato({}));

    await user.type(screen.getByLabelText("CNPJ"), "11.222.333/0001-00");
    await user.click(screen.getByRole("button", { name: "Salvar diagnóstico" }));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText("CNPJ inválido.")).toBeTruthy();
  });

  it("CNPJ válido vai sem máscara", async () => {
    const user = userEvent.setup();
    pintar(contato({}));

    await user.type(screen.getByLabelText("CNPJ"), "11.222.333/0001-81");
    await user.click(screen.getByRole("button", { name: "Salvar diagnóstico" }));

    expect(corpo()).toEqual({ documento_cnpj: "11222333000181" });
  });
});

describe("o selo Escrito pela IA", () => {
  it("⭐ aparece quando diag_por é de um agente", () => {
    pintar(contato({ diag_resumo: "Agenda com buracos.", diag_por: `agente:${AGENTE}` }));
    expect(screen.getByText("Escrito pela IA")).toBeTruthy();
    expect(screen.getByLabelText("Diagnóstico")).toHaveProperty("value", "Agenda com buracos.");
  });

  it("não aparece quando quem escreveu foi a equipe", () => {
    pintar(contato({ diag_resumo: "Agenda com buracos.", diag_por: `usuario:${USUARIO}` }));
    expect(screen.queryByText("Escrito pela IA")).toBeNull();
  });

  it("também aparece para quem só lê", () => {
    pintar(contato({ diag_resumo: "Agenda com buracos.", diag_por: `agente:${AGENTE}` }), false);
    expect(screen.getByText("Escrito pela IA")).toBeTruthy();
  });
});

describe("quem não pode editar só lê", () => {
  it("mostra os valores e nenhum formulário", () => {
    pintar(contato({ segmento: "Padaria", diag_oferta: "Cardápio pelo WhatsApp." }), false);
    expect(screen.getByText("Padaria")).toBeTruthy();
    expect(screen.getByText("Cardápio pelo WhatsApp.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salvar diagnóstico" })).toBeNull();
  });

  it("sem nada preenchido, diz isso", () => {
    pintar(contato({ convenio: "Unimed" }), false);
    expect(screen.getByText("Nada preenchido ainda.")).toBeTruthy();
  });
});

describe("salvar relê a ficha: o que outro caminho gravou não some", () => {
  it("⭐ link e diagnóstico gravados por outro caminho depois da leitura sobrevivem", async () => {
    const user = userEvent.setup();
    pintar(contato({ convenio: "Unimed" }));
    // Enquanto a pessoa escrevia, o "Completar fichas" gravou o site e a IA
    // gravou o diagnóstico. A releitura do salvar já vê os dois.
    getContato.mockResolvedValue({
      data: contato({
        convenio: "Unimed",
        link_site: "exemplo.com.br",
        diag_resumo: "Texto da IA.",
        diag_por: `agente:${AGENTE}`,
      }),
    });

    await user.type(screen.getByLabelText("Observações da equipe"), "Ligar depois das 14h.");
    await user.click(screen.getByRole("button", { name: "Salvar diagnóstico" }));

    expect(getContato).toHaveBeenCalledWith("/api/v1/contacts/33333333-3333-4333-8333-333333333333");
    expect(corpo()).toEqual({
      convenio: "Unimed",
      link_site: "exemplo.com.br",
      diag_resumo: "Texto da IA.",
      diag_por: `agente:${AGENTE}`,
      diag_observacoes: "Ligar depois das 14h.",
    });
  });

  it("⭐ editar um link não apaga outro link que a tela não sabe ler", async () => {
    const user = userEvent.setup();
    pintar(contato({ link_site: 42, convenio: "Unimed" }));

    await user.type(screen.getByLabelText("Link na bio"), "paginadelinks.exemplo.com/loja");
    await user.click(screen.getByRole("button", { name: "Salvar diagnóstico" }));

    expect(corpo()).toEqual({
      link_site: 42,
      convenio: "Unimed",
      link_bio: "paginadelinks.exemplo.com/loja",
    });
  });

  it("a releitura falhou: nada é gravado", async () => {
    const user = userEvent.setup();
    pintar(contato({}));
    getContato.mockRejectedValue(new Error("rede"));

    await user.type(screen.getByLabelText("Segmento"), "Padaria");
    await user.click(screen.getByRole("button", { name: "Salvar diagnóstico" }));

    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
