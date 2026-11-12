import { beforeEach, describe, expect, it, vi } from "vitest";

// Mesmo corte dos irmãos: o ingest importa @/lib/audit, que valida env.
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import { dispatchWahaEvent } from "@/lib/waha/ingest";
import { PREVIA_DA_APAGADA_PELO_CONTATO } from "@/lib/messaging/texto-retido";

/**
 * O APAGAMENTO TAMBÉM SAI DA PRÉVIA DA CONVERSA (#4500).
 *
 * ─── O defeito medido ──────────────────────────────────────────────────────
 *
 * `conversations.last_message_preview` é o que a lista da Inbox mostra e o que a
 * busca filtra (`ilike`). Ela é gravada no ingest com o corpo e ninguém a mexia
 * no apagamento: o contato apagava a mensagem, o balão escondia e o texto
 * continuava na lista e na busca — o caminho que a issue manda fechar.
 *
 * ─── As duas pontas que este teste separa ──────────────────────────────────
 *
 *   • apagada pelo CONTATO → a prévia vira o marcador, e só quando ela é a
 *     ÚLTIMA (o filtro `lte(last_message_at, sent_at)` protege o assunto atual);
 *   • apagada pelo ATENDENTE → a prévia NÃO é tocada: o texto dela continua
 *     visível à equipe (`textoDaApagadaApareceNaInbox`).
 *
 * Entra pelo caminho de produção (`dispatchWahaEvent`), como os irmãos
 * `ingest-reacao` / `ingest-citacao`: chamar o handler privado provaria a função
 * e mentiria sobre o roteamento do evento.
 */

const CONVERSA = "conv-1";
const SESSION = { id: "sessao-1", organization_id: "org-1" };

type Chamada = {
  tabela: string;
  payload: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
};

const chamadas = vi.hoisted(() => ({ lista: [] as Chamada[] }));

function reset() {
  chamadas.lista.length = 0;
}

/** Admin de mentira: registra o UPDATE e devolve a linha carimbada. */
function adminDeMentira(direction: "inbound" | "outbound", sentAt: string) {
  const cadeia = (tabela: string) => {
    const registro: Chamada = { tabela, payload: {}, filtros: [] };
    const q: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        registro.filtros.push([col, val]);
        return q;
      },
      in: () => q,
      is: () => q,
      lte: (col: string, val: unknown) => {
        registro.filtros.push([col, val]);
        return q;
      },
      select: async () => ({
        data: [
          {
            id: "msg-1",
            conversation_id: CONVERSA,
            direction,
            external_id: "ABC123",
            sent_at: sentAt,
          },
        ],
        error: null,
      }),
      // `await update(...).eq().eq().lte()` (a atualização da prévia).
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(ok, falha),
    };
    return { update: (payload: Record<string, unknown>) => { registro.payload = payload; chamadas.lista.push(registro); return q; } };
  };

  return { from: (tabela: string) => cadeia(tabela) };
}

const SENT_AT = "2026-11-10T12:00:00.000Z";

function eventoApagamento() {
  return {
    event: "message.revoked",
    payload: { revokedMessageId: "3EB0ABC123", from: "5511999999999@c.us" },
  };
}

beforeEach(() => {
  reset();
});

describe("o apagamento do contato reescreve a prévia da conversa", () => {
  it("a prévia vira o marcador e o filtro exige que seja a ÚLTIMA mensagem", async () => {
    await dispatchWahaEvent(
      adminDeMentira("inbound", SENT_AT) as never,
      SESSION as never,
      eventoApagamento() as never,
      "req-1",
    );

    const atualizacao = chamadas.lista.find((c) => c.tabela === "conversations");
    expect(atualizacao, "a prévia da conversa não foi atualizada no apagamento").toBeDefined();
    expect(atualizacao!.payload).toEqual({ last_message_preview: PREVIA_DA_APAGADA_PELO_CONTATO });
    expect(atualizacao!.filtros).toContainEqual(["id", CONVERSA]);
    expect(atualizacao!.filtros).toContainEqual(["organization_id", "org-1"]);
    // Sem este par, uma mensagem NOVA depois da apagada teria a prévia sobrescrita.
    expect(atualizacao!.filtros).toContainEqual(["last_message_at", SENT_AT]);
  });

  it("o marcador não carrega o texto apagado — ele é uma frase fixa", async () => {
    await dispatchWahaEvent(
      adminDeMentira("inbound", SENT_AT) as never,
      SESSION as never,
      eventoApagamento() as never,
      "req-1",
    );

    const valor = String(
      chamadas.lista.find((c) => c.tabela === "conversations")?.payload.last_message_preview,
    );
    expect(valor).not.toMatch(/3EB0ABC123/);
    expect(valor.toLowerCase()).toContain("apagada");
  });
});

describe("a apagada pelo ATENDENTE não mexe na prévia", () => {
  it("o texto dela continua visível à equipe, então a lista segue mostrando", async () => {
    await dispatchWahaEvent(
      adminDeMentira("outbound", SENT_AT) as never,
      SESSION as never,
      eventoApagamento() as never,
      "req-1",
    );

    expect(chamadas.lista.some((c) => c.tabela === "conversations")).toBe(false);
  });
});
