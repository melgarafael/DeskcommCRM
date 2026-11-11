import { ptBR } from "date-fns/locale";
import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { esperaDaConversa, rotuloDaEspera } from "@/lib/inbox/comando-da-conversa";
import { getQueuePositions } from "@/lib/routing/queue";

/**
 * AS TRÊS PONTAS DA ESPERA, NA MESMA CONTA (issue #990).
 *
 * A issue não pede só que a Fila ordene certo: pede que a POSIÇÃO, o texto
 * "Aguardando há…" da linha e o campo que as ferramentas de IA devolvem saiam da
 * MESMA régua. São três superfícies diferentes, mantidas por três arquivos
 * diferentes, e é por isso que a divergência entre elas nunca ficou vermelha:
 *
 *   1. a ORDEM chega ao PostgREST como `.order(ORDEM_DA_ESPERA.coluna)` —
 *      `app/api/v1/conversations/_handler.ts` (a aba Fila);
 *   2. o TEXTO da linha nasce de `esperaDaConversa` + o formatador da pílula
 *      (`components/inbox/ConversationListItem.tsx`, `rotuloDaEspera`);
 *   3. o NÚMERO que a IA fala nasce de `getQueuePositions`
 *      (`lib/routing/queue.ts`, consumido por `crm_list_conversations` em
 *      `lib/mcp/tools/conversations.ts` e, no handoff, por `getQueuePosition`).
 *
 * Um teste por superfície não prova concordância nenhuma: cada um passaria com a
 * sua própria régua, que é exatamente o estado em que a #990 foi relatada (a
 * lista ordenada por uma pergunta, a linha dizendo outra, a IA contando uma
 * terceira). Aqui as três rodam sobre a MESMA fixture, no MESMO caso, e as três
 * asserções ficam no mesmo `it` de propósito: separá-las reabriria a porta para
 * "consertar" uma e deixar as outras duas verdes.
 *
 * ─── O cenário é o do relator ───────────────────────────────────────────────
 * A escreve 10h00. B escreve 10h05. A, sem resposta, insiste às 10h10.
 * `awaiting_since` de A é 10h00 (a mensagem mais antiga sem resposta) enquanto
 * `last_inbound_at` de A é 10h10 — se qualquer uma das três pontas voltar a ler
 * `last_inbound_at`, ela passa a discordar das outras duas, e o caso fica
 * vermelho pela razão certa.
 *
 * ─── O que este arquivo NÃO mede ────────────────────────────────────────────
 * O SQL do gatilho que mantém `awaiting_since` (migration 0267): isso exige
 * Postgres e é medido em `tests/invariants/fila-espera-nao-recomeca.test.ts`.
 * Aqui o valor chega pronto na linha, como chega do banco para a rota, e o que
 * se mede é o CONSUMO dele nas três pontas.
 */

const T = (hhmm: string): string => `2026-09-16T${hhmm}:00.000Z`;
/** O instante da leitura das três pontas — fixo, para o texto não depender do relógio da máquina. */
const AGORA = new Date(T("10:20"));

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

/**
 * Dublê de supabase que ORDENA de verdade pela coluna pedida — como o PostgREST
 * faria. Sem isto, o teste mediria o dublê: a rota poderia pedir `last_inbound_at`
 * e a lista sair na ordem da fixture (que já está certa), verde por acidente.
 *
 * Tabelas servidas: `conversations` (a fixture), `ai_agents` (vazio → a org não
 * tem automático, que é o caso simples da Fila) e as demais devolvem lista vazia
 * — `contacts` (pessoais) e `channel_sessions` (desativados) são filtros da rota
 * que não participam da régua.
 */
function fakeSupabase(linhas: Array<Record<string, unknown>>) {
  const client = {
    from: (tabela: string) => {
      let resultado: Array<Record<string, unknown>> =
        tabela === "conversations" ? [...linhas] : [];
      let teto = Number.POSITIVE_INFINITY;
      const ordens: Array<{ coluna: string; opcoes?: { ascending?: boolean; nullsFirst?: boolean } }> = [];

      const aplicar = (): Array<Record<string, unknown>> => {
        const ordenadas = [...resultado];
        for (const ordem of [...ordens].reverse()) {
          const { coluna, opcoes } = ordem;
          const sinal = opcoes?.ascending ? 1 : -1;
          const nullsFirst = opcoes?.nullsFirst ?? false;
          ordenadas.sort((x, y) => {
            const a = x[coluna];
            const b = y[coluna];
            if (a === b) return 0;
            if (a === null || a === undefined) return nullsFirst ? -1 : 1;
            if (b === null || b === undefined) return nullsFirst ? 1 : -1;
            return (a as string) < (b as string) ? -sinal : sinal;
          });
        }
        return ordenadas;
      };

      const cadeia: Record<string, unknown> = new Proxy(
        {},
        {
          get(_alvo, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) =>
                ok({ data: aplicar().slice(0, teto), error: null, count: aplicar().length });
            }
            return (...args: unknown[]) => {
              if (prop === "eq") {
                const [coluna, valor] = args as [string, unknown];
                resultado = resultado.filter((r) => r[coluna] === valor);
              } else if (prop === "in") {
                const [coluna, valores] = args as [string, Array<unknown>];
                resultado = resultado.filter((r) => valores.includes(r[coluna]));
              } else if (prop === "not") {
                const [coluna, operador, valor] = args as [string, string, string];
                if (operador === "in") {
                  const proibidos = valor.replace(/[()]/g, "").split(",");
                  resultado = resultado.filter((r) => !proibidos.includes(String(r[coluna])));
                }
              } else if (prop === "order") {
                const [coluna, opcoes] = args as [string, { ascending?: boolean; nullsFirst?: boolean } | undefined];
                ordens.push({ coluna, opcoes });
              } else if (prop === "limit") {
                teto = args[0] as number;
              }
              return cadeia;
            };
          },
        },
      );
      return cadeia;
    },
  };
  return client as never;
}

