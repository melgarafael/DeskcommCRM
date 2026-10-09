import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const PEDIDO = "aaaaaaaa-0000-4000-8000-000000000001";

vi.mock("@/hooks/useLgpdRequests", () => ({
  useLgpdRequests: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: {
      data: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000001",
          organization_id: "o",
          request_type: "data_request",
          source: "manual",
          contact_id: null,
          external_customer_id: null,
          status: "received",
          attempts: 0,
          received_at: new Date().toISOString(),
          due_at: null,
          completed_at: null,
          emergency: false,
          scope: "contact",
          error_message: null,
          sla_bucket: "ok",
        },
      ],
      meta: { total: 1, page: 1, limit: 25, has_more: false },
    },
  }),
}));

import { RequestsTable } from "./RequestsTable";

describe("RequestsTable: para onde o Ver leva", () => {
  it("por padrão, abre o detalhe em /app", () => {
    render(<RequestsTable />);
    expect(screen.getByRole("link", { name: "Ver" })).toHaveAttribute("href", `/app/lgpd/requests/${PEDIDO}`);
  });

  it("no hub da suspensão, abre no próprio hub, porque o layout de /app devolveria a pessoa para lá", () => {
    render(<RequestsTable baseDoPedido="/account-suspended?pedido=" />);
    expect(screen.getByRole("link", { name: "Ver" })).toHaveAttribute("href", `/account-suspended?pedido=${PEDIDO}`);
  });
});
