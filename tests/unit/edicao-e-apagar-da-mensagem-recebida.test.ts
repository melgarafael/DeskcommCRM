/**
 * A MENSAGEM QUE O CLIENTE EDITOU OU APAGOU — OS DOIS SENTIDOS.
 *
 * ─── O defeito, medido no formato do id ─────────────────────────────────────
 *
 * A mensagem que o cliente manda é gravada COMPLETA — `messages.external_id =
 * false_<chat>_<bare>` (o mesmo `p.id` do webhook de entrada). Já os eventos
 * `message.edited` / `message.revoked` trazem `editedMessageId`/`revokedMessageId`
 * só com a CAUDA (`<bare>`). Casar o evento por `.eq("external_id", "<bare>")`
 * acha a mensagem que NÓS mandamos (o envio grava o bare), mas NUNCA a recebida:
 * a linha fica intocada, o evento "some" sem erro e a tela segue com o texto
 * antigo. Reprodução do relato: contato manda texto, edita no celular, o CRM
 * segue mostrando a versão velha.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Editar e apagar uma RECEBIDA gravam `edited_at`/`revoked_at` na linha certa;
 * a edição da ENVIADA continua funcionando (a cauda continua na lista); o
 * casamento EXIGE o chat — a mesma cauda em OUTRA conversa não é tocada; e um
 * id desconhecido não inventa linha.
 *
 * O caminho é o REAL: `dispatchWahaEvent`, com um dublê de `messages` que
 * APLICA os filtros sobre linhas em memória (não só registra a consulta) —
 * assim "outra conversa não é tocada" é uma afirmação sobre o que mudou de
 * fato, não sobre a cara da consulta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/waha/ingest.ts` alcança `lib/env.ts` (que valida na importação) via
// `pos-entrada`/`ai-response-worker`. Mesma isca dos testes irmãos.
const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));

import { dispatchWahaEvent } from "@/lib/waha/ingest";

const ORG = "org-1";
const SESSION = { id: "sess-1", organization_id: ORG, is_warmup_complete: true, warmup_started_at: null };

interface Linha {
  id: string;
  organization_id: string;
  external_id: string;
  body: string | null;
  edited_at: string | null;
  revoked_at: string | null;
}

function linha(id: string, external_id: string, body: string): Linha {
  return { id, organization_id: ORG, external_id, body, edited_at: null, revoked_at: null };
}

/**
 * Dublê de `messages` que GUARDA as linhas e aplica os filtros do builder
 * (`eq`/`in`) sobre elas — o UPDATE muda de fato quem casa. É o mínimo para
 * provar isolamento entre conversas sem um banco de verdade.
 */
function makeAdmin(rows: Linha[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (name: string): any => {
    let op: "select" | "update" | "insert" | "delete" = "select";
    let payload: Record<string, unknown> | null = null;
    const filtros: Array<[string, unknown]> = [];
    const casa = (row: Linha) =>
      filtros.every(([k, v]) =>
        Array.isArray(v)
          ? (v as unknown[]).includes((row as unknown as Record<string, unknown>)[k])
          : (row as unknown as Record<string, unknown>)[k] === v,
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: (p: Record<string, unknown>) => {
        op = "update";
        payload = p;
        return chain;
      },
      insert: () => {
        op = "insert";
        return chain;
      },
      delete: () => {
        op = "delete";
        return chain;
      },
      eq: (k: string, v: unknown) => {
        filtros.push([k, v]);
        return chain;
      },
      in: (k: string, v: unknown) => {
        filtros.push([k, v]);
        return chain;
      },
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // A cadeia é aguardada (thenable): é aqui que o UPDATE acontece.
      then: (res: (v: unknown) => unknown) => {
        if (name === "messages" && op === "update" && payload) {
          for (const row of rows) if (casa(row)) Object.assign(row, payload);
        }
        return Promise.resolve({ data: null, error: null }).then(res);
      },
    };
    return chain;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }) } as never;
}

const recebidaEditada = (chat: string, bare: string, corpo: string) => ({
  event: "message.edited",
  payload: {
    id: `false_${chat}_${bare}`,
    from: chat,
    fromMe: false,
    editedMessageId: bare,
    body: corpo,
    type: "text",
  },
});

/**
 * A forma REAL do `message.revoked`: `WAMessageRevokedBody` do WAHA, como o
 * NOWEB emite (`session.noweb.core.ts`) — `{ after, before: null,
 * revokedMessageId }`, SEM `from`/`fromMe` no topo. O chat vem em `after`, que é
 * a protocolMessage de quem apagou (outro id, mesmo chat). Lida da fonte pública
 * do WAHA, não de um payload capturado nesta instalação.
 */
const recebidaApagada = (chat: string, bare: string) => ({
  event: "message.revoked",
  payload: {
    after: { id: `false_${chat}_3EB0PROTOCOLO`, from: chat, fromMe: false },
    before: null,
    revokedMessageId: bare,
  },
});

