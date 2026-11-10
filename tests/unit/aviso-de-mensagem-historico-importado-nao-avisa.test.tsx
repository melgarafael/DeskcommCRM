/**
 * O AVISO DE "NOVA MENSAGEM" NÃO TOCA PARA O PASSADO IMPORTADO (#3427).
 *
 * O importador de histórico do WhatsApp (Conexões › `ChannelHistorico`) grava
 * as conversas antigas DIRETO em `public.messages`, até 300 linhas por rodada
 * de cron, marcadas com `metadata.historico_importado = "true"`
 * (`lib/channels/historico/mapear.ts`). Inserir na tabela é, para o realtime,
 * indistinguível de uma mensagem que acabou de chegar: o `postgres_changes` de
 * INSERT entrega a linha a todo mundo com o app aberto.
 *
 * O push do servidor não sai porque a migration 0760 corta
 * `fn_emit_message_event` na marca. O aviso do navegador não passa pelo banco:
 * é este hook, assinando `messages` filtrando só por `organization_id`, e ele
 * avisava cada linha do acervo — toast, som e três pedidos HTTP por mensagem
 * antiga (`aviso-de-mensagem`, contato, avatar). Milhares de mensagens
 * importadas, milhares de avisos.
 *
 * As propriedades cobradas aqui são de produto:
 *   1. Linha marcada como histórico importado não faz NENHUM pedido HTTP e não
 *      mostra toast — nem a rota de veredito é consultada.
 *   2. A mesma linha SEM a marca avisa normalmente: é o controle. Sem ele,
 *      "não avisa" passaria com o hook mudo para tudo.
 *   3. A marca com outro valor (`"false"`) não cala o aviso: só o histórico
 *      importado é passado, e um aviso a mais de mensagem real é a regressão.
 *   4. As duas formas da marca em uso no repositório calão: a string `"true"`
 *      (o que o mapeador grava) e o booleano `true` (a forma que a 0686 e o
 *      `media-persist-worker` também tratam — ver o caso 8b de
 *      `tests/invariants/mensagem-do-vendedor-e-atividade.test.ts`).
 *
 * Roda com: pnpm vitest run tests/unit/aviso-de-mensagem-historico-importado-nao-avisa.test.tsx
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastFalso, fetchFalso } = vi.hoisted(() => ({
  toastFalso: vi.fn(),
  fetchFalso: vi.fn(),
}));

/** O canal é de fora: aqui só interessa a função que ele entrega o payload. */
const canal = vi.hoisted(() => ({ onChange: null as ((p: unknown) => void) | null }));

vi.mock("sonner", () => ({ toast: toastFalso }));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/lib/notifications/push_client", () => ({ syncPushSubscription: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ orgId: "org-1" }) }));
vi.mock("@/hooks/notifications/OpenConversationContext", () => ({
  getOpenConversationId: () => null,
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { onChange: (p: unknown) => void }) => {
    canal.onChange = opts.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));

import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";

function resposta(ok: boolean, corpo?: unknown) {
  return { ok, status: ok ? 200 : 500, url: "https://app.teste/api", json: async () => corpo };
}

/**
 * Payload como o Supabase Realtime entrega: `new` é a linha de `messages`.
 * `metadata` é a coluna jsonb como ela volta desserializada.
 */
function mensagem(metadata?: unknown) {
  return {
    new: {
      id: "msg-1",
      direction: "inbound",
      conversation_id: "conv-1",
      contact_id: "ct-1",
      type: "text",
      body: "mensagem do acervo",
      ...(metadata === undefined ? {} : { metadata }),
    },
  };
}

/** Monta o hook e entrega o payload; devolve quantos pedidos HTTP saíram. */
async function entregar(payload: unknown) {
  renderHook(() => useInboundMessageAlerts());
  await waitFor(() => expect(canal.onChange).not.toBeNull());
  canal.onChange!(payload);
  // O aviso, quando sai, é assíncrono (três awaits). Uma volta do event loop é
  // curta demais para provar ausência de pedido; 50 ms cobre a cadeia inteira e
  // é o que torna a asserção de ZERO fetch uma medida, não um palpite.
  await new Promise((r) => setTimeout(r, 50));
  return fetchFalso.mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  canal.onChange = null;
  vi.stubGlobal("fetch", fetchFalso);
  fetchFalso.mockImplementation(async (url: string) => {
    if (url.includes("/avatar")) return resposta(false);
    if (url.includes("/aviso-de-mensagem")) return resposta(true, { data: { avisar: true, conteudo: "oculto" } });
    return resposta(true, { data: { display_name: "Maria Souza" } });
  });
});

describe("histórico importado não avisa o navegador (#3427)", () => {
  it("linha com metadata.historico_importado = 'true' não faz pedido nem toast", async () => {
    const pedidos = await entregar(mensagem({ historico_importado: "true" }));

    expect(pedidos).toBe(0);
    expect(toastFalso).not.toHaveBeenCalled();
  });

  it("controle: a MESMA mensagem sem a marca avisa (toast e pedidos saem)", async () => {
    const pedidos = await entregar(mensagem());

    expect(toastFalso).toHaveBeenCalledTimes(1);
    expect(toastFalso.mock.calls[0]![0]).toBe("Maria Souza");
    expect(pedidos).toBeGreaterThan(0);
  });

  it("metadata com historico_importado = 'false' continua avisando", async () => {
    await entregar(mensagem({ historico_importado: "false" }));

    expect(toastFalso).toHaveBeenCalledTimes(1);
  });

  it("a forma booleana da marca (true) também cala — é a mesma linha no jsonb", async () => {
    const pedidos = await entregar(mensagem({ historico_importado: true }));

    expect(pedidos).toBe(0);
    expect(toastFalso).not.toHaveBeenCalled();
  });

  it("metadata ausente ou de outro formato não inventa histórico: avisa", async () => {
    await entregar(mensagem(null));
    expect(toastFalso).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await entregar(mensagem({ outra_coisa: "x" }));
    expect(toastFalso).toHaveBeenCalledTimes(1);
  });
});
