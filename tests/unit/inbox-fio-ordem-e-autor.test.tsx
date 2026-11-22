/**
 * O FIO DA CONVERSA ABERTA: ORDEM, BALÃO OTIMISTA E AUTOR (#4325 item 5).
 *
 * Os três pontos que o review de 22/11 mediu, e que este arquivo prende um por
 * um. Os três nascem da MESMA premissa errada — a de que `pages[0]` chega em
 * ordem DECRESCENTE:
 *
 *  1. ORDEM. `listMessagesHandler` devolve a resposta em ordem CRESCENTE
 *     (`app/api/v1/messages/_handler.ts`, o `.reverse()` do fim), e o
 *     `useSendMessage` acrescenta no fim. Mas `aplicarEventoNoFio` punha o
 *     `INSERT` no COMEÇO: a mensagem nova — inclusive a que a pessoa acabou de
 *     enviar — aparecia antes do histórico, no topo do fio.
 *  2. BALÃO OTIMISTA. O `temp-…` do `useSendMessage` só saía no `onSuccess`,
 *     então entre o `INSERT` do Realtime e a resposta do POST a mesma mensagem
 *     aparecia DUAS vezes (a otimista e a real).
 *  3. AUTOR. A linha que chega pelo Realtime é a linha CRUA de `messages`: o
 *     `sent_by_user_name` é campo derivado, resolvido pela ROTA
 *     (`comNomeDeQuemEnviou`). Sem ele o balão caía em "Atendente", sem dizer
 *     quem da equipe enviou.
 *
 * RED-BEFORE, medido com a metade do Inbox como ela veio do head `c47d3d4d82`
 * (antes de qualquer conserto): `Tests 4 failed | 2 passed`, com
 *  - `expected [ 'm1', 'm4' ] to deeply equal [ 'm2', 'm3', 'm4' ]` (o INSERT
 *    entrava na posição 0) nos dois primeiros casos de ordem;
 *  - `expected undefined to be 'Andreia Cristina de Souza'` e
 *    `expected undefined to be 'Marcos Vinicius'` nos dois casos de autor.
 *
 * SABOTAGEM: (a) voltar o `INSERT` para o começo de `pages[0]` deixa a ORDEM
 * vermelha; (b) tirar `semOBalaoOtimistaDoEnvio` deixa o caso do envio vermelho
 * com dois balões; (c) tirar `comAutor` deixa os casos de autor vermelhos;
 * (d) tirar a releitura do nome desconhecido deixa o caso "sem nome conhecido"
 * vermelho; (e) tirar a releitura da apagada pelo contato deixa o caso do texto
 * retido vermelho.
 */
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const fakes = vi.hoisted(() => ({
  onChange: null as null | ((payload: unknown) => void),
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (cfg: { onChange: (payload: unknown) => void }) => {
    fakes.onChange = cfg.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({ useRefetchDeSeguranca: () => ({}) }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) => fakes.get(url),
    post: (url: string, body: unknown) => fakes.post(url, body),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: () => undefined }));

import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Message } from "@/lib/types/messaging";

const CONVERSA = "c1";
/** Quem está com a conversa aberta — o autor do envio otimista. */
const AUTOR = { id: "u-eu", nome: "Marcos Vinicius" };

const leiturasDeMensagens = () =>
  fakes.get.mock.calls.filter(([u]) => String(u).includes("/messages")).length;

interface Fio {
  pages: Array<{ data: Array<Record<string, unknown>> }>;
  pageParams: unknown[];
}

const fioNoCache = (qc: QueryClient) =>
  qc.getQueryData<Fio>(["messages", CONVERSA]) ?? { pages: [], pageParams: [] };

const ids = (qc: QueryClient, pagina = 0) =>
  (fioNoCache(qc).pages[pagina]?.data ?? []).map((m) => m.id as string);

/** Uma linha de `messages` do jeito que a ROTA devolve (campo derivado incluso). */
function linha(over: Partial<Message> = {}): Record<string, unknown> {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: CONVERSA,
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    error_code: null,
    error_message: null,
    body: "corpo",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    reply_to_message_id: null,
    sent_via: "external_device",
    sent_by_user_id: null,
    sent_at: "2026-11-21T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    created_at: "2026-11-21T12:00:00.000Z",
    updated_at: "2026-11-21T12:00:00.000Z",
    ...over,
  } as unknown as Record<string, unknown>;
}

/** O fio carregado: `pages[0]` é o pedaço MAIS NOVO, e dentro dele a ordem é cronológica. */
function fioCom(
  maisNovo: Array<Record<string, unknown>>,
  maisAntigo: Array<Record<string, unknown>> = [],
) {
  return {
    pages: [{ data: maisNovo }, { data: maisAntigo }],
    pageParams: [undefined, "cur-1"],
  } as unknown as Fio;
}

