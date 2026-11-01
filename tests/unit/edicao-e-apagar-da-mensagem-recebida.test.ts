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

import { audit } from "@/lib/audit";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

const ORG = "org-1";
const SESSION = { id: "sess-1", organization_id: ORG, is_warmup_complete: true, warmup_started_at: null };

interface Linha {
  id: string;
  organization_id: string;
  conversation_id: string;
  external_id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  edited_at: string | null;
  revoked_at: string | null;
}

function linha(
  id: string,
  external_id: string,
  body: string,
  direction: "inbound" | "outbound" = "inbound",
): Linha {
  return {
    id,
    organization_id: ORG,
    conversation_id: "conv-1",
    external_id,
    direction,
    body,
    edited_at: null,
    revoked_at: null,
  };
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
      // `.is(col, null)` casa por igualdade estrita, como `eq` — basta aqui.
      is: (k: string, v: unknown) => {
        filtros.push([k, v]);
        return chain;
      },
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // A cadeia é aguardada (thenable): é aqui que o UPDATE acontece.
      then: (res: (v: unknown) => unknown) => {
        // O ingest lê de VOLTA o que carimbou (`select` depois do `update`) para
        // deixar a trilha de auditoria — por isso o dublê devolve as linhas
        // atingidas em vez de `null`. Fora do UPDATE o `data` segue `null`.
        const atingidas = op === "update" && name === "messages" && payload ? rows.filter(casa) : [];
        for (const row of atingidas) Object.assign(row, payload);
        return Promise.resolve({ data: op === "update" ? atingidas : null, error: null }).then(res);
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

/** Revogação do PRÓPRIO número (fromMe): o eco da tela e o apagar pelo celular chegam assim. */
const enviadaApagada = (chat: string, bare: string) => ({
  event: "message.revoked",
  payload: {
    after: { id: `true_${chat}_3EB0PROTOCOLO`, from: chat, fromMe: true },
    before: null,
    revokedMessageId: bare,
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

  it("a revogação que chega pelo canal deixa TRILHA — e nunca o corpo", async () => {
    const rows = [linha("m1", `false_${CHAT_A}_3EB0RECEBIDA`, "texto combinado")];
    await dispatchWahaEvent(makeAdmin(rows), SESSION, recebidaApagada(CHAT_A, "3EB0RECEBIDA"), "req-7");

    // Quem apaga pelo aplicativo não passa por tela nenhuma: sem esta linha, um
    // pedido de LGPD/RGPD pergunta "quando e como isto foi apagado" e ninguém
    // responde. O que a trilha guarda é o EVENTO — qual mensagem, de que lado, e
    // que o conteúdo ficou —, porque o corpo tem outro destino (a linha, onde
    // a retenção e o pedido de LGPD o alcançam).
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "message.revoked_in_channel",
        organizationId: ORG,
        resourceType: "message",
        resourceId: "m1",
        requestId: "req-7",
        metadata: expect.objectContaining({
          conversation_id: "conv-1",
          direction: "inbound",
          conteudo_preservado: true,
        }),
      }),
    );
    // 5 anos de retenção, append-only, fora da cascata de anonimização: o corpo
    // de uma mensagem NÃO pode entrar na trilha.
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain("texto combinado");
  });

  it("apagar id de conversa alheia não deixa trilha — não houve evento", async () => {
    const rows = [linha("m-a", `false_${CHAT_A}_3EB0X`, "fica como está")];
    await dispatchWahaEvent(makeAdmin(rows), SESSION, recebidaApagada(CHAT_B, "3EB0X"), "req-8");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("eco de um apagar feito pela TELA não grava trilha nem recarimba a hora", async () => {
    // A rota já carimbou a linha (e auditou `message.revoked`, com o ator); o
    // WAHA ecoa a revogação do próprio número. O eco não pode virar uma segunda
    // linha dizendo que alguém apagou pelo celular.
    const carimboDaTela = "2026-10-22T10:00:00.000Z";
    const rows = [{ ...linha("m-env", "3EB0ENVIADA", "valor errado", "outbound"), revoked_at: carimboDaTela }];
    await dispatchWahaEvent(makeAdmin(rows), SESSION, enviadaApagada(CHAT_A, "3EB0ENVIADA"), "req-9");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(rows[0]!.revoked_at).toBe(carimboDaTela);
  });

  it("apagar pelo APLICATIVO (o próprio número) grava UMA trilha, e a reentrega não duplica", async () => {
    const rows = [linha("m-env", "3EB0ENVIADA", "valor errado", "outbound")];
    const admin = makeAdmin(rows);
    await dispatchWahaEvent(admin, SESSION, enviadaApagada(CHAT_A, "3EB0ENVIADA"), "req-10");
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "message.revoked_in_channel",
        resourceId: "m-env",
        metadata: expect.objectContaining({ direction: "outbound" }),
      }),
    );
    // O WAHA reentrega o mesmo evento (503, replay): a linha já está apagada.
    await dispatchWahaEvent(admin, SESSION, enviadaApagada(CHAT_A, "3EB0ENVIADA"), "req-10b");
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
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
