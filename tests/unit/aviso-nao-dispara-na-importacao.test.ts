/**
 * A RODADA INTEIRA DO HISTÓRICO IMPORTADO NÃO AVISA — E O CORTE É POR LINHA (#3427).
 *
 * O importador do acervo do WhatsApp (cron `historico-import`) grava até
 * `TETO_PADRAO` = 300 mensagens por rodada direto em `public.messages`, cada uma
 * marcada em `lib/channels/historico/mapear.ts` com
 * `metadata.historico_importado = "true"`. Para o `postgres_changes` de INSERT,
 * essa linha é indistinguível de mensagem que acabou de chegar: o canal do
 * navegador (`hooks/notifications/useInboundMessageAlerts.ts`) filtra só por
 * `organization_id` e recebia as 300 de uma vez.
 *
 * A guarda mora em `shouldNotifyInbound` (`lib/notifications/policy.ts`), que lê
 * a marca da própria linha. O arquivo irmão
 * `aviso-de-mensagem-historico-importado-nao-avisa.test.tsx` já prova o caso de
 * UMA linha; aqui a medida é a da issue: o LOTE, no tamanho da rodada real.
 *
 * O que este arquivo cobra, e que um conserto ingênuo deixaria passar:
 *
 *   1. 300 linhas marcadas = ZERO requisição. Nem a rota de veredito
 *      (`/aviso-de-mensagem`) é consultada — é ela o pedido mais caro do
 *      caminho, e o critério de aceite da issue é literalmente a contagem dela.
 *   2. O corte é POR LINHA, não uma janela: no meio de uma rodada de 299
 *      importadas, uma mensagem real avisa UMA vez. Um "mudo enquanto importa"
 *      (flag global, throttle, silêncio por tempo) passaria no caso 1 e reprova
 *      aqui — e deixaria cliente esperando resposta.
 *   3. Duas reais no meio da rodada avisam duas vezes: não existe mudo global.
 *   4. A marca só cala no valor que o importador grava: `"false"` continua
 *      avisando. Um conserto que trate "tem metadata" como "é histórico"
 *      silencia conversa de hoje.
 *
 * Roda com: pnpm vitest run tests/unit/aviso-nao-dispara-na-importacao.test.ts
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastFalso, fetchFalso } = vi.hoisted(() => ({
  toastFalso: vi.fn(),
  fetchFalso: vi.fn(),
}));

/** O canal é de fora: aqui só interessa a função em que ele entrega cada linha. */
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

/** O teto de uma rodada do cron (`TETO_PADRAO` em `lib/channels/historico/rodada.ts`). */
const LINHAS_DA_RODADA = 300;
/** Uma rodada cobre até 3 conversas (`rodada.ts`); o lote imita essa mistura. */
const CONVERSAS = ["conv-a", "conv-b", "conv-c"] as const;

function resposta(ok: boolean, corpo?: unknown) {
  return { ok, status: ok ? 200 : 500, url: "https://app.teste/api", json: async () => corpo };
}

/**
 * A linha de `messages` que o canal entrega. O tipo é explícito para os dois
 * construtores abaixo aceitarem o mesmo lote — sem ele, a união inferida a
 * partir de `importada()` recusa `real()` (foi o `tsc` que pegou).
 */
interface LinhaDoLote {
  new: {
    id: string;
    direction: string;
    conversation_id: string;
    contact_id: string;
    type: string;
    body: string;
    sent_via: string;
    metadata: unknown;
  };
}

/** Linha de `messages` como o importador grava: inbound, com a marca. */
function importada(i: number, marca: unknown = { historico_importado: "true" }): LinhaDoLote {
  return {
    new: {
      id: `imp-${i}`,
      direction: "inbound",
      conversation_id: CONVERSAS[i % CONVERSAS.length]!,
      contact_id: `ct-${i % CONVERSAS.length}`,
      type: "text",
      body: `mensagem do acervo ${i}`,
      sent_via: "external_device",
      metadata: marca,
    },
  };
}

/** Mensagem que ACABOU de chegar: sem a marca do acervo. */
function real(id: string, metadata: unknown = null): LinhaDoLote {
  return {
    new: {
      id,
      direction: "inbound",
      conversation_id: "conv-real",
      contact_id: "ct-real",
      type: "text",
      body: "chegou agora",
      sent_via: "waha",
      metadata,
    },
  };
}

