/**
 * Endereço no CADASTRO do contato pessoa física (#3494, fatia 2).
 *
 * O #3670 levou os sete campos para a FICHA e deixou o cadastro sem nenhum: a
 * pessoa física nascia sem CEP/logradouro, e entrega e cobrança dependiam de
 * abrir a ficha depois — quando alguém lembrava. Aqui se mede, no corpo que
 * sai para `POST /api/v1/contacts`:
 *
 *   • o que foi digitado vai junto (e o CEP preenche logradouro/bairro/cidade/UF);
 *   • contato SEM endereço continua sendo cadastro válido — nenhum campo de
 *     endereço aparece no corpo;
 *   • CEP malformado não impede o cadastro: ele é gravado como foi digitado.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateContactResult } from "@/app/api/v1/contacts/_handler";
import type { ApiSuccess } from "@/lib/api/wrappers";
import type { Contact } from "@/lib/types/contacts";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";

const { orgPais } = vi.hoisted(() => ({ orgPais: { valor: null as string | null } }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: orgPais.valor }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const CONTATO = {
  id: "ct-77",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: null,
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  is_personal: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-09-14T10:00:00.000Z",
  updated_at: "2026-09-14T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

const CORPO_DA_ROTA: ApiSuccess<CreateContactResult> = {
  data: { contact: CONTATO, action: "created" },
};

const CEP_OK = {
  cep: "80000-000",
  street: "Rua XV de Novembro",
  district: "Centro",
  city: "Curitiba",
  state: "PR",
};

let corpoDoPost: Record<string, unknown> | null = null;
let chamadasDeCep = 0;
/** Enquanto existir, a resposta do CEP espera — é a consulta "em voo". */
let cepSegurado: Promise<void> | null = null;

/** O diálogo como a tela de contatos o usa: montado entre aberturas. */
function JanelaDoCadastro() {
  const [aberto, setAberto] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setAberto(true)}>
        Abrir de novo
      </button>
      <NewContactDialog open={aberto} onOpenChange={setAberto} />
    </>
  );
}

function segurarCep(): () => void {
  let soltar = () => {};
  cepSegurado = new Promise<void>((resolve) => {
    soltar = resolve;
  });
  return soltar;
}

function envolver(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  corpoDoPost = null;
  chamadasDeCep = 0;
  cepSegurado = null;
  orgPais.valor = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const alvo = String(url);
      if (alvo.includes("/api/v1/contact-tags")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (alvo.includes("/api/v1/contacts/cep")) {
        chamadasDeCep += 1;
        if (cepSegurado) await cepSegurado;
        return new Response(JSON.stringify({ data: CEP_OK }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      corpoDoPost = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(CORPO_DA_ROTA), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("cadastro com endereço", () => {
  it("tem os sete campos e o CEP preenche logradouro, bairro, cidade e UF", async () => {
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    for (const rotulo of ["CEP", "UF", "Logradouro", "Número", "Complemento", "Bairro", "Cidade"]) {
      expect(screen.getByLabelText(rotulo)).toBeInTheDocument();
    }

    await user.type(screen.getByLabelText("CEP"), "80000-000");
    await user.tab();

    await waitFor(() =>
      expect(screen.getByLabelText("Logradouro")).toHaveValue("Rua XV de Novembro"),
    );
    expect(screen.getByLabelText("Bairro")).toHaveValue("Centro");
    expect(screen.getByLabelText("Cidade")).toHaveValue("Curitiba");
    expect(screen.getByLabelText("UF")).toHaveValue("PR");
  });

  it("manda o endereço digitado no corpo do cadastro", async () => {
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.type(screen.getByLabelText("CEP"), "80000-000");
    await user.tab();
    await waitFor(() => expect(screen.getByLabelText("Cidade")).toHaveValue("Curitiba"));
    await user.type(screen.getByLabelText("Número"), "120");
    await user.type(screen.getByLabelText("Complemento"), "apto 42");
    await user.click(screen.getByRole("button", { name: /Criar contato/i }));

    await waitFor(() => expect(corpoDoPost).not.toBeNull());
    expect(corpoDoPost).toMatchObject({
      name: "Joana Prado",
      zip_code: "80000-000",
      street: "Rua XV de Novembro",
      number: "120",
      complement: "apto 42",
      district: "Centro",
      city: "Curitiba",
      state: "PR",
    });
  });

  it("contato SEM endereço continua válido: nenhum campo de endereço vai no corpo", async () => {
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.click(screen.getByRole("button", { name: /Criar contato/i }));

    await waitFor(() => expect(corpoDoPost).not.toBeNull());
    for (const campo of [
      "zip_code",
      "street",
      "number",
      "complement",
      "district",
      "city",
      "state",
    ]) {
      expect(corpoDoPost).not.toHaveProperty(campo);
    }
  });

  it("CEP de 7 dígitos não consulta e não impede o cadastro", async () => {
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.type(screen.getByLabelText("CEP"), "8000000");
    await user.tab();

    expect(await screen.findByText("CEP deve ter 8 dígitos.")).toBeInTheDocument();
    expect(chamadasDeCep).toBe(0);

    await user.click(screen.getByRole("button", { name: /Criar contato/i }));
    await waitFor(() => expect(corpoDoPost).not.toBeNull());
    expect(corpoDoPost).toMatchObject({ zip_code: "8000000" });
  });

  it("organização fora do Brasil: código de 8 dígitos não vai à consulta e é gravado como veio", async () => {
    orgPais.valor = "PT";
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.type(screen.getByLabelText("CEP"), "12345678");
    await user.tab();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(chamadasDeCep).toBe(0);
    await user.click(screen.getByRole("button", { name: /Criar contato/i }));
    await waitFor(() => expect(corpoDoPost).not.toBeNull());
    expect(corpoDoPost).toMatchObject({ zip_code: "12345678" });
  });

  it("resposta que chega depois de Cancelar não cai no próximo cadastro", async () => {
    const soltarCep = segurarCep();
    const user = userEvent.setup();
    envolver(<JanelaDoCadastro />);

    await user.type(screen.getByLabelText("CEP"), "80000-000");
    await user.tab();
    await waitFor(() => expect(chamadasDeCep).toBe(1));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByLabelText("CEP")).not.toBeInTheDocument());

    soltarCep();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    await user.click(screen.getByRole("button", { name: "Abrir de novo" }));

    expect(await screen.findByLabelText("CEP")).toHaveValue("");
    expect(screen.getByLabelText("Logradouro")).toHaveValue("");
    expect(screen.getByLabelText("Cidade")).toHaveValue("");
  });

  it("resposta de um CEP que a pessoa já trocou não sobrescreve o que ela digita", async () => {
    const soltarCep = segurarCep();
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.type(screen.getByLabelText("CEP"), "80000-000");
    await user.tab();
    await waitFor(() => expect(chamadasDeCep).toBe(1));
    await user.clear(screen.getByLabelText("CEP"));
    await user.type(screen.getByLabelText("CEP"), "80100");

    soltarCep();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(screen.getByLabelText("CEP")).toHaveValue("80100");
    expect(screen.getByLabelText("Logradouro")).toHaveValue("");
  });
});
