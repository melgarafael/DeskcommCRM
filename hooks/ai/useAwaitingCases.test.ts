import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAwaitingCases } from "./useAwaitingCases";
import { useCases } from "@/hooks/ai/useCases";

vi.mock("@/hooks/ai/useCases", () => ({ useCases: vi.fn() }));

describe("useAwaitingCases", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lê a lista autorizada e conserva só os pendentes, do mais antigo ao mais recente", () => {
    vi.mocked(useCases).mockReturnValue({
      data: {
        cases: [
          { id: "novo", status: "awaiting_human", opened_at: "2026-10-05T10:00:00Z" },
          { id: "resolvido", status: "resolved", opened_at: "2026-10-05T08:00:00Z" },
          { id: "escalado", status: "escalated", opened_at: "2026-10-05T06:00:00Z" },
          { id: "cancelado", status: "cancelled", opened_at: "2026-10-05T06:30:00Z" },
          { id: "antigo", status: "awaiting_human", opened_at: "2026-10-05T09:00:00Z" },
          { id: "lead", status: "awaiting_lead", opened_at: "2026-10-05T07:00:00Z" },
        ],
      },
    } as never);

    const { result } = renderHook(() => useAwaitingCases());
    expect(useCases).toHaveBeenCalledWith("awaiting_human");
    expect(result.current.casosPendentes.map((caso) => caso.id)).toEqual(["antigo", "novo"]);
  });
});
