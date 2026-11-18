/**
 * O INTERRUPTOR «Cancelar se o lead responder» NO GATILHO DE FALTA CONFIRMADA
 * (#3400).
 *
 * ## O defeito que estes casos trancam
 *
 * A tela mostrava o interruptor LIGADO e travado nesse gatilho, mas
 * `toTriggerConfig` montava só `{ kind, params }` — o `cancel_on_reply` que a
 * pessoa VÊ não existia no fio. Para o motor (`cancel_on_reply ?? false`) o
 * fluxo não cancelava: o paciente respondia "quero remarcar" e o toque seguinte
 * da sequência saía por cima do atendimento. E o contrário também doía — um
 * fluxo que já tinha o valor gravado (modelo de clínica, contorno por SQL) o
 * PERDIA no primeiro salvamento feito pela tela.
 *
 * ## O que se prova aqui, e o que NÃO se prova
 *
 * Prova-se o CONTRATO da tela em jsdom: o interruptor nasce ligado, é travado
 * (neste gatilho não há escolha a fazer — quem marca a consulta é o atendimento,
 * `lib/followup/modelos/clinica.ts`) e o salvamento envia exatamente o valor que
 * a tela mostra. O COMPORTAMENTO do motor não se mede aqui: quem mede é
 * `lib/followup/reactivity-falta-confirmada.test.ts`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const patchMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    patch: (...a: unknown[]) => patchMock(...a),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { TriggerConfigControl } from "./TriggerConfigControl";

function cliente() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

/** Identificadores SINTÉTICOS — fixture nunca copia id do banco. */
const FLUXO = "66666666-6666-4666-8666-666666666666";
const TIPO_DE_COMPROMISSO = "77777777-7777-4777-8777-777777777777";

/** O gatilho como a tela antiga gravava: sem `cancel_on_reply`. */
const FALTA_SEM_O_CAMPO = { kind: "appointment_no_show", params: {} };

function montar(triggerConfig: Record<string, unknown> = FALTA_SEM_O_CAMPO) {
  return render(
    <QueryClientProvider client={cliente()}>
      <TriggerConfigControl flowId={FLUXO} triggerConfig={triggerConfig} />
    </QueryClientProvider>,
  );
}

async function abrirPainel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("trigger-config-button"));
  return screen.getByTestId("trigger-config-panel");
}

/** O `trigger_config` que a tela enviou no PATCH. */
function configEnviado(): Record<string, unknown> {
  expect(patchMock).toHaveBeenCalledTimes(1);
  const [, body] = patchMock.mock.calls[0]!;
  return (body as { trigger_config: Record<string, unknown> }).trigger_config;
}

beforeEach(() => {
  vi.clearAllMocks();
  // O painel lê etapas/funis para o rótulo e os tipos de compromisso para os
  // checkboxes; sem resposta a consulta fica pendente e o `waitFor` expiraria
  // por outro motivo.
  getMock.mockImplementation(async (url: string) =>
    String(url).includes("agenda/tipos")
      ? { data: [{ id: TIPO_DE_COMPROMISSO, name: "Avaliação" }] }
      : { data: [] },
  );
  patchMock.mockResolvedValue({ data: { id: FLUXO } });
});

describe("gatilho de falta · o interruptor não pode mentir", () => {
  it("aparece LIGADO e travado neste gatilho", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    const interruptor = screen.getByLabelText("Cancelar se o lead responder");
    expect(interruptor).toHaveAttribute("data-state", "checked");
    expect(interruptor).toBeDisabled();
  });

  it("SALVAR grava `cancel_on_reply: true` — o que a tela mostra fica no trigger_config", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    // Mexe no único campo editável deste gatilho, para o botão habilitar.
    await user.click(screen.getByLabelText("Avaliação"));
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    const config = configEnviado();
    expect(config.kind).toBe("appointment_no_show");
    expect(config.cancel_on_reply).toBe(true);
    expect((config.params as Record<string, unknown>).event_type_ids).toEqual([
      TIPO_DE_COMPROMISSO,
    ]);
  });

  it("gatilho que JÁ tem o valor não o perde ao ser salvo de novo", async () => {
    const user = userEvent.setup();
    montar({ kind: "appointment_no_show", params: {}, cancel_on_reply: true });
    await abrirPainel(user);

    await user.click(screen.getByLabelText("Avaliação"));
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(configEnviado().cancel_on_reply).toBe(true);
  });
});
