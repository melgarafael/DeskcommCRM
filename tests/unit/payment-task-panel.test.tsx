import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseTaskView } from "@/hooks/ai/useCaseTask";

const mocks = vi.hoisted(() => ({ data: {} as CaseTaskView, mutate: vi.fn() }));
vi.mock("@/hooks/ai/useCaseTask", () => ({
  useCaseTask: () => ({ data: mocks.data, isLoading: false, refetch: vi.fn() }),
  useActOnCaseTask: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
import { PaymentTaskPanel } from "@/app/app/ai/cases/_components/PaymentTaskPanel";

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.data = {
    lead_id: "purchase-1",
    lead_title: "Compra atual",
    task_kind: "payment_details",
    task_state: "awaiting_human",
    revision: 7,
    wait_generation: 1,
    wait_started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    assignee_user_id: "user-1",
    assignee_name: "Pessoa responsável",
    assigned_to_me: true,
    task_payload: {},
    decision_event_id: null,
    delivery_job_id: null,
  };
});
afterEach(cleanup);

describe("ação humana e envio são fatos distintos na tela do caso", () => {
  it("preserva a forma cartão já registrada na compra", () => {
    mocks.data.task_payload = { payment_method: "card" };
    render(<PaymentTaskPanel caseId="case-1" />);
    expect(screen.getByLabelText("Forma de pagamento")).toHaveValue("card");
  });

  it("permite identificar a compra sem registrar uma decisão financeira", () => {
    mocks.data.lead_id = null;
    mocks.data.purchase_candidates = [{ id: "purchase-2", title: "Pedido desta cliente" }];
    render(<PaymentTaskPanel caseId="case-1" />);
    expect(screen.getByRole("button", { name: "Liberar dados para envio" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Compra deste atendimento"), {
      target: { value: "purchase-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Vincular compra ao caso" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { action: "link_purchase", lead_id: "purchase-2", expected_revision: 7 },
      expect.any(Object),
    );
  });
  it("exige texto revisado, usa a revisão vista e não anuncia envio ao liberar", () => {
    render(<PaymentTaskPanel caseId="case-1" />);
    const submit = screen.getByRole("button", { name: "Liberar dados para envio" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Texto revisado para enviar à cliente"), {
      target: { value: "Dados oficiais aprovados para esta compra" },
    });
    fireEvent.click(submit);
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        action: "details_release",
        expected_revision: 7,
        payment_method: "pix",
        approved_text: "Dados oficiais aprovados para esta compra",
      },
      expect.any(Object),
    );
    expect(screen.queryByText("Pagamento confirmado", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText(/Atrasado — continua pendente/)).toBeInTheDocument();
  });

  it("outro atendente vê o responsável mas não libera dados", () => {
    mocks.data.assigned_to_me = false;
    render(<PaymentTaskPanel caseId="case-1" />);
    expect(screen.getByText(/Pessoa responsável/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Liberar dados para envio" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Devolver à equipe" })).not.toBeInTheDocument();
  });

  it("confirmação financeira pede revisão e uma segunda ação explícita", () => {
    mocks.data.task_kind = "payment_review";
    render(<PaymentTaskPanel caseId="case-1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Pagamento confirmado$/ }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Texto revisado para enviar à cliente")).toHaveValue(
      "O recebimento do pagamento do seu pedido foi confirmado.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Registrar decisão e enviar comunicação" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payment_confirmed", expected_revision: 7 }),
      expect.any(Object),
    );
  });

  it("não localizado exige próximo passo antes de registrar", () => {
    mocks.data.task_kind = "payment_review";
    render(<PaymentTaskPanel caseId="case-1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Não localizado$/ }));
    fireEvent.change(screen.getByLabelText("Texto revisado para enviar à cliente"), {
      target: { value: "Ainda não localizamos o recebimento. Pode conferir o comprovante?" },
    });
    expect(
      screen.getByRole("button", { name: "Registrar decisão e enviar comunicação" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Próximo passo da conferência"), {
      target: { value: "Aguardar comprovante legível" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Registrar decisão e enviar comunicação" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payment_not_found",
        note: "Aguardar comprovante legível",
      }),
      expect.any(Object),
    );
  });

  it("envio pendente não aparece como concluído e não permite outra liberação", () => {
    mocks.data.task_state = "awaiting_send";
    render(<PaymentTaskPanel caseId="case-1" />);
    expect(screen.getByText("Envio pendente")).toBeInTheDocument();
    expect(screen.getByText(/a mensagem ainda está sendo processada/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Liberar dados para envio" }),
    ).not.toBeInTheDocument();
  });

  it("explica que completed confirma aceitação do canal, não leitura ou pagamento", () => {
    mocks.data.task_state = "completed";
    render(<PaymentTaskPanel caseId="case-1" />);

    expect(screen.getByText("Envio confirmado pelo canal")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "O canal confirmou o envio dos dados oficiais",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "não confirma a leitura pela cliente nem o pagamento",
    );
    expect(
      screen.queryByRole("button", { name: "Liberar dados para envio" }),
    ).not.toBeInTheDocument();
  });

  it("permite retry somente depois de uma falha confirmada", () => {
    mocks.data.task_state = "send_failed";
    render(<PaymentTaskPanel caseId="case-1" />);

    expect(screen.getByRole("alert")).toHaveTextContent("A mensagem não teve envio confirmado");
    fireEvent.click(screen.getByRole("button", { name: "Tentar envio novamente" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { action: "retry_send", expected_revision: 7 },
      expect.any(Object),
    );
  });
});
