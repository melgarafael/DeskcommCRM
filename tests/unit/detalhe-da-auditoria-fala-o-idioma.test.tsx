import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditDetailClient } from "@/app/admin/(protected)/audit/[entryId]/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

vi.mock("@/hooks/useAdminAuditEntry", () => ({
  useAdminAuditEntry: () => ({
    data: {
      data: {
        entry: {
          id: "11111111-1111-4111-8111-111111111111",
          organization_id: null,
          action: "lead.updated",
          actor_user_id: null,
          resource_type: null,
          resource_id: null,
          metadata: {},
          request_id: "22222222-2222-4222-8222-222222222222",
          created_at: "2026-11-18T00:00:00.000Z",
          acting_as_platform_admin: false,
          bypassed_rls: false,
          actor_ip: null,
          actor_user_agent: null,
        },
        tenant: null,
        actor: null,
      },
    },
    isLoading: false,
    isError: false,
  }),
}));

function renderDetail(locale: "pt-BR" | "es") {
  render(
    <IdiomaProvider locale={locale}>
      <AuditDetailClient entryId="11111111-1111-4111-8111-111111111111" />
    </IdiomaProvider>,
  );
}

afterEach(cleanup);

describe("detalhe da auditoria", () => {
  it("em português, Metadados e ID da requisição aparecem traduzidos", () => {
    renderDetail("pt-BR");
    expect(screen.getByRole("heading", { name: "Metadados" })).toBeInTheDocument();
    expect(screen.getByText("ID da requisição")).toBeInTheDocument();
    expect(screen.queryByText("Metadata")).toBeNull();
    expect(screen.queryByText("Request ID")).toBeNull();
  });

  it("em espanhol, Metadatos e ID de la solicitud aparecem traduzidos", () => {
    renderDetail("es");
    expect(screen.getByRole("heading", { name: "Metadatos" })).toBeInTheDocument();
    expect(screen.getByText("ID de la solicitud")).toBeInTheDocument();
    expect(screen.queryByText("Metadata")).toBeNull();
    expect(screen.queryByText("Request ID")).toBeNull();
  });
});
