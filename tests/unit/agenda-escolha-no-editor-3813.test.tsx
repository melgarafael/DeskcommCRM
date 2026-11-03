/**
 * O SELETOR DA AGENDA NO EDITOR DE REGRAS (#3813) — a perna da TELA.
 *
 * O motor já está inteiro na main: `lib/agenda/escolha-no-envio.ts` define a
 * chave `quando_ha_compromisso` com três valores (`adiar` padrão, `enviar`,
 * `nao_enviar`) e os consumidores a respeitam (`send-whatsapp`,
 * `send-ai-message`, o follow-up e o worker `pg`). O que faltava era o
 * CONTROLE: sem ele a escolha só existia para quem editasse o JSON da regra
 * pela API, e o operador da clínica continuava com o adiamento all-or-nothing
 * que a issue descreve.
 *
 * ⚠️ ENTRA PELO EDITOR REAL (`RuleEditor`), não pelo formulário isolado: monta
 * a gaveta com a regra que a API gravou, clica no rádio e em "Salvar
 * alterações", e confere o payload que a mutação recebe — depois do
 * `createAutomationRuleSchema`, que é o que o `onSubmit` entrega. Um teste do
 * `ActionConfigForm` sozinho passaria mesmo que o editor descartasse o passo.
 *
 * A escolha mora no `config` do PASSO que envia (`send_whatsapp_message` /
 * `send_ai_message`), e não no `trigger_config`: é de lá que
 * `lerEscolhaNoEnvio(config)` a lê no disparo (`lib/automation/actions/
 * send-whatsapp.ts:24`). Gravá-la no gatilho seria uma tela que promete o que
 * o motor não obedece.
 *
 * Os ganchos de dados são dublados (não há servidor aqui); o resto é o
 * componente de produção, incluindo o schema e o Radix do Sheet.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom não implementa captura de ponteiro; o gatilho do Select do Radix lê
// `hasPointerCapture` antes de abrir — sem isto, abrir morre em TypeError
// (mesmo remédio de `rule-editor-preserva-config-ao-salvar.test.tsx`).
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const h = vi.hoisted(() => ({ criar: vi.fn(), atualizar: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock("@/hooks/webhooks/useAutomationRules", () => ({
  useCreateAutomationRule: () => ({ isPending: false, mutateAsync: h.criar }),
  useUpdateAutomationRule: () => ({ isPending: false, mutateAsync: h.atualizar }),
}));
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: [] } }),
  usePipelines: () => ({ data: { data: [{ id: "funil-1", name: "Funil de vendas", is_default: true, settings: null }] } }),
  usePipelineStages: () => ({ data: undefined }),
}));
// O número do WhatsApp: um só, conectado — a lista é dado de tela, não o
// assunto deste teste.
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  channelLabel: (c: { display_name?: string | null; waha_session_name?: string | null }) =>
    c.display_name || c.waha_session_name || "Número sem nome",
  useChannelSessions: () => ({
    data: [
      {
        id: "3f1c9d2e-1111-4a11-8b11-111111111111",
        waha_session_name: "recepcao",
        display_name: "Recepção",
        phone_number: null,
        status: "WORKING",
      },
    ],
  }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: { pipeline: { settings: null }, stages: [] } }),
}));
vi.mock("@/hooks/ai/useAgents", () => ({
  useAgentsList: () => ({ data: [{ id: "4a2d8e3f-2222-4b22-9c22-222222222222", name: "Ana", published_version_id: "v1" }] }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isLoading: false }),
}));

import { RuleEditor } from "@/app/app/webhooks/_components/RuleEditor";
import type { AutomationRuleRow } from "@/hooks/webhooks/useAutomationRules";

/** O rótulo do grupo, como a tela o escreve. É por ele que o operador acha a escolha. */
const ROTULO_DO_GRUPO = "Quando o contato tiver horário marcado";
const AVISO = "Adiar";
const ENVIAR = "Enviar mesmo assim";
const NAO_ENVIAR = "Não enviar";

/**
 * Paciente saiu do procedimento e o retorno já está marcado para 14 dias
 * depois — o caso 1 da issue. A regra tem UMA ação de WhatsApp e o
 * `trigger_config` vazio: nada de agenda foi configurado nela até hoje.
 */
const REGRA_DO_POS: AutomationRuleRow = {
  id: "regra-1",
  organization_id: "org-1",
  name: "Cuidados depois do atendimento",
  trigger_event: "appointment.completed",
  conditions: [],
  actions: [
    {
      type: "send_whatsapp_message",
      config: { channel_session_id: "3f1c9d2e-1111-4a11-8b11-111111111111", template: "Oi {{nome}}, cuide-se bem." },
    },
  ],
  trigger_config: {},
  is_active: true,
  last_run_at: null,
  run_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

function montar(rule: AutomationRuleRow) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cliente}>
      <RuleEditor open onOpenChange={vi.fn()} rule={rule} />
    </QueryClientProvider>,
  );
}

type Payload = {
  id: string;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
};

async function salvar(): Promise<Payload> {
  fireEvent.click(await screen.findByRole("button", { name: "Salvar alterações" }));
  await waitFor(() => expect(h.atualizar).toHaveBeenCalledTimes(1));
  return h.atualizar.mock.calls[0]![0] as Payload;
}

function escolher(opcao: string) {
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(opcao) }));
}

beforeEach(() => {
  h.criar.mockReset();
  h.atualizar.mockReset();
});