/** A forma flat (chat no topo), caso algum engine a mande — as duas são aceitas. */
const recebidaApagadaFlat = (chat: string, bare: string) => ({
  event: "message.revoked",
  payload: {
    id: `false_${chat}_${bare}`,
    from: chat,
    fromMe: false,
    revokedMessageId: bare,
    type: "revoked",
  },
});

const enviadaEditada = (chat: string, bare: string, corpo: string) => ({
  event: "message.edited",
  payload: {
    id: `true_${chat}_${bare}`,
    from: chat,
    fromMe: true,
    editedMessageId: bare,
    body: corpo,
    type: "text",
  },
});

const CHAT_A = "5511999999999@lid";
const CHAT_B = "5521888888888@lid";

beforeEach(() => vi.clearAllMocks());

describe("edição e apagar de mensagem RECEBIDA chegam ao CRM", () => {
  it("edição grava o texto novo e carimba `edited_at` na linha recebida", async () => {
    const rows = [linha("m1", `false_${CHAT_A}_3EB0RECEBIDA`, "preço antigo")];
    await dispatchWahaEvent(
      makeAdmin(rows),
      SESSION,
      recebidaEditada(CHAT_A, "3EB0RECEBIDA", "preço novo: 300"),
      "req-1",
    );
    expect(rows[0]!.body).toBe("preço novo: 300");
    expect(rows[0]!.edited_at).not.toBeNull();
  });

  it("apagar para todos carimba `revoked_at` e NÃO limpa o corpo", async () => {
    const rows = [linha("m1", `false_${CHAT_A}_3EB0RECEBIDA`, "texto combinado")];
    await dispatchWahaEvent(makeAdmin(rows), SESSION, recebidaApagada(CHAT_A, "3EB0RECEBIDA"), "req-2");
    expect(rows[0]!.revoked_at).not.toBeNull();
    // O corpo fica: quem decide o que mostrar é a tela; apagar aqui impediria o
    // atendente de entender depois o que tinha sido combinado.
    expect(rows[0]!.body).toBe("texto combinado");
  });

  it("apagar na forma flat (chat no topo) também carimba `revoked_at`", async () => {
    const rows = [linha("m1", `false_${CHAT_A}_3EB0RECEBIDA`, "texto combinado")];
    await dispatchWahaEvent(makeAdmin(rows), SESSION, recebidaApagadaFlat(CHAT_A, "3EB0RECEBIDA"), "req-2b");
    expect(rows[0]!.revoked_at).not.toBeNull();
  });
});

describe("a edição da mensagem ENVIADA continua funcionando", () => {
  it("casa a linha do envio (bare) sem depender do composto", async () => {
    const rows = [linha("m-env", "3EB0ENVIADA", "valor errado")];
    await dispatchWahaEvent(
      makeAdmin(rows),
      SESSION,
      enviadaEditada("5511999999999@c.us", "3EB0ENVIADA", "valor certo"),
      "req-3",
    );
    expect(rows[0]!.body).toBe("valor certo");
    expect(rows[0]!.edited_at).not.toBeNull();
  });
});

describe("o casamento EXIGE o chat — id ambíguo entre conversas", () => {
  it("a mesma cauda em OUTRA conversa NÃO é tocada", async () => {
    // Dois contatos, mesma cauda (o caso mais hostil): só a conversa do evento
    // pode mudar. Um casamento só pela cauda varreria as duas.
    const rows = [
      linha("m-a", `false_${CHAT_A}_3EB0AMBIG`, "texto da conversa A"),
      linha("m-b", `false_${CHAT_B}_3EB0AMBIG`, "texto da conversa B"),
    ];
    await dispatchWahaEvent(
      makeAdmin(rows),
      SESSION,
      recebidaEditada(CHAT_B, "3EB0AMBIG", "só a B mudou"),
      "req-4",
    );
    expect(rows.find((r) => r.id === "m-b")!.body).toBe("só a B mudou");
    expect(rows.find((r) => r.id === "m-b")!.edited_at).not.toBeNull();
    // A conversa A fica intacta — nem corpo nem carimbo.
    expect(rows.find((r) => r.id === "m-a")!.body).toBe("texto da conversa A");
    expect(rows.find((r) => r.id === "m-a")!.edited_at).toBeNull();
  });

  it("apagar um id de conversa alheia não toca nada", async () => {
    const rows = [linha("m-a", `false_${CHAT_A}_3EB0X`, "fica como está")];
    await dispatchWahaEvent(makeAdmin(rows), SESSION, recebidaApagada(CHAT_B, "3EB0X"), "req-5");
    expect(rows[0]!.revoked_at).toBeNull();
  });

  it("id desconhecido não inventa linha nem mexe em nada", async () => {
    const rows = [linha("m-a", `false_${CHAT_A}_3EB0OUTRO`, "intocada")];
    await dispatchWahaEvent(makeAdmin(rows), SESSION, recebidaEditada(CHAT_A, "3EB0FANTASMA", "x"), "req-6");
    expect(rows[0]!.body).toBe("intocada");
    expect(rows[0]!.edited_at).toBeNull();
  });
});
