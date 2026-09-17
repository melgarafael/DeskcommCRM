/**
 * O CONTATO QUE VOLTA DO DIÁLOGO É O CONTATO, NÃO O ENVELOPE.
 *
 * `POST /api/v1/contacts` responde `ok(createContactHandler(...))`, e `ok()` já
 * embrulha — o corpo na rede é `{ data: { contact, action } }`. Quem lê
 * `resposta.data` recebe `{ contact, action }` e, se repassar isso como se
 * fosse o contato, o `id` sai `undefined`: o contato nasce no banco e a
 * marcação que abriu o diálogo continua sem ninguém. Nada na tela reclama.
 *
 * ⚠️ POR QUE ESTE ARQUIVO EXISTE AO LADO DE `VinculoDaMarcacao.test.tsx`.
 * Aquele dubla o `NewContactDialog` inteiro e chama `onCriado` com um objeto
 * que ELE mesmo escreve — prova que o fio está ligado do diálogo para cima, e
 * é cego justamente para o andar de baixo, que é onde o defeito morava. Aqui
 * roda o componente de verdade, sobre o `apiClient` de verdade, com o `fetch`
 * devolvendo o corpo EXATO da rota.
 *
 * A ligação de compilação é o `ApiSuccess<CreateContactResult>` do fixture: se
 * a rota mudar de forma, este arquivo para de compilar em vez de continuar
 * verde medindo a forma antiga.
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

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const CONTATO = {
  id: "ct-77",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: "+5511999998888",
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
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
  // Contato recém-criado pela tela ainda não é cliente: quem carimba é o
  // agendamento, com a regra "Clientes pela agenda" ligada (migration 0262), e
  // este caso é o do cadastro manual.
  first_service_at: null,
} satisfies Contact;

/** O corpo que a rota devolve, tipado pelo retorno dela. */
const CORPO_DA_ROTA: ApiSuccess<CreateContactResult> = {
  data: { contact: CONTATO, action: "created" },
};

function envolver(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(CORPO_DA_ROTA), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("NewContactDialog · onCriado", () => {
  it("entrega o CONTATO de dentro do envelope, com id utilizável", async () => {
    const onCriado = vi.fn();
    const user = userEvent.setup();
    envolver(
      <NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" onCriado={onCriado} />,
    );

    await user.type(screen.getByLabelText(/Telefone/i), "+5511999998888");
    await user.click(screen.getByRole("button", { name: /Criar contato/i }));

    await waitFor(() => expect(onCriado).toHaveBeenCalledTimes(1));

    const recebido = onCriado.mock.calls[0]?.[0] as Contact;
    // O que quebra na vida real: o chamador usa `.id` para selecionar o contato.
    expect(recebido.id).toBe("ct-77");
    expect(recebido.name).toBe("Joana Prado");
    // E o envelope NÃO pode ter vazado: `{ contact, action }` passaria nos
    // testes de "foi chamado" e falharia em toda leitura de campo.
    expect(recebido).not.toHaveProperty("contact");
    expect(recebido).not.toHaveProperty("action");
  });

  it("não chama onCriado quando a rota não devolve contato", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { action: "created" } }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const onCriado = vi.fn();
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} onCriado={onCriado} />);

    await user.type(screen.getByLabelText(/Telefone/i), "+5511999998888");
    await user.click(screen.getByRole("button", { name: /Criar contato/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(onCriado).not.toHaveBeenCalled();
  });
});
