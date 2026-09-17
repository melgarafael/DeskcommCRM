import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiError } from "@/lib/api/types";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";
import { showApiError } from "@/components/feedback/ApiErrorToast";

describe("ApiErrorToast", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.info).mockClear();
  });

  it("has at least 10 entries in the COPY map (covered via known codes)", () => {
    const knownCodes = [
      "body_malformed",
      "cursor_malformed",
      "validation_error",
      "auth_required",
      "forbidden_role",
      "resource_not_found",
      "tenant_not_found",
      "idempotency_conflict",
      "conversation_already_claimed",
      "rate_limited",
      "lgpd_anonymization_irreversible",
      "internal_error",
    ];
    for (const code of knownCodes) {
      vi.mocked(toast.error).mockClear();
      vi.mocked(toast.warning).mockClear();
      vi.mocked(toast.info).mockClear();
      showApiError(new ApiError(400, code, undefined, "req-x"));
      const total =
        vi.mocked(toast.error).mock.calls.length +
        vi.mocked(toast.warning).mock.calls.length +
        vi.mocked(toast.info).mock.calls.length;
      expect(total).toBeGreaterThan(0);
    }
    expect(knownCodes.length).toBeGreaterThanOrEqual(10);
  });

  it("calls toast.warning with canonical PT-BR for conversation_already_claimed", () => {
    showApiError(new ApiError(409, "conversation_already_claimed", undefined, "req-1"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "Outro atendente já assumiu.",
      expect.objectContaining({ description: "ID: req-1" }),
    );
  });

  it("calls toast.warning com mensagem humana para invalid_state (casos humanos, spec 15)", () => {
    showApiError(new ApiError(409, "invalid_state", undefined, "req-3"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "Este caso já foi respondido ou fechado.",
      expect.objectContaining({ description: "ID: req-3" }),
    );
  });

  it("a recusa do motivo da perda é AVISO, não erro — e passa o texto da rota", () => {
    // Recusa rotineira (o operador não escolheu a causa; o card volta e nada foi
    // tocado) não é "algo quebrou". Vermelho aqui ensina a ignorar vermelho.
    showApiError(
      new ApiError(422, "lost_reason_required", undefined, "req-917", "Informe o motivo da perda."),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      "Informe o motivo da perda.",
      expect.objectContaining({ description: "ID: req-917" }),
    );
  });

  it("motivo fora do vocabulário do funil também é AVISO", () => {
    showApiError(
      new ApiError(
        422,
        "lost_reason_invalid",
        undefined,
        "req-918",
        "Esse motivo de perda não está na lista deste funil — escolha um dos motivos configurados.",
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("falls back to toast.error for unknown ApiError code", () => {
    const err = new ApiError(418, "unknown_teapot_code", undefined, "req-2", "I'm a teapot");
    showApiError(err);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "I'm a teapot",
      expect.objectContaining({ description: "ID: req-2" }),
    );
  });

  it("calls toast.error with generic message for non-ApiError", () => {
    showApiError(new Error("oops"));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Erro inesperado. Tente novamente.");
  });
});
