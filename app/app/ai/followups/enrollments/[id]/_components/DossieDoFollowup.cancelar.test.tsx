/**
 * O DOSSIÊ OFERECE "CANCELAR" PARA TODO STATUS EM QUE A ROTA CANCELA (#3434).
 *
 * A rota de cancelar (`LIVE_STATUSES`) e a fila (`LIVE_ENROLLMENT_STATUSES`)
 * aceitam `coletando` e `dormente` desde o #3263; a lista do dossiê
 * (`CANCELAVEL`) não acompanhou. Quem abria o dossiê de uma espera longa — um
 * nó `wait` com `immune_to_reply` dormindo por dias — não tinha como desistir
 * dela pela tela, e tinha de voltar para a fila.
 *
 * Eram três listas escritas à mão. Agora as três leem `STATUS_CANCELAVEIS`
 * (`lib/followup/vocabulario.ts`), e é por isso que este arquivo mede o que o
 * operador VÊ: o botão que dispara a mesma rota que a fila já usava.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FollowupEnrollmentDossie } from "@/hooks/followup/useFollowupEnrollment";
import type * as DateFnsLocale from "date-fns/locale";

import { DossieDoFollowup } from "./DossieDoFollowup";

const dados = vi.hoisted(() => {
  const data: FollowupEnrollmentDossie = {
    id: "9f2c1b6a-4d7e-4f8a-9c0b-1d2e3f4a5b6c",
    status: "active",
    current_node_id: "n1",
    next_eval_at: null,
    claimed_until: null,
    motor_ocupado: false,
    started_at: "2026-09-01T10:00:00Z",
    completed_at: null,
    updated_at: "2026-09-01T10:00:00Z",
    outcome: null,
    cancel_reason: null,
    last_error: null,
    attempts: 0,
    max_attempts: 5,
    steps_taken: 2,
    contact: { id: "c1", name: "Maria" },
    flow: { pointer_id: "p1", name: "Vendas", version_id: "v1" },
    agent_name: null,
    no_atual: null,
    nos: [],
    saidas: [],
    eventos: [],
    eventos_truncados: false,
    plano_de_tempo: null,
    autores: {},
  };
  return { data };
});

vi.mock("@/hooks/followup/useFollowupEnrollment", () => ({
  useFollowupEnrollment: () => ({ data: dados.data, isLoading: false, isError: false }),
  useIntervirNoFollowup: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/hooks/followup/useFollowupQueue", () => ({
  useCancelFollowupEnrollment: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock("@/hooks/i18n/useLocaleDeData", async () => {
  const { ptBR } = await vi.importActual<typeof DateFnsLocale>("date-fns/locale");
  return { useLocaleDeData: () => ptBR, useTagDeIdioma: () => "pt-BR" };
});

afterEach(cleanup);

function abrirComStatus(status: string, canWrite = true) {
  dados.data.status = status;
  render(<DossieDoFollowup id={dados.data.id} canWrite={canWrite} />);
}

describe("botão Cancelar do dossiê do follow-up", () => {
  it.each(["dormente", "coletando"])("status %s: tem o botão, como a fila e a rota", (status) => {
    abrirComStatus(status);
    expect(screen.queryByTestId("dossie-cancelar")).not.toBeNull();
  });

  it.each(["active", "waiting_reply", "paused_handoff", "paused_manual"])(
    "controle: status %s continua com o botão",
    (status) => {
      abrirComStatus(status);
      expect(screen.queryByTestId("dossie-cancelar")).not.toBeNull();
    },
  );

  it("controle: status completed não tem o botão", () => {
    abrirComStatus("completed");
    expect(screen.queryByTestId("dossie-cancelar")).toBeNull();
  });

  it("controle: sem permissão de escrita, nem o dormente tem o botão", () => {
    abrirComStatus("dormente", false);
    expect(screen.queryByTestId("dossie-cancelar")).toBeNull();
  });
});
