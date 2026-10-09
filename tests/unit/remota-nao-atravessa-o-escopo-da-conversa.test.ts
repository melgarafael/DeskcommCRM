// @vitest-environment node
/**
 * O item 8 do desenho (#2147) — DURANTE UMA CONVERSA SÓ ENTRA LEITURA DE
 * VERDADE —, em três camadas que se defendem:
 *
 *  1. CLASSIFICAÇÃO: uma remota só é `read` quando o servidor anuncia
 *     `annotations.readOnlyHint === true` E quem administra marcou a ferramenta
 *     como leitura na escolha do agente (item 6). O resto é `write`.
 *  2. ESCOPO: uma remota de ESCRITA que chegue montada a um turno com contato
 *     passa POR `escritaCabeNoTurno` e é recusada com
 *     `escrita_sem_escopo_do_turno` — a regra da main (382f3c790), não uma
 *     variante dela. Classificá-la como `read` seria atravessá-la.
 *  3. ESCOLHA (b): até existir identificação forçada do contato na chamada ao
 *     servidor remoto, `carregarServidorMcpExterno` não carrega servidor para
 *     turno com contato — nenhum turno de conversa, Conversador ou Operador.
 *
 * As três têm de estar de pé ao mesmo tempo: a 3 fecha o risco sem protocolo
 * novo no servidor alheio, a 2 garante que uma remota malclassificada não passa
 * se a 3 falhar, e a 1 é o que permite a 2 acontecer (hoje toda remota saía
 * como `read` e passava por fora da conferência).
 */
import { describe, expect, it, vi } from "vitest";

// A auditoria é observada, não sussurrada — e aqui ela só atrapalharia o
// arranjo (o recuso é devolvido ao modelo, não ao log).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import { carregarServidorMcpExterno } from "@/lib/mcp/servidor-externo/carregar";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import type { ServidorMcpExterno } from "@/lib/mcp/servidor-externo/registro";
import { definirFerramentasRemotas } from "@/lib/mcp/tools/externo";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const CONTATO = "11111111-1111-4111-8111-111111111111";
const SERVIDOR: ServidorMcpExterno = { endpoint: "https://erp.loja/mcp", chave: "segredo" };

const FERRAMENTAS: FerramentaRemota[] = [
  // Anuncia leitura de verdade.
  { name: "erp_consultar_pedido", somenteLeitura: true },
  // MENTE sobre si mesma: declara leitura e é uma cancelação.
  { name: "erp_cancelar_pedido", somenteLeitura: true },
  // Não declara nada — ausência de `readOnlyHint` é "não declarado", não "é leitura".
  { name: "erp_faturar_pedido" },
];

const OCUPADAS = new Set<string>(["crm_search_products"]);

const auth = {
  organizationId: ORG,
  role: "ai_operator",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function supabaseDeMentira() {
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
  };
  const chamadas: string[] = [];
  return { chamadas, cliente: { from: (tabela: string) => (chamadas.push(tabela), cadeia) } as never };
}

function contexto(supabase: unknown): McpContext {
  return {
    organizationId: ORG,
    role: auth.role,
    actor: auth.actor,
    apiTokenId: auth.apiTokenId,
    requestId: "3f7c1e50-0000-4000-8800-000000000484",
    supabase,
  } as unknown as McpContext;
}

function montar(opts: {
  escolha: string;
  contato?: string;
  ferramentas?: FerramentaRemota[];
}) {
  const supabase = supabaseDeMentira();
  return pickToolsFromMcp({
    supabase: supabase.cliente,
    ctx: contexto(supabase.cliente),
    auth,
    toolIds: [opts.escolha],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(opts.contato ? { contatoDoTurno: opts.contato } : {}),
    servidorMcpExterno: {
      servidor: SERVIDOR,
      ferramentas: opts.ferramentas ?? FERRAMENTAS,
    },
  });
}

// ─── 1. Classificação ────────────────────────────────────────────────────────

