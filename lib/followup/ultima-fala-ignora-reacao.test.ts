import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { createSupabaseAdminClient } from "@/lib/followup/engine";

/**
 * #2815 — a reação (👍) é uma linha `messages` inbound com `body` nulo. O
 * `loadLastInboundBody` do cron de follow-up lia "a última inbound" sem olhar o
 * `type`, então um 👍 depois de um "SIM" devolvia `null` e o `match_reply` não
 * casava a resposta. O irmão em SQL (`createPgAdminClient`) é medido em banco
 * real em `tests/invariants/reacao-nao-passa-pelos-gatilhos.test.ts`.
 *
 * O fake aplica os filtros que o adaptador encadeia sobre linhas em memória —
 * o que se mede é o resultado, não a lista de chamadas.
 */
type Linha = Record<string, unknown>;

function fakeAdmin(tabelas: Record<string, Linha[]>): SupabaseClient {
  return {
    from(tabela: string) {
      let linhas = [...(tabelas[tabela] ?? [])];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => ((linhas = linhas.filter((l) => l[c] === v)), q),
        neq: (c: string, v: unknown) => ((linhas = linhas.filter((l) => l[c] !== v)), q),
        in: (c: string, vs: unknown[]) => ((linhas = linhas.filter((l) => vs.includes(l[c]))), q),
        is: (c: string, v: unknown) => ((linhas = linhas.filter((l) => (l[c] ?? null) === v)), q),
        gte: (c: string, v: string) => ((linhas = linhas.filter((l) => String(l[c]) >= v)), q),
        order: (c: string, o: { ascending: boolean }) => (
          (linhas = linhas.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (o.ascending ? 1 : -1))), q
        ),
        limit: (n: number) => ((linhas = linhas.slice(0, n)), q),
        maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

describe("createSupabaseAdminClient.loadLastInboundBody", () => {
  it("devolve o SIM, não o 👍 que veio depois", async () => {
    const base = { organization_id: "org-1", contact_id: "c-1", conversation_id: "conv-1", direction: "inbound" };
    const admin = fakeAdmin({
      contacts: [{ id: "c-1", organization_id: "org-1", phone_number: null }],
      messages: [
        { ...base, type: "text", body: "SIM", sent_at: "2026-10-16T10:00:00.000Z" },
        { ...base, type: "reaction", body: null, sent_at: "2026-10-16T10:00:05.000Z" },
      ],
    });

    expect(await createSupabaseAdminClient(admin).loadLastInboundBody("org-1", "c-1", "conv-1")).toBe("SIM");
  });
});
