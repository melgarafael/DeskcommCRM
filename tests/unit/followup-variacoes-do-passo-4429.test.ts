/**
 * #4429 — VARIAÇÕES DE TEXTO NO PASSO DE MENSAGEM.
 *
 * ## O defeito
 *
 * O passo de mensagem (`action` / `mode: "text"`) tem UM texto. Prospecção em
 * massa manda o mesmo corpo para o número inteiro e a trava de repetição
 * (`lib/agent-engine/spinning/engine.ts`), que conta a janela por
 * `channel_session`, veta a partir do 3º envio parecido — o fluxo não tem como
 * variar dentro da trava. O próprio produto já resolve isso em outro lugar
 * (`lib/escalacao/aviso-ao-lead.ts`, variantes por hash) porque "um texto FIXO
 * se veta sozinho".
 *
 * ## O que este arquivo prende
 *
 * 1. **Mesmo passo, redações diferentes em envios seguidos** — duas execuções
 *    consecutivas do passo NUNCA saem com a mesma redação;
 * 2. **Rotação de verdade** — em `n` envios seguidos as três redações saem
 *    todas, não duas (não é alternância de par);
 * 3. **Determinismo** — o mesmo estado (mesma inscrição, mesmos envios já
 *    feitos) devolve SEMPRE a mesma redação: re-tentar um job não troca a
 *    frase debaixo do cliente;
 * 4. **Retrocompatibilidade** — passo com texto único (sem `variacoes`) sai
 *    exatamente como hoje, byte a byte;
 * 5. **Leads diferentes não começam todos na mesma frase** — a primeira
 *    redação de cada contato sai do hash do contato.
 *
 * ## O que NÃO prova
 *
 * Nada com Postgres real: a escolha é do motor, no enfileiramento
 * (`lib/followup/engine.ts`), e é isso que o `enqueueJob` falso captura. Que a
 * trava de repetição aceite o texto escolhido (menor Jaccard na janela,
 * reagendamento) é decisão de produto da issue e NÃO entra nesta fatia.
 */
import { describe, expect, it, vi } from "vitest";

import type { FlowGraph } from "@/lib/followup/graph-schema";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "@/lib/followup/engine";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";

const NOW = new Date("2026-11-11T13:00:00.000Z");
const ORG = "org-1";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));

const BODY = "Oi {{primeiro_nome}}, separamos uma condição especial para você.";
const VARIACOES = [
  "{{primeiro_nome}}, separei uma condição especial e queria te contar.",
  "Falei com o time e reservei uma condição especial para você, {{primeiro_nome}}.",
];

function grafo(config: Record<string, unknown>): FlowGraph {
  return {
    nodes: [{ id: "action-1", type: "action", config }],
    edges: [],
  } as unknown as FlowGraph;
}

function enrollment(contactId: string): EnrollmentRow {
  return {
    id: `enr-${contactId}`,
    organization_id: ORG,
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: contactId,
    conversation_id: null,
    current_node_id: "action-1",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 4,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
  };
}

/** O histórico do que JÁ SAIU nesta inscrição: um `action_sent` por mensagem enviada. */
function eventos(envios: number): EnrollmentEventRef[] {
  // Todos de PASSOS ANTERIORES (`action-0`): um `action_sent` no id `action-1`
  // seria lido como "este passo já enviou nesta estadia" e o engine avançaria
  // em vez de enfileirar.
  return Array.from({ length: envios }, (_, i) => ({
    node_id: "action-0",
    idempotency_key: `action-0:${i}`,
    event_type: "action_sent",
    payload: { outcome: "sent" },
  }));
}

const CONTEXTO = {
  contact: { name: "Ana Souza" },
  lead: { custom_fields: {} },
};

/** Enfileira o passo e devolve o `fixed_body` — o texto que os DOIS caminhos de envio mandam. */
async function textoDoPasso(
  config: Record<string, unknown>,
  envios: number,
  contactId = "contact-1",
): Promise<string> {
  const payloads: Array<Record<string, unknown>> = [];
  const db = {
    loadFlowGraph: vi.fn(async () => grafo(config)),
    loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
    loadRenderContext: vi.fn(async () => CONTEXTO),
    loadEnrollmentEvents: vi.fn(async () => eventos(envios)),
    loadLastInboundBody: vi.fn(async () => null),
    loadFlowPointerName: vi.fn(async () => null),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    updateEnrollment: vi.fn(async () => {}),
  } as unknown as AdminClient;
  const deps: TickDeps = {
    db,
    clock: () => NOW,
    enqueueJob: async (job) => {
      payloads.push(job.payload as unknown as Record<string, unknown>);
    },
  };
  await avancarEnrollmentAtivo(deps, enrollment(contactId));
  expect(payloads).toHaveLength(1);
  const body = payloads[0]!.fixed_body;
  expect(typeof body).toBe("string");
  return body as string;
}

describe("#4429 — variações no passo de mensagem do follow-up", () => {
  const passo = { mode: "text", body: BODY, variacoes: VARIACOES };

  it("⭐ envios SEGUIDOS do mesmo passo não repetem a mesma redação", async () => {
    const primeiro = await textoDoPasso(passo, 0);
    const segundo = await textoDoPasso(passo, 1);
    const terceiro = await textoDoPasso(passo, 2);

    expect(segundo).not.toBe(primeiro);
    expect(terceiro).not.toBe(segundo);
    expect(terceiro).not.toBe(primeiro);
  });

  it("⭐ a rotação passa por TODAS as redações — não é alternância de duas", async () => {
    const vistos = new Set<string>();
    for (let envios = 0; envios < 6; envios++) vistos.add(await textoDoPasso(passo, envios));

    expect(vistos.size).toBe(3);
  });

  it("as redações saem RENDERIZADAS: o `{{primeiro_nome}}` vira o nome em todas", async () => {
    for (let envios = 0; envios < 3; envios++) {
      const texto = await textoDoPasso(passo, envios);
      expect(texto).toContain("Ana");
      expect(texto).not.toContain("{{");
    }
  });

  it("⭐ o mesmo estado devolve a MESMA redação — re-tentar um job não troca a frase", async () => {
    for (let envios = 0; envios < 3; envios++) {
      expect(await textoDoPasso(passo, envios)).toBe(await textoDoPasso(passo, envios));
    }
  });

  it("⭐ RETROCOMPATÍVEL: passo com texto único sai exatamente como hoje", async () => {
    expect(await textoDoPasso({ mode: "text", body: BODY }, 0)).toBe(
      "Oi Ana, separamos uma condição especial para você.",
    );
    // E o mesmo texto, com histórico de envios, também não muda: sem variação não
    // existe rotação para girar.
    expect(await textoDoPasso({ mode: "text", body: BODY }, 5)).toBe(
      "Oi Ana, separamos uma condição especial para você.",
    );
  });

  it("contatos diferentes não começam todos na mesma redação", async () => {
    const primeiras = new Set<string>();
    for (let i = 0; i < 9; i++) primeiras.add(await textoDoPasso(passo, 0, `contact-${i}`));

    expect(primeiras.size).toBeGreaterThan(1);
  });
});
