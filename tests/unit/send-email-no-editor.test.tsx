/**
 * A ação `send_email` (#2726) NO EDITOR DE REGRAS — a perna da tela.
 *
 * O que este arquivo prova:
 *
 *   1. `labels.ts` nomeia a ação (sem isso, uma regra criada pela API aparece
 *      no RuleEditor com o título em branco — e é de `Object.keys(ACTION_LABELS)`
 *      que o seletor de "ENTÃO" monta as opções);
 *   2. `defaultActionConfig` nasce com a MESMA forma que o schema exige;
 *   3. `ActionConfigForm` TEM o caso: o rótulo do destinatário renderiza, e
 *      escolher "Endereço fixo" revela o campo do endereço;
 *   4. o que a pessoa escreve chega na regra pelo `onChange`;
 *   5. o que o editor PRODUZ passa no `createAutomationRuleSchema` — o mesmo
 *      `safeParse` que o RuleEditor roda antes do POST e que a API roda na
 *      porta. Sem este caso, o item 2 comparava o default consigo mesmo e a
 *      prova de tela achou o furo: com "E-mail do contato" o salvar morria em
 *      "Invalid email address", porque o default nasce com `email_fixo: ""`.
 *
 * A execução (destinatário e variáveis resolvidos, falha com motivo) vive em
 * `lib/automation/actions/send-email.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

import { ACTION_LABELS, type ActionType } from "@/app/app/webhooks/_components/labels";
import { apiClient } from "@/lib/api/client";
import { createAutomationRuleSchema, updateAutomationRuleSchema } from "@/lib/schemas/webhooks";
import {
  ActionConfigForm,
  defaultActionConfig,
  type ActionItem,
} from "@/app/app/webhooks/_components/ActionConfigForm";

afterEach(() => cleanup());
afterAll(() => vi.restoreAllMocks());

// jsdom não implementa captura de ponteiro; o gatilho do Select do Radix lê
// `hasPointerCapture` antes de abrir — sem isto, abrir morre em TypeError.
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

/**
 * O formulário é CONTROLADO: ele lê `action` e avisa `onChange`, e é o
 * editor (o componente pai) que guarda o estado. Aqui a gente repete o papel
 * do pai — `setAtual` — senão escolher "Endereço fixo" só avisa e não revela
 * campo nenhum, o que NÃO é defeito do formulário.
 */
function montar(action: ActionItem, onChange = vi.fn()) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Pai({ inicial }: { inicial: ActionItem }) {
    const [atual, setAtual] = React.useState(inicial);
    return (
      <QueryClientProvider client={cliente}>
        <ActionConfigForm
          action={atual}
          onChange={(next) => {
            setAtual(next);
            onChange(next);
          }}
        />
      </QueryClientProvider>
    );
  }
  const utils = render(<Pai inicial={action} />);
  return { ...utils, onChange };
}

describe("labels.ts nomeia send_email", () => {
  it("está no ACTION_LABELS e no ActionType, com frase própria", () => {
    const tipos = Object.keys(ACTION_LABELS) as ActionType[];
    expect(tipos).toContain("send_email");
    expect(ACTION_LABELS.send_email).toMatch(/e-mail/i);
  });
});