/** A conversa como a 0267 a deixa: `awaiting_since` no começo da espera. */
function linha(id: string, awaitingSince: string, lastInboundAt: string) {
  return {
    id,
    organization_id: "org-1",
    comando_da_conversa: "aguardando",
    awaiting_since: awaitingSince,
    last_inbound_at: lastInboundAt,
    last_message_at: lastInboundAt,
    last_outbound_at: null,
    created_at: T("09:00"),
  };
}

describe("as três pontas da espera concordam (issue #990)", () => {
  it("⭐ ordem, texto da linha e posição da IA saem da MESMA régua", async () => {
    const client = fakeSupabase([
      // B entrou antes no banco: a ordem não pode vir da inserção.
      linha("conv-b", T("10:05"), T("10:05")),
      // A espera desde 10h00, mas a ÚLTIMA mensagem dele é 10h10 (ele insistiu).
      linha("conv-a", T("10:00"), T("10:10")),
    ]);

    const r = await listConversationsHandler(client, ctx, {
      limit: 50,
      comando: ["aguardando"],
    } as never);

    // ── 1. ORDEM (aba Fila, `_handler.ts`) ──────────────────────────────────
    expect(r.conversations.map((c) => c.id)).toEqual(["conv-a", "conv-b"]);

    const a = r.conversations[0];
    if (a === undefined) throw new Error("a Fila veio vazia");

    // A linha carrega as duas colunas e elas DISCORDAM — é a premissa do caso.
    expect(a.awaiting_since).toBe(T("10:00"));
    expect(a.last_inbound_at).toBe(T("10:10"));

    // ── 2. TEXTO da linha ("Aguardando há…", `ConversationListItem`) ────────
    // A pílula diria "há 10 minutos" se lesse `last_inbound_at` (10h10), e a
    // linha apareceria em 1º dizendo um tempo que a ordem não respeita.
    expect(rotuloDaEspera(esperaDaConversa(a), AGORA, (texto) => texto, ptBR)).toBe(
      "Aguardando há 20 minutos",
    );

    const b = r.conversations[1];
    if (b === undefined) throw new Error("a Fila veio com uma conversa só");
    expect(rotuloDaEspera(esperaDaConversa(b), AGORA, (texto) => texto, ptBR)).toBe(
      "Aguardando há 15 minutos",
    );

    // ── 3. POSIÇÃO devolvida às ferramentas de IA (`lib/routing/queue.ts`) ──
    // É o número de `crm_list_conversations` (`lib/mcp/tools/conversations.ts`)
    // e o que o handoff repassa ao cliente; a contagem inclui ela mesma.
    const posicoes = await getQueuePositions(client, "org-1");
    expect(posicoes.get("conv-a")).toBe(1);
    expect(posicoes.get("conv-b")).toBe(2);

    // ── As três concordam: A espera mais (20 > 15), vem antes (1º) e é contada
    // em 1º — inclusive no texto, que é o mais antigo dos três relógios.
  });

  it("quem nunca recebeu mensagem do cliente: última posição, sem inventar espera", async () => {
    const client = fakeSupabase([
      { ...linha("conv-sem-mensagem", T("10:00"), T("10:00")), awaiting_since: null },
      linha("conv-b", T("10:05"), T("10:05")),
    ]);

    const r = await listConversationsHandler(client, ctx, {
      limit: 50,
      comando: ["aguardando"],
    } as never);

    expect(r.conversations.map((c) => c.id)).toEqual(["conv-b", "conv-sem-mensagem"]);

    // `nulls last` no banco e o mesmo degradê na linha: sem mensagem, o rótulo
    // é seco ("Aguardando"), nunca uma data que o banco não tem.
    const semMensagem = r.conversations[1];
    if (semMensagem === undefined) throw new Error("a conversa sem mensagem sumiu");
    expect(esperaDaConversa({ awaiting_since: null, last_inbound_at: null, created_at: null })).toBeNull();
    expect(rotuloDaEspera(null, AGORA, (texto) => texto, ptBR)).toBe("Aguardando");
  });
});
