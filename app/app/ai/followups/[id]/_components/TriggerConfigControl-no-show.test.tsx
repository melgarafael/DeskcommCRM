/**
 * #3400 — «Cancelar se o lead responder» NO GATILHO `appointment_no_show`
 * («Falta confirmada pela equipe»): o switch MENTIA. Ele era forçado em
 * `checked` + `disabled` nesse kind, e o gravador descartava o valor — o PATCH
 * saía com `{kind, params}` e sem `cancel_on_reply`, então o motor (que lê
 * `cancel_on_reply ?? false` em `lib/followup/reactivity.ts`) nunca cancelava
 * o fluxo quando o paciente respondia.
 *
 * O que este arquivo congela, nos DOIS sentidos:
 *
 *  - Cenário A: ligar e salvar GRAVA `cancel_on_reply: true` — e o valor que
 *    sai da tela passa pelo MESMO schema que o motor usa para ler
 *    (`triggerConfigSchema`), com `cancel_on_reply === true`.
 *  - Cenário B: desligar e salvar grava SEM a chave (o motor lê o default
 *    `false`), e o valor gravado SOBREVIVE ao reabrir o editor: com a chave
 *    salva o switch abre ligado (e operável).
 *  - A tela mostra o valor GRAVADO: sem a chave o switch abre desligado e
 *    HABILITADO — não mais um «ligado» travado que o motor ignora.
 *  - Cenário C (regressão zero): os demais kinds (`manual` no espelho) seguem
 *    iguais — leem o salvo e gravam `cancel_on_reply` no mesmo formato. O
 *    restante dos kinds é coberto pelos testes do seletor e pelos vizinhos
 *    (`TriggerConfigControl-silencio.test.tsx`).
 *
 * O MOTOR não é reescrito por este defeito: `applyReactivityEvent` já cancela
 * qualquer enrollment vivo cujo `trigger_config` tenha `cancel_on_reply: true`
 * (prova em `tests/invariants/followup-reactivity.test.ts`, contra Postgres, e
 * em `tests/e2e/agenda-presenca-recuperacao.spec.ts`, que grava
 * `{ kind: "appointment_no_show", cancel_on_reply: false }`). O defeito era a
 * TELA não conseguir gravar o valor — daí o teste morar ao lado do componente.
 *
 * Mesmo preparo do vizinho de silêncio: `apiClient`, `sonner` e `useT` falsos,
 * um `QueryClient` sem cache entre casos e `userEvent` pra interagir.
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

import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import { TriggerConfigControl } from "./TriggerConfigControl";

/** Sem retry e sem cache entre casos: cada caso monta a tela do zero. */
function cliente() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

/** Identificadores SINTÉTICOS — fixture nunca copia id do banco. */
const FLUXO = "66666666-6666-4666-8666-666666666666";
const TIPO_DE_COMPROMISSO = "77777777-7777-4777-8777-777777777777";

/** O gatilho do defeito, cru: sem `cancel_on_reply` nenhum. */
const NO_SHOW_CRU = {
  kind: "appointment_no_show",
  params: { event_type_ids: [TIPO_DE_COMPROMISSO] },
};

function montar(triggerConfig: Record<string, unknown> = NO_SHOW_CRU) {
  return render(
    <QueryClientProvider client={cliente()}>
      <TriggerConfigControl flowId={FLUXO} triggerConfig={triggerConfig} />
    </QueryClientProvider>,
  );
}

/** Abre o painel do gatilho, como quem clica no botão. */
async function abrirPainel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("trigger-config-button"));
  return screen.getByTestId("trigger-config-panel");
}

function interruptor() {
  return screen.getByRole("switch", { name: "Cancelar se o lead responder" });
}

