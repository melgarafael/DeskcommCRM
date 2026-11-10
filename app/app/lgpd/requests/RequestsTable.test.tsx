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

describe("RequestsTable: o Ver no celular", () => {
  it("abaixo de md fica com 44×44px; de md para cima, a altura de antes: 28px entre md e lg e 32px de lg para cima (o lg:h-8 do size vence)", () => {
    render(<RequestsTable />);
    const ver = screen.getByRole("link", { name: "Ver" });
    // `h-7` sem prefixo derrubava o `h-11` do size="sm" no tailwind-merge.
    expect(ver.className.split(/\s+/)).not.toContain("h-7");
    expect(ver).toHaveClass("h-11", "md:h-7", "max-md:min-w-11");
    expect(document.querySelector("thead")).toHaveClass("max-md:hidden");
  });
});
