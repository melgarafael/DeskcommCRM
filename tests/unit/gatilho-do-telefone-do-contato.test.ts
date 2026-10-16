import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2812 (SEGUNDA METADE) — O GATILHO `contact.phone_added` E A ORDEM DOS EFEITOS.
 *
 * O que este arquivo prova, e por quê:
 *
 *  1. DOIS SENTIDOS da transição. A ficha que estava SEM número e ganha um emite
 *     `contact.phone_added` UMA vez; quem JÁ tinha número (troca) e quem PERDE o
 *     número não emitem nada. Sem o segundo lado, um evento disparado em toda
 *     edição de ficha encheria a fila de automação com o que não aconteceu — e
 *     passaria no teste do primeiro lado.
 *  2. A ORDEM. O evento sai DEPOIS do UPDATE que grava o número. A regra que ele
 *     dispara lê a ficha para decidir, e `checarGuardasDeContato` mata com
 *     `no_phone` (SEM nova tentativa) quem chega sem número: emitir antes da
 *     gravação entrega à regra um contato ainda vazio, e o defeito é MUDO — a
 *     regra some sem erro, sem log e sem run.
 *  3. A REGRESSÃO do caminho antigo: contato SEM telefone continua `no_phone`, e
 *     a linha DEPOIS da gravação passa a guarda (é o que a regra do gatilho novo
 *     enxerga).
 *
 * Por que aqui e não num invariante de banco: é a lógica de DECISÃO do handler
 * (o que ele manda emitir, e em que ordem), exercitável com um client de mentira
 * — o mesmo molde de `tests/unit/contato-audit-from-to.test.ts`.
 */

const auditSpy = vi.fn(async (_e: unknown) => undefined);
vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

/** Ordem GLOBAL das escritas observadas: o UPDATE e o emit caem aqui na sequência. */
let ordem: string[];
/** Cada `emit_event` que o handler mandou, com o payload — o que se afirma aqui. */
let emitidos: Array<Record<string, unknown>>;

const adminFalso = {
  rpc: (fn: string, args: Record<string, unknown>) => {
    expect(fn).toBe("emit_event");
    ordem.push("emit:" + String(args.p_event_type));
    emitidos.push(args);
    return { then: (r: (v: unknown) => unknown) => r({ error: null }) };
  },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminFalso,
}));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";
const USUARIO = "c05e7a00-0000-4000-8000-0000000000a1";

/** O contato como ele está no banco ANTES do PATCH. */
let estadoAtual: Record<string, unknown>;

/**
 * Client de mentira, do tamanho exato do que `patchContactHandler` usa: um SELECT
 * de pré-condição, um UPDATE com retorno, e `rpc` para o `contact.updated`.
 * `createAdminClient()` é o outro client (o `contact.phone_added`), mockado acima.
 */
function clienteFalso(): unknown {
  return {
    from: () => ({
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({ data: estadoAtual, error: null }),
        };
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          select: () => chain,
          maybeSingle: async () => {
            ordem.push("update:contacts");
            return { data: { ...estadoAtual, ...patch }, error: null };
          },
        };
        return chain;
      },
    }),
    rpc: (_fn: string, args: Record<string, unknown>) => {
      ordem.push("emit:" + String(args.p_event_type));
      emitidos.push(args);
      return { then: (r: (v: unknown) => unknown) => r({ error: null }) };
    },
  };
}

async function patch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
  const atualizado = await patchContactHandler(
    clienteFalso() as never,
    { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" },
    CONTATO,
    input as never,
  );
  // A linha COMO FICOU no banco (o UPDATE devolve `{...estadoAtual, ...patch}`) —
  // é ela que a regra do gatilho lê depois do evento.
  return atualizado as unknown as Record<string, unknown>;
}

/** Os eventos de telefone emitidos, na ordem. */
const telefoneEmitidos = () =>
  emitidos.filter((e) => e.p_event_type === "contact.phone_added");

beforeEach(() => {
  auditSpy.mockClear();
  ordem = [];
  emitidos = [];
  estadoAtual = {
    id: CONTATO,
    organization_id: ORG,
    is_anonymized: false,
    tags: [],
    email: "cliente@exemplo.com",
    phone_number: null,
    name: "Cliente",
    display_name: "Cliente",
    consent: {},
  };
});

describe("contact.phone_added — os dois sentidos da transição", () => {
  it("o instrumento está vivo — sem isto, todo caso abaixo passa medindo nada", async () => {
    // Controle positivo: a transição que DEVE emitir produz ao menos um evento.
    await patch({ phone_number: "+5511988887777" });
    expect(telefoneEmitidos().length, "nenhum emit foi observado").toBeGreaterThan(0);
  });

  it("⭐ ficha SEM número que ganha um → emite UMA vez, com o telefone no payload", async () => {
    await patch({ phone_number: "+5511988887777" });

    const eventos = telefoneEmitidos();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      p_event_type: "contact.phone_added",
      p_entity_kind: "contact",
      p_entity_id: CONTATO,
      p_payload: { phone_number: "+5511988887777" },
      p_organization_id: ORG,
    });
  });

  it("contato que JÁ tinha número (troca) → NADA sai", async () => {
    estadoAtual.phone_number = "+5511900000000";
    await patch({ phone_number: "+5511988887777" });
    expect(telefoneEmitidos()).toHaveLength(0);
  });

  it("contato que PERDE o número → NADA sai", async () => {
    estadoAtual.phone_number = "+5511900000000";
    await patch({ phone_number: null });
    expect(telefoneEmitidos()).toHaveLength(0);
  });

  it("edição que não toca o telefone → NADA sai", async () => {
    await patch({ name: "Outro nome" });
    expect(telefoneEmitidos()).toHaveLength(0);
  });
});

describe("contact.phone_added — a ORDEM dos efeitos", () => {
  it("⭐ o evento sai DEPOIS do UPDATE que grava o número", async () => {
    await patch({ phone_number: "+5511988887777" });

    expect(ordem).toContain("update:contacts");
    expect(ordem).toContain("emit:contact.phone_added");
    expect(
      ordem.indexOf("update:contacts"),
      "o emit de telefone veio ANTES da gravação — a regra leria a ficha ainda sem o número",
    ).toBeLessThan(ordem.indexOf("emit:contact.phone_added"));
  });
});

describe("a regra do gatilho novo enxerga o telefone recém-gravado (guarda-do-contato)", () => {
  it("⭐ a linha DEPOIS da gravação passa a guarda — a regra vê o telefone", async () => {
    const depois = await patch({ phone_number: "+5511988887777" });
    const { checarGuardasDeContato } = await import("@/lib/automation/guarda-do-contato");

    const r = checarGuardasDeContato({
      admin: {} as never,
      organizationId: ORG,
      ruleId: "rule-1",
      ruleName: "continuar no whatsapp",
      event: {} as never,
      context: { contact: { id: CONTATO, phone_number: depois.phone_number } },
      requestId: "req-1",
    });

    expect(r).toEqual({ ok: true, contact: { id: CONTATO, phone_number: "+5511988887777" } });
  });

  it("regressão: contato SEM telefone continua `no_phone` (o caminho antigo não mudou)", async () => {
    const { checarGuardasDeContato } = await import("@/lib/automation/guarda-do-contato");

    const r = checarGuardasDeContato({
      admin: {} as never,
      organizationId: ORG,
      ruleId: "rule-1",
      ruleName: "continuar no whatsapp",
      event: {} as never,
      context: { contact: { id: CONTATO, phone_number: null } },
      requestId: "req-1",
    });

    expect(r).toEqual({ ok: false, reason: "no_phone" });
  });
});