/** O `trigger_config` que a tela enviou no PATCH. */
function corpoDoPatch(): Record<string, unknown> {
  expect(patchMock).toHaveBeenCalledTimes(1);
  const [, body] = patchMock.mock.calls[0]!;
  return (body as { trigger_config: Record<string, unknown> }).trigger_config;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Etapas, funis e tipos de agenda: o painel os lê, e sem resposta a consulta
  // fica pendente e o `waitFor` expiraria por outro motivo.
  getMock.mockResolvedValue({ data: [] });
  patchMock.mockResolvedValue({ data: { id: FLUXO } });
});

describe("gatilho appointment_no_show · «Cancelar se o lead responder» grava de verdade (#3400)", () => {
  it("cenário A — ligar e salvar grava cancel_on_reply: true, e o schema do motor lê true", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    const alvo = interruptor();
    // Sem o valor salvo o switch abre DESLIGADO (o motor não cancela) — e
    // HABILITADO: travar era justamente o defeito.
    expect(alvo).toHaveAttribute("data-state", "unchecked");

    await user.click(alvo);
    expect(alvo).toHaveAttribute("data-state", "checked");
    await user.click(screen.getByTestId("trigger-config-save"));
    await waitFor(() => expect(patchMock).toHaveBeenCalled());

    expect(corpoDoPatch()).toEqual({
      kind: "appointment_no_show",
      params: { event_type_ids: [TIPO_DE_COMPROMISSO] },
      cancel_on_reply: true,
    });
    // O MESMO schema que `parseCancelOnReply` (lib/followup/reactivity.ts)
    // usa para decidir o cancelamento: se a tela passa nele com `true`, o
    // motor cancela na 1ª resposta do contato.
    expect(triggerConfigSchema.parse(corpoDoPatch()).cancel_on_reply).toBe(true);
  });

  it("cenário B — desligar e salvar grava SEM a chave: o motor lê o default false", async () => {
    const user = userEvent.setup();
    montar({ ...NO_SHOW_CRU, cancel_on_reply: true });
    await abrirPainel(user);

    // O valor gravado SOBREVIVE ao reabrir o editor: abre ligado (e operável).
    const alvo = interruptor();
    expect(alvo).toHaveAttribute("data-state", "checked");

    await user.click(alvo);
    expect(alvo).toHaveAttribute("data-state", "unchecked");
    await user.click(screen.getByTestId("trigger-config-save"));
    await waitFor(() => expect(patchMock).toHaveBeenCalled());

    const cfg = corpoDoPatch();
    expect(cfg).toEqual({
      kind: "appointment_no_show",
      params: { event_type_ids: [TIPO_DE_COMPROMISSO] },
    });
    expect(cfg).not.toHaveProperty("cancel_on_reply");
    // Sem a chave, `parseCancelOnReply` devolve o default `false` — o fluxo
    // continua acordando o classify em vez de cancelar.
    expect(triggerConfigSchema.parse(cfg).cancel_on_reply).toBeUndefined();
  });

  it("sem cancel_on_reply salvo, o switch abre DESLIGADO e operável — não um «ligado» que o motor ignora", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    const alvo = interruptor();
    expect(alvo).toHaveAttribute("data-state", "unchecked");
    expect(alvo).not.toBeDisabled();
  });

  it("cenário C — manual salvo ligado abre ligado, e desligar grava sem a chave", async () => {
    const user = userEvent.setup();
    montar({ kind: "manual", cancel_on_reply: true });
    await abrirPainel(user);

    const ligado = interruptor();
    expect(ligado).toHaveAttribute("data-state", "checked");
    await user.click(ligado);
    await user.click(screen.getByTestId("trigger-config-save"));
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(corpoDoPatch()).toEqual({ kind: "manual" });
  });

  it("cenário C — manual sem valor salvo: ligar e salvar grava cancel_on_reply: true", async () => {
    const user = userEvent.setup();
    montar({ kind: "manual" });
    await abrirPainel(user);

    const alvo = interruptor();
    expect(alvo).toHaveAttribute("data-state", "unchecked");
    await user.click(alvo);
    await user.click(screen.getByTestId("trigger-config-save"));
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(corpoDoPatch()).toEqual({ kind: "manual", cancel_on_reply: true });
  });
});