describe("uma remota só conta como leitura com as DUAS metades (item 8)", () => {
  function categoria(nome: string, leitura: boolean): string {
    const [def] = definirFerramentasRemotas(
      SERVIDOR,
      FERRAMENTAS,
      OCUPADAS,
      [{ nome, leitura }],
    );
    return def!.category;
  }

  it("anunciada `readOnlyHint: true` E marcada como leitura → leitura", () => {
    expect(categoria("erp_consultar_pedido", true)).toBe("read");
  });

  it("declarada como leitura mas marcada como ESCRITA pelo administrador → escrita", () => {
    expect(categoria("erp_cancelar_pedido", false)).toBe("write");
  });

  it("marcada como leitura mas SEM declarar `readOnlyHint` → escrita", () => {
    expect(categoria("erp_faturar_pedido", true)).toBe("write");
  });

  it("o escopo acompanha a categoria: escrita remota pede `mcp:write`", () => {
    const [leitura] = definirFerramentasRemotas(SERVIDOR, FERRAMENTAS, OCUPADAS, [
      { nome: "erp_consultar_pedido", leitura: true },
    ]);
    const [escrita] = definirFerramentasRemotas(SERVIDOR, FERRAMENTAS, OCUPADAS, [
      { nome: "erp_cancelar_pedido", leitura: false },
    ]);
    expect(leitura!.requiresScope).toBe("mcp:read");
    expect(escrita!.requiresScope).toBe("mcp:write");
  });
});

// ─── 2. A regra da conversa ──────────────────────────────────────────────────

describe("remota classificada como escrita cai na conferência de escopo do turno", () => {
  it("recusa com `escrita_sem_escopo_do_turno` — passa POR ela, não por fora", async () => {
    const montadas = montar({ escolha: toolIdRemoto("erp_cancelar_pedido", "escrita"), contato: CONTATO });
    const ferramenta = montadas.erp_cancelar_pedido as unknown as {
      execute: (a: unknown) => Promise<unknown>;
    };
    expect(ferramenta).toBeDefined();

    const resposta = await ferramenta.execute({ pedido_id: "1" });
    expect(resposta).toMatchObject({
      permitido: false,
      motivo: "escrita_sem_escopo_do_turno",
    });
  });

  it("o mesmo vale para a remota marcada como leitura mas não declarada", async () => {
    const montadas = montar({ escolha: toolIdRemoto("erp_faturar_pedido", "leitura"), contato: CONTATO });
    const ferramenta = montadas.erp_faturar_pedido as unknown as {
      execute: (a: unknown) => Promise<unknown>;
    };
    expect(await ferramenta.execute({ pedido_id: "1" })).toMatchObject({
      permitido: false,
      motivo: "escrita_sem_escopo_do_turno",
    });
  });

  it("a leitura de verdade NÃO é recusada pela conferência de escrita (controle)", async () => {
    // Sem contato não há conferência nenhuma — é o turno de agente sem
    // conversa, onde a remota legítima tem de funcionar.
    const montadas = montar({ escolha: toolIdRemoto("erp_consultar_pedido", "leitura") });
    expect(montadas.erp_consultar_pedido).toBeDefined();
    const [def] = definirFerramentasRemotas(SERVIDOR, FERRAMENTAS, OCUPADAS, [
      { nome: "erp_consultar_pedido", leitura: true },
    ]);
    expect(def!.category).toBe("read");
  });

  it("a LEITURA remota não monta em turno com contato, mesmo chegar montada", () => {
    const montadas = montar({ escolha: toolIdRemoto("erp_consultar_pedido", "leitura"), contato: CONTATO });
    expect(montadas.erp_consultar_pedido).toBeUndefined();
  });

  it("sem contato, a mesma leitura remota monta (a recusa não é geral demais)", () => {
    const montadas = montar({ escolha: toolIdRemoto("erp_consultar_pedido", "leitura") });
    expect(montadas.erp_consultar_pedido).toBeDefined();
  });
});

// ─── 3. Escolha (b) na origem ────────────────────────────────────────────────

describe("turno com contato não carrega servidor remoto nenhum (item 8, escolha (b))", () => {
  it("devolve `null` sem tocar em banco e sem abrir rede", async () => {
    const supabase = supabaseDeMentira();
    const montado = await carregarServidorMcpExterno(supabase.cliente, ORG, {
      contatoDoTurno: CONTATO,
    });
    expect(montado).toBeNull();
    expect(supabase.chamadas, "consultou o registro mesmo sem poder usá-lo").toEqual([]);
  });

  it("turno sem contato segue carregando normalmente", async () => {
    const supabase = supabaseDeMentira();
    const montado = await carregarServidorMcpExterno(supabase.cliente, ORG, {});
    // Sem registro em linha nenhuma → `null` do jeito de sempre, mas AQUI a
    // consulta aconteceu: é ela que prova que o guarda é o do contato.
    expect(supabase.chamadas).toEqual(["organizations"]);
    expect(montado).toBeNull();
  });
});