describe("o passo de envio oferece a escolha da agenda", () => {
  it("⭐ o formulário tem um grupo com as TRÊS opções", () => {
    montar(REGRA_DO_POS);

    expect(
      screen.getByRole("radiogroup", { name: ROTULO_DO_GRUPO }),
      "o passo de WhatsApp não oferece a escolha da agenda: o operador continua sem poder dizer o que fazer com quem tem horário marcado",
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: new RegExp(AVISO) })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: new RegExp(ENVIAR) })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: new RegExp(NAO_ENVIAR) })).toBeInTheDocument();
  });

  it("⭐ escolher `nao_enviar` grava exatamente esse valor e mantém o resto do config", async () => {
    montar(REGRA_DO_POS);

    escolher(NAO_ENVIAR);
    const payload = await salvar();

    expect(
      payload.actions[0]!.config,
      "a escolha do operador não chegou no config do passo — ou levou junto o número/o texto da mensagem",
    ).toEqual({
      channel_session_id: "3f1c9d2e-1111-4a11-8b11-111111111111",
      template: "Oi {{nome}}, cuide-se bem.",
      quando_ha_compromisso: "nao_enviar",
    });
  });

  it("⭐ escolher `enviar` grava exatamente esse valor, mantendo o resto do config", async () => {
    montar(REGRA_DO_POS);

    escolher(ENVIAR);
    const payload = await salvar();

    expect(payload.actions[0]!.config).toEqual({
      channel_session_id: "3f1c9d2e-1111-4a11-8b11-111111111111",
      template: "Oi {{nome}}, cuide-se bem.",
      quando_ha_compromisso: "enviar",
    });
  });

  it("⭐ voltar para `adiar` não deixa a chave no config (o padrão é a ausência dela)", async () => {
    // O editor só grava o que a pessoa ESCOLHEU. `adiar` é o padrão da leitura
    // tolerante (`lerEscolhaNoEnvio`), então a chave some — foi assim que a
    // regra estava antes de alguém abrir a gaveta, e é o que mantém o payload
    // byte a byte igual ao de uma regra de antes desta entrega.
    montar(REGRA_DO_POS);

    escolher(NAO_ENVIAR);
    escolher(AVISO);
    const payload = await salvar();

    const config = payload.actions[0]!.config;
    expect(
      "quando_ha_compromisso" in config,
      "voltar para o padrão deixou a chave gravada — o padrão declarado é a AUSÊNCIA dela",
    ).toBe(false);
    expect(config).toEqual({
      channel_session_id: "3f1c9d2e-1111-4a11-8b11-111111111111",
      template: "Oi {{nome}}, cuide-se bem.",
    });
  });
});

describe("a regra que nunca configurou abre como `adiar`", () => {
  it("⭐ regra sem a chave mostra `adiar` selecionado", () => {
    montar(REGRA_DO_POS);

    expect(
      screen.getByRole("radio", { name: new RegExp(AVISO) }),
      "a regra legada abriu com outra opção marcada — quem nunca configurou tem que ver o comportamento que já tem",
    ).toBeChecked();
    expect(screen.getByRole("radio", { name: new RegExp(ENVIAR) })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: new RegExp(NAO_ENVIAR) })).not.toBeChecked();
  });

  it("⭐ abrir e salvar sem mexer na escolha NÃO inventa a chave", async () => {
    montar(REGRA_DO_POS);

    const payload = await salvar();

    expect(
      "quando_ha_compromisso" in payload.actions[0]!.config,
      "salvar sem escolher gravou uma escolha que ninguém fez",
    ).toBe(false);
    expect(payload.actions[0]!.config).toEqual({
      channel_session_id: "3f1c9d2e-1111-4a11-8b11-111111111111",
      template: "Oi {{nome}}, cuide-se bem.",
    });
  });

  it("regra que JÁ tem a escolha abre com ela marcada (não volta para o padrão)", () => {
    montar({
      ...REGRA_DO_POS,
      actions: [
        {
          type: "send_whatsapp_message",
          config: {
            channel_session_id: "3f1c9d2e-1111-4a11-8b11-111111111111",
            template: "Oi {{nome}}, cuide-se bem.",
            quando_ha_compromisso: "nao_enviar",
          },
        },
      ],
    });

    expect(screen.getByRole("radio", { name: new RegExp(NAO_ENVIAR) })).toBeChecked();
    expect(screen.getByRole("radio", { name: new RegExp(AVISO) })).not.toBeChecked();
  });
});

describe("a escolha também vale na mensagem escrita pela IA", () => {
  const REGRA_DA_IA: AutomationRuleRow = {
    ...REGRA_DO_POS,
    name: "Boas-vindas escritas pela IA",
    trigger_event: "lead.created",
    actions: [
      {
        type: "send_ai_message",
        config: { agent_id: "4a2d8e3f-2222-4b22-9c22-222222222222", channel_session_id: "3f1c9d2e-1111-4a11-8b11-111111111111", instruction: "Cumprimente." },
      },
    ],
    trigger_config: { webhook_source_id: null, uma_vez_por_contato: false },
  };

  it("⭐ o passo da IA tem o mesmo grupo e grava no config dele", async () => {
    montar(REGRA_DA_IA);

    expect(screen.getByRole("radiogroup", { name: ROTULO_DO_GRUPO })).toBeInTheDocument();
    escolher(ENVIAR);
    const payload = await salvar();

    expect(payload.actions[0]!.config).toEqual({
      agent_id: "4a2d8e3f-2222-4b22-9c22-222222222222",
      channel_session_id: "3f1c9d2e-1111-4a11-8b11-111111111111",
      instruction: "Cumprimente.",
      quando_ha_compromisso: "enviar",
    });
  });
});