describe("ActionConfigForm: o formulário do e-mail", () => {
  beforeEach(() => vi.mocked(apiClient.get).mockReset());

  it("defaultActionConfig nasce com destinatário Contato e o endereço fixo vazio", () => {
    expect(defaultActionConfig("send_email")).toEqual({
      type: "send_email",
      config: { destinatario: "contato", email_fixo: "", assunto: "", corpo: "", formato: "texto" },
    });
  });

  it("renderiza destinatário, assunto e corpo", () => {
    montar(defaultActionConfig("send_email"));
    expect(screen.getByText("Destinatário")).toBeInTheDocument();
    expect(screen.getByText("Assunto")).toBeInTheDocument();
    expect(screen.getByText("Corpo do e-mail")).toBeInTheDocument();
    // O aviso de POR ONDE sai é o que impede a pessoa de procurar uma
    // credencial nova: o envio usa o e-mail que já está configurado.
    expect(
      screen.getByText(/e-mail configurado em Admin/i),
    ).toBeInTheDocument();
  });

  it("escolher Endereço fixo revela o campo do endereço", () => {
    const { container, onChange } = montar(defaultActionConfig("send_email"));
    const gatilho = container.querySelector("button");
    expect(gatilho, "o seletor do destinatário não renderizou gatilho").not.toBeNull();

    fireEvent.click(gatilho!);
    fireEvent.click(screen.getByText("Endereço fixo"));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: "send_email", config: expect.objectContaining({ destinatario: "fixo" }) }),
    );
    expect(screen.getByText("Endereço de e-mail")).toBeInTheDocument();
  });

  it("o que a pessoa escreve no assunto chega na regra", () => {
    const { onChange } = montar(defaultActionConfig("send_email"));
    const assunto = screen.getByPlaceholderText("Sua viagem para {{destino}}");
    fireEvent.change(assunto, { target: { value: "Seu voucher" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ assunto: "Seu voucher" }) }),
    );
  });
});

/**
 * O contrato REAL: o que o editor produz, passado pelo mesmo `safeParse` que
 * o RuleEditor roda antes do POST (e que as rotas POST/PATCH rodam na porta).
 * A ação parte do `defaultActionConfig` — com o `email_fixo: ""` que o campo
 * controlado precisa — e recebe só o que a pessoa digita.
 */
function regraComEmail(config: Partial<Extract<ActionItem, { type: "send_email" }>["config"]>) {
  const base = defaultActionConfig("send_email");
  if (base.type !== "send_email") throw new Error("defaultActionConfig mudou de tipo");
  return {
    name: "Voucher por e-mail",
    trigger_event: "lead.created",
    conditions: [],
    actions: [{ type: "send_email", config: { ...base.config, assunto: "Seu voucher", corpo: "Olá {{nome}}", ...config } }],
    trigger_config: {},
  };
}

describe("o que o editor produz passa no schema da regra", () => {
  it.each(["contato", "dono_do_lead"] as const)(
    "destinatário %s salva com o endereço fixo vazio (e não grava o vazio)",
    (destinatario) => {
      const r = createAutomationRuleSchema.safeParse(regraComEmail({ destinatario }));
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
      // `undefined` some no JSON do POST: o "" não chega a ser gravado.
      expect(JSON.parse(JSON.stringify(r.data?.actions[0]?.config))).not.toHaveProperty("email_fixo");
      // A edição (PATCH) passa pelo mesmo trecho do schema.
      const u = updateAutomationRuleSchema.safeParse(regraComEmail({ destinatario }));
      expect(u.success, JSON.stringify(u.error?.issues)).toBe(true);
    },
  );

  it("endereço fixo SEM endereço é recusado na porta, com frase em português", () => {
    const r = createAutomationRuleSchema.safeParse(regraComEmail({ destinatario: "fixo" }));
    expect(r.success).toBe(false);
    const issue = r.error?.issues[0];
    expect(issue?.path).toEqual(["actions", 0, "config", "email_fixo"]);
    expect(issue?.message).toBe("Informe o endereço de e-mail que recebe os envios desta regra.");
  });

  it("endereço fixo com endereço inválido é recusado em português", () => {
    const r = createAutomationRuleSchema.safeParse(
      regraComEmail({ destinatario: "fixo", email_fixo: "nao-e-email" }),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("E-mail inválido");
  });

  it("endereço fixo com endereço válido salva e grava o endereço", () => {
    const r = createAutomationRuleSchema.safeParse(
      regraComEmail({ destinatario: "fixo", email_fixo: "vendas@agencia.com.br" }),
    );
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(r.data?.actions[0]?.config).toMatchObject({ email_fixo: "vendas@agencia.com.br" });
  });
});
