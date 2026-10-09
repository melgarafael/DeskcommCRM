/**
 * O diálogo de suspensão é onde o dono decide. Ele dizia que a suspensão só
 * bloqueava o acesso e que "pode ser revertida" — e desde a migration 0501
 * suspender cala a IA, os envios e as automações, e descarta SEM volta as
 * mensagens na fila e as tarefas agendadas.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useSuspendTenant", () => ({ useSuspendTenant: () => ({ mutate: vi.fn(), isPending: false }) }));

import { SuspendDialog } from "./SuspendDialog";

describe("SuspendDialog", () => {
  it("diz o que a suspensão para e o que ela descarta sem volta — e não promete reversão", () => {
    render(<SuspendDialog open onClose={() => {}} organizationId="org-1" />);
    const descricao = screen.getByText(/a IA, os envios e as automações dela param/);
    expect(descricao).toHaveTextContent("são descartadas e não saem ao reativar");
    expect(descricao).toHaveTextContent("os follow-ups em andamento retomam de onde pararam");
    expect(screen.queryByText(/pode ser revertida/)).toBeNull();
  });
});
