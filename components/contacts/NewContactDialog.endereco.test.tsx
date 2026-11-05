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
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateContactResult } from "@/app/api/v1/contacts/_handler";
import type { ApiSuccess } from "@/lib/api/wrappers";
import type { Contact } from "@/lib/types/contacts";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null }),
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

function envolver(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  corpoDoPost = null;
  chamadasDeCep = 0;
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
});