/** Quantos pedidos saíram para cada rota — a medida que a issue cobra. */
function pedidosPorRota(): Record<string, number> {
  const contagem: Record<string, number> = {};
  for (const chamada of fetchFalso.mock.calls) {
    const url = String(chamada[0]);
    const rota = url.includes("/avatar")
      ? "avatar"
      : url.includes("/aviso-de-mensagem")
        ? "aviso-de-mensagem"
        : url.includes("/contacts/")
          ? "contato"
          : url.includes("/conversations/")
            ? "conversa"
            : url;
    contagem[rota] = (contagem[rota] ?? 0) + 1;
  }
  return contagem;
}

function totalDePedidos(): number {
  return Object.values(pedidosPorRota()).reduce((soma, n) => soma + n, 0);
}

/**
 * Entrega o lote inteiro de uma vez, como o realtime faz numa rodada, e espera a
 * cadeia assíncrona de cada aviso assentar. 300 linhas em 50 ms é curto demais
 * para provar ausência de pedido; 250 ms cobre a cadeia de três awaits com folga
 * e mantém o arquivo em menos de um segundo.
 */
async function entregarLote(payloads: unknown[]): Promise<void> {
  renderHook(() => useInboundMessageAlerts());
  await waitFor(() => expect(canal.onChange).not.toBeNull());
  for (const payload of payloads) canal.onChange!(payload);
  await new Promise((r) => setTimeout(r, 250));
}

beforeEach(() => {
  vi.clearAllMocks();
  canal.onChange = null;
  vi.stubGlobal("fetch", fetchFalso);
  fetchFalso.mockImplementation(async (url: string) => {
    if (url.includes("/avatar")) return resposta(false);
    if (url.includes("/aviso-de-mensagem")) {
      return resposta(true, { data: { avisar: true, conteudo: "oculto" } });
    }
    return resposta(true, { data: { display_name: "Maria Souza" } });
  });
});

describe("o lote do histórico importado não avisa ninguém (#3427)", () => {
  it("300 linhas de uma rodada com a marca do mapeador não fazem NENHUM pedido", async () => {
    await entregarLote(Array.from({ length: LINHAS_DA_RODADA }, (_, i) => importada(i)));

    // O critério de aceite da issue, medido na rota que o aviso consulta primeiro.
    expect(pedidosPorRota()["aviso-de-mensagem"] ?? 0).toBe(0);
    expect(totalDePedidos()).toBe(0);
    expect(toastFalso).not.toHaveBeenCalled();
  });

  it("a forma booleana da marca (jsonb) cala o lote inteiro igual", async () => {
    await entregarLote(
      Array.from({ length: LINHAS_DA_RODADA }, (_, i) =>
        importada(i, { historico_importado: true }),
      ),
    );

    expect(totalDePedidos()).toBe(0);
    expect(toastFalso).not.toHaveBeenCalled();
  });

  it("controle: a mensagem real no meio da rodada avisa UMA vez (o corte é por linha)", async () => {
    const lote = Array.from({ length: LINHAS_DA_RODADA - 1 }, (_, i) => importada(i));
    lote.splice(150, 0, real("msg-real"));

    await entregarLote(lote);

    expect(toastFalso).toHaveBeenCalledTimes(1);
    expect(toastFalso.mock.calls[0]![0]).toBe("Maria Souza");
    // Um aviso só: veredito, contato e avatar da mensagem REAL, nada do acervo.
    expect(pedidosPorRota()).toEqual({ "aviso-de-mensagem": 1, contato: 1, avatar: 1 });
  });

  it("controle: duas mensagens reais na mesma rodada avisam duas vezes (não há mudo global)", async () => {
    const lote = Array.from({ length: LINHAS_DA_RODADA - 2 }, (_, i) => importada(i));
    lote.splice(10, 0, real("msg-real-1"));
    lote.splice(200, 0, real("msg-real-2"));

    await entregarLote(lote);

    expect(toastFalso).toHaveBeenCalledTimes(2);
    expect(pedidosPorRota()["aviso-de-mensagem"]).toBe(2);
  });

  it("a marca com outro valor ('false') não cala: metadata não é sinônimo de acervo", async () => {
    const lote = Array.from({ length: 10 }, (_, i) => importada(i, { historico_importado: "false" }));

    await entregarLote(lote);

    expect(toastFalso).toHaveBeenCalledTimes(10);
    expect(pedidosPorRota()["aviso-de-mensagem"]).toBe(10);
  });

  it("controle positivo: cinco mensagens reais sem metadata avisam cinco vezes", async () => {
    await entregarLote(Array.from({ length: 5 }, (_, i) => real(`real-${i}`)));

    expect(toastFalso).toHaveBeenCalledTimes(5);
    expect(pedidosPorRota()).toEqual({ "aviso-de-mensagem": 5, contato: 5, avatar: 5 });
  });
});