function Montagem({ comEnvio = false }: { comEnvio?: boolean }) {
  const { data } = useMessagesRealtime(CONVERSA, AUTOR);
  const envio = useSendMessage();
  const mensagens = data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div>
      {comEnvio && (
        <button onClick={() => envio.mutate({ conversation_id: CONVERSA, body: "oi" })}>
          enviar
        </button>
      )}
      <ul data-testid="fio">
        {mensagens.map((m) => (
          <li key={m.id as string} data-testid={`balão-${m.id as string}`}>
            {String(m.body ?? "")}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Monta a tela e, DEPOIS da primeira leitura, planta o fio no cache.
 *
 * Plantar antes do render não serve: a `useInfiniteQuery` busca a página 0 ao
 * montar e sobrescreve o que estivesse lá.
 */
async function montar(fio: Fio, opcoes: { comEnvio?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(<Montagem comEnvio={opcoes.comEnvio} />, { wrapper });
  await waitFor(() => expect(leiturasDeMensagens()).toBe(1));
  qc.setQueryData(["messages", CONVERSA], fio);
  return qc;
}

const ENVIO_DE_QUEM_ESTA_AQUI: Partial<Message> = {
  body: "oi",
  direction: "outbound",
  sent_via: "user",
  sent_by_user_id: AUTOR.id,
};

describe("o fio da conversa aberta", () => {
  beforeEach(() => {
    fakes.get.mockReset();
    fakes.post.mockReset();
    fakes.get.mockImplementation(async () => ({
      data: [linha({ id: "m1" })],
      meta: { has_more: false, cursor: null },
    }));
  });

  // ─── 1. ORDEM ──────────────────────────────────────────────────────────────
  it("mensagem nova entra no FIM da página mais nova, e o histórico não se mexe", async () => {
    const qc = await montar(
      fioCom(
        [linha({ id: "m2", body: "segunda" }), linha({ id: "m3", body: "terceira" })],
        [linha({ id: "m0", body: "antiga" })],
      ),
    );
    const antes = leiturasDeMensagens();

    fakes.onChange!({
      eventType: "INSERT",
      table: "messages",
      new: linha({ id: "m4", body: "chegou agora" }),
    });

    // A rota devolve CRESCENTE: o evento entra depois da última, nunca antes da primeira.
    expect(ids(qc)).toEqual(["m2", "m3", "m4"]);
    expect(ids(qc, 1)).toEqual(["m0"]);
    expect(leiturasDeMensagens(), "o INSERT pediu rede").toBe(antes);
  });

  // ─── 2. ORDEM + BALÃO OTIMISTA ─────────────────────────────────────────────
  it("a mensagem ENVIADA fica no fim do fio e o balão otimista sai quando a real entra", async () => {
    const pendente: { resolver: (v: unknown) => void } = { resolver: () => {} };
    fakes.post.mockImplementation(() => new Promise((resolve) => (pendente.resolver = resolve)));
    const qc = await montar(fioCom([linha({ id: "m1", body: "pergunta" })]), { comEnvio: true });

    fireEvent.click(screen.getByRole("button", { name: "enviar" }));
    await waitFor(() => expect(ids(qc).some((i) => i.startsWith("temp-"))).toBe(true));

    const otimista = ids(qc).find((i) => i.startsWith("temp-"))!;
    // O otimista entra no FIM, como o real.
    expect(ids(qc)).toEqual(["m1", otimista]);

    // O canal entrega a linha REAL antes de o POST responder (é o caso medido).
    fakes.onChange!({
      eventType: "INSERT",
      table: "messages",
      new: linha({ id: "r1", ...ENVIO_DE_QUEM_ESTA_AQUI, status: "sent" }),
    });

    // Um balão só, o real, no fim — o `temp-…` não convive com ele.
    expect(ids(qc)).toEqual(["m1", "r1"]);
    expect(screen.queryAllByTestId(/^balão-/)).toHaveLength(2);

    // O settle ressincroniza; a rota já devolve a real.
    fakes.get.mockImplementation(async () => ({
      data: [linha({ id: "m1", body: "pergunta" }), linha({ id: "r1", ...ENVIO_DE_QUEM_ESTA_AQUI })],
      meta: { has_more: false, cursor: null },
    }));
    pendente.resolver({ data: linha({ id: "r1", ...ENVIO_DE_QUEM_ESTA_AQUI }) });
    await waitFor(() => expect(fakes.get.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(ids(qc)).toEqual(["m1", "r1"]));
    expect(ids(qc).some((i) => i.startsWith("temp-")), "sobrou o otimista").toBe(false);
  });

  // ─── 3. AUTOR ──────────────────────────────────────────────────────────────
  it("a linha do Realtime chega com o nome de quem enviou, e o balão mostra o autor", async () => {
    const qc = await montar(
      fioCom([
        linha({
          id: "m1",
          direction: "outbound",
          sent_via: "user",
          sent_by_user_id: "u-andreia",
          sent_by_user_name: "Andreia Cristina de Souza",
          body: "bom dia",
        }),
      ]),
    );

    // A linha do canal NÃO traz `sent_by_user_name`: é campo derivado da rota.
    fakes.onChange!({
      eventType: "INSERT",
      table: "messages",
      new: linha({
        id: "m9",
        direction: "outbound",
        sent_via: "user",
        sent_by_user_id: "u-andreia",
        body: "já volto",
      }),
    });

    const balao = fioNoCache(qc).pages[0]!.data.find((m) => m.id === "m9")!;
    expect(balao.sent_by_user_name).toBe("Andreia Cristina de Souza");
    // Nome resolvido pelo próprio fio: nenhuma recarga.
    expect(leiturasDeMensagens()).toBe(1);

    // O balão desenha o autor a partir da linha que está no cache.
    render(<MessageBubble message={balao as unknown as Message} viewerUserId={AUTOR.id} />);
    expect(screen.getByText("Atendente · Andreia")).toBeInTheDocument();
  });

  it("quem enviou é o próprio leitor: o nome sai da sessão, não de invenção", async () => {
    const qc = await montar(fioCom([]));

    fakes.onChange!({
      eventType: "INSERT",
      table: "messages",
      new: linha({ id: "m10", ...ENVIO_DE_QUEM_ESTA_AQUI, body: "enviado de outro aparelho" }),
    });

    const balao = fioNoCache(qc).pages[0]!.data.find((m) => m.id === "m10")!;
    expect(balao.sent_by_user_name).toBe(AUTOR.nome);
  });

  it("sem nome conhecido a linha fica SEM autor — o balão não inventa um, e o fio pede o nome à rota", async () => {
    const qc = await montar(fioCom([]));

    fakes.onChange!({
      eventType: "INSERT",
      table: "messages",
      new: linha({
        id: "m11",
        direction: "outbound",
        sent_via: "user",
        sent_by_user_id: "u-desconhecido",
        body: "quem falou?",
      }),
    });

    const balao = fioNoCache(qc).pages[0]!.data.find((m) => m.id === "m11")!;
    expect(balao.sent_by_user_name ?? null).toBeNull();
    render(<MessageBubble message={balao as unknown as Message} viewerUserId={AUTOR.id} />);
    expect(screen.getByText("Atendente")).toBeInTheDocument();
    // Só a rota sabe o nome (campo derivado): UMA recarga, em vez de "Atendente"
    // até a próxima — era o que a invalidação de antes entregava (#4031).
    await waitFor(() => expect(leiturasDeMensagens()).toBe(2));
  });

  // ─── 4. O OUTRO CAMPO DERIVADO: TEXTO RETIDO ───────────────────────────────
  it("a mensagem que o CONTATO apagou pede UMA releitura — o botão do texto retido é da rota", async () => {
    await montar(
      fioCom([
        linha({ id: "m1", body: "meu cpf é..." }),
        linha({ id: "m2", direction: "outbound", sent_via: "user", body: "recebido" }),
      ]),
    );

    // A apagada pelo ATENDENTE não tem campo derivado novo: mescla sem rede.
    fakes.onChange!({
      eventType: "UPDATE",
      table: "messages",
      new: linha({ id: "m2", direction: "outbound", revoked_at: "2026-11-21T12:05:00.000Z" }),
    });
    expect(leiturasDeMensagens(), "a apagada pelo atendente pediu rede").toBe(1);

    // A apagada pelo CONTATO: a linha crua traz `revoked_at` e nunca
    // `texto_retido`, que só `mascararTextoRetido` preenche na rota.
    fakes.onChange!({
      eventType: "UPDATE",
      table: "messages",
      new: linha({ id: "m1", body: "meu cpf é...", revoked_at: "2026-11-21T12:05:00.000Z" }),
    });
    await waitFor(() => expect(leiturasDeMensagens()).toBe(2));
  });

  it("o INSERT do COLEGA não come o meu balão otimista, mesmo com o texto igual", async () => {
    const pendente: { resolver: (v: unknown) => void } = { resolver: () => {} };
    fakes.post.mockImplementation(() => new Promise((resolve) => (pendente.resolver = resolve)));
    const qc = await montar(fioCom([linha({ id: "m1", body: "pergunta" })]), { comEnvio: true });

    fireEvent.click(screen.getByRole("button", { name: "enviar" }));
    await waitFor(() => expect(ids(qc).some((i) => i.startsWith("temp-"))).toBe(true));

    fakes.onChange!({
      eventType: "INSERT",
      table: "messages",
      new: linha({
        id: "r9",
        body: "oi",
        direction: "outbound",
        sent_via: "user",
        sent_by_user_id: "u-andreia",
        sent_by_user_name: "Andreia",
      }),
    });

    // O `temp-…` continua: o envio do colega é outra mensagem, ainda em voo.
    expect(ids(qc).some((i) => i.startsWith("temp-"))).toBe(true);
    expect(ids(qc)).toContain("r9");
  });
});
