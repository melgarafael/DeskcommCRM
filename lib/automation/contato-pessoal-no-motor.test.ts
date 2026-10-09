// @vitest-environment node
/**
 * O motor de automação não roda regra para contato pessoal — inclusive quando o
 * contato chega pela ENTIDADE do evento, e não pelo payload (spec 21, caminho 8).
 *
 * O pré-check `eventoEhDeContatoPessoal` só acha o contato por
 * `payload.contact_id` ou `payload.conversation_id`. O aniversário
 * (`contact.birthday`, emitido pelo cron `contact-birthday`) traz o contato em
 * `entity_id` e o payload só com `local_date`: sem a guarda sobre o contexto
 * hidratado, uma regra com webhook mandaria para fora os dados de quem foi
 * marcado como pessoal.
 *
 * O banco é um dublê mínimo; a ação é um executor registrado no lugar do
 * `call_webhook` que só conta chamadas. O caso de controle (contato comum)
 * prova que o dublê alcança a ação — sem ele, "não chamou" seria vazio.
 *
 *     pnpm vitest run lib/automation/contato-pessoal-no-motor.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { registerAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const REGRA = "77777777-7777-4777-8777-777777777701";

const chamadas: unknown[] = [];
registerAction({
  type: "call_webhook",
  async execute(ctx) {
    chamadas.push(ctx.context.contact);
    return { type: "call_webhook", status: "success" };
  },
});

type Linha = Record<string, unknown>;

/** O recorte do PostgREST que o motor usa: select/eq/order/insert/update/maybeSingle. */
function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  function consulta(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    const linhas = () =>
      (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
    const q = {
      select: () => q,
      insert: () => q,
      update: () => q,
      order: () => q,
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? { id: "run-1" }, error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(ok),
    };
    return q;
  }
  return { from: consulta } as unknown as SupabaseClient;
}

function aniversario(): EventRow {
  return {
    id: "evt-1",
    organization_id: ORG,
    event_type: "contact.birthday",
    entity_kind: "contact",
    entity_id: CONTATO,
    payload: { local_date: "2026-10-06" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function mundo(isPersonal: boolean): SupabaseClient {
  return bancoFalso({
    contacts: [{ id: CONTATO, organization_id: ORG, name: "Mãe", is_personal: isPersonal }],
    automation_rules: [
      {
        id: REGRA,
        organization_id: ORG,
        trigger_event: "contact.birthday",
        is_active: true,
        name: "Parabéns por webhook",
        conditions: [],
        actions: [{ type: "call_webhook", config: { url: "https://exemplo.test/hook" } }],
      },
    ],
  });
}

describe("motor de automação × contato pessoal pela entidade do evento", () => {
  it("controle: aniversário de contato comum chega à ação", async () => {
    chamadas.length = 0;
    const r = await runAutomationForEvent(mundo(false), aniversario());
    expect(r.status).toBe("ok");
    expect(chamadas).toHaveLength(1);
  });

  it("aniversário de contato pessoal: skipped/contato_pessoal e nenhuma ação", async () => {
    chamadas.length = 0;
    const r = await runAutomationForEvent(mundo(true), aniversario());
    expect(r).toMatchObject({ status: "skipped", detail: "contato_pessoal" });
    expect(chamadas).toHaveLength(0);
  });
});
