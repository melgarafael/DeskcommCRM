/**
 * AS VARIÁVEIS DE UM MODELO APROVADO, QUANDO QUEM ENVIA É UM FLUXO.
 *
 * O passo "modelo de mensagem" só mandava modelo sem variável — uma loja com
 * dez produtos precisava de dez modelos e dez ramos. Agora o passo guarda DE
 * ONDE sai cada `{{n}}` (nome do contato, campo do negócio) e o envio resolve na
 * hora (`lib/channels/meta/variaveis-do-fluxo.ts`).
 *
 * Este arquivo prende as três pontas que não são o envio em si (esse está em
 * `fluxo-envia-modelo-aprovado.test.ts`):
 *   1. a resolução pura: o que vira valor e o que recusa o passo;
 *   2. o grafo aceita o mapa e recusa mapa mal formado;
 *   3. o motor leva o mapa do nó até o pedido de envio.
 */
import { describe, expect, it, vi } from "vitest";

import type { TemplateContract } from "@/lib/channels/meta/template-contract";
import {
  resolverVariaveisDoModelo,
  type DadosParaVariaveis,
} from "@/lib/channels/meta/variaveis-do-fluxo";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "@/lib/followup/engine";
import { actionConfigSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";

function contrato(slots: TemplateContract["slots"]): TemplateContract {
  return { name: "pedido_web", language: "es", parameterFormat: "POSITIONAL", slots };
}
const corpo = (key: string) => ({
  address: { kind: "body" as const },
  key,
  expects: "text" as const,
  contextBefore: "",
  contextAfter: "",
});
const DADOS: DadosParaVariaveis = {
  nomeDoContato: "Maria José Pereira",
  camposDoNegocio: { produto_nome: "Cafeteira Elétrica", precio: 18990, vacio: "   " },
};

describe("1. resolução das variáveis", () => {
  it("⭐ primeiro nome, nome completo, campo de texto e campo numérico", () => {
    const r = resolverVariaveisDoModelo(
      contrato([corpo("1"), corpo("2"), corpo("3"), corpo("4")]),
      {
        "1": { kind: "contact_first_name" },
        "2": { kind: "contact_name" },
        "3": { kind: "lead_custom", key: "produto_nome" },
        "4": { kind: "lead_custom", key: "precio" },
      },
      DADOS,
    );
    expect(r).toEqual({
      ok: true,
      values: {
        "1": "Maria",
        "2": "Maria José Pereira",
        "3": "Cafeteira Elétrica",
        "4": "18990",
      },
    });
  });

  it("modelo sem variável: valores vazios, como sempre foi", () => {
    expect(resolverVariaveisDoModelo(contrato([]), undefined, DADOS)).toEqual({
      ok: true,
      values: {},
    });
  });

  it("variável sem origem, origem vazia e campo inexistente: recusa, nomeando cada uma", () => {
    const r = resolverVariaveisDoModelo(
      contrato([corpo("1"), corpo("2"), corpo("3")]),
      { "2": { kind: "lead_custom", key: "vacio" }, "3": { kind: "lead_custom", key: "ciudad" } },
      DADOS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problemas).toEqual([
      "{{1}} sem origem escolhida no passo",
      '{{2}} vazio neste contato (campo "vacio" do negócio)',
      '{{3}} vazio neste contato (campo "ciudad" do negócio)',
    ]);
  });

  it("variável que não é texto (imagem do cabeçalho) recusa: contato e negócio não têm imagem", () => {
    const r = resolverVariaveisDoModelo(
      contrato([
        {
          address: { kind: "header" },
          key: "1",
          expects: "image",
          contextBefore: "",
          contextAfter: "",
        },
      ]),
      { "header:1": { kind: "contact_name" } },
      DADOS,
    );
    expect(r).toEqual({
      ok: false,
      problemas: ["{{1}} do cabeçalho não é texto, e o fluxo só preenche texto"],
    });
  });

  it("nome que é só telefone não vira saudação", () => {
    const r = resolverVariaveisDoModelo(
      contrato([corpo("1")]),
      { "1": { kind: "contact_first_name" } },
      {
        nomeDoContato: "+55 11 98765-4321",
        camposDoNegocio: {},
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("2. o grafo guarda o mapa", () => {
  it("aceita o passo de modelo com o mapa de variáveis", () => {
    const r = actionConfigSchema.safeParse({
      mode: "template",
      template_id: "22222222-2222-4222-8222-222222222222",
      template_values: {
        "1": { kind: "contact_first_name" },
        "2": { kind: "lead_custom", key: "produto_nome" },
      },
    });
    expect(r.success).toBe(true);
  });

  it("recusa chave de campo inválida e origem desconhecida", () => {
    const base = { mode: "template", template_id: "22222222-2222-4222-8222-222222222222" };
    expect(
      actionConfigSchema.safeParse({
        ...base,
        template_values: { "1": { kind: "lead_custom", key: "1x; drop" } },
      }).success,
    ).toBe(false);
    expect(
      actionConfigSchema.safeParse({ ...base, template_values: { "1": { kind: "telefone" } } })
        .success,
    ).toBe(false);
  });

  it("o mapa só existe no modo modelo: nos outros modos a chave é recusada", () => {
    expect(
      actionConfigSchema.safeParse({
        mode: "text",
        body: "oi",
        template_values: { "1": { kind: "contact_name" } },
      }).success,
    ).toBe(false);
  });
});

describe("3. o motor leva o mapa do nó até o pedido de envio", () => {
  const NOW = new Date("2026-10-02T12:00:00.000Z");
  const MAPA = {
    "1": { kind: "contact_first_name" },
    "2": { kind: "lead_custom", key: "produto_nome" },
  } as const;

  const enrollment: EnrollmentRow = {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: null,
    current_node_id: "conf",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 1,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
  };

  it("⭐ o passo de modelo com mapa pede o envio levando o mapa", async () => {
    const grafo = {
      nodes: [
        {
          id: "conf",
          type: "action",
          config: {
            mode: "template",
            template_id: "22222222-2222-4222-8222-222222222222",
            template_values: MAPA,
          },
        },
        { id: "fim", type: "end", config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "e1", source: "conf", target: "fim", priority: 0, condition: { type: "always" } },
      ],
    } as unknown as FlowGraph;
    const base = {
      loadFlowGraph: vi.fn(async () => grafo),
      loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
      loadEnrollmentEvents: vi.fn(async () => []),
      insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    } as Record<string, unknown>;
    const db = new Proxy(base, {
      get: (alvo, chave) => alvo[chave as string] ?? (async () => null),
    }) as unknown as AdminClient;
    const enqueueJob = vi.fn(async (_req: unknown) => {});
    const deps = { db, clock: () => NOW, enqueueJob } as unknown as TickDeps;

    await avancarEnrollmentAtivo(deps, enrollment);

    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const pedido = enqueueJob.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(pedido.payload.template_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(pedido.payload.template_values).toEqual(MAPA);
  });
});
