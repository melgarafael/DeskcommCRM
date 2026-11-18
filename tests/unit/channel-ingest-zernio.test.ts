import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ingestão: webhook → contato, conversa, mensagem.
 *
 * O que este módulo existe para gravar é `provider_conversation_id`. Uma
 * ingestão que salva a mensagem e esquece a thread deixa o inbox mostrando a
 * conversa e o operador SEM CONSEGUIR RESPONDER — porque o endereço deste canal
 * não se deriva do contato, e é só aqui que ele chega.
 *
 * Metade dos casos prova o que a ingestão RECUSA. Um webhook que aceita o que
 * não devia escreve lixo no banco de quem instalou, e ninguém descobre até a
 * conversa errada aparecer no inbox.
 */

const ops: { tabela: string; op: string; payload?: unknown }[] = [];

/**
 * O estado da linha que o dublê representa, para que os filtros MORDAM.
 *
 * A primeira versão deste fake tratava `.eq()`/`.neq()` como no-op e só
 * registrava a chamada. Isso deixou passar um defeito real: o update da thread
 * tinha um `.neq("provider_conversation_id", …)` que, numa conversa nova (coluna
 * NULL), nunca casa — porque em SQL `NULL <> 'valor'` é NULL, não TRUE. O teste
 * afirmava que o update foi CHAMADO com o payload certo, e não que ele tivesse
 * alcançado alguma linha. Em produção o webhook respondia "ingested" e a coluna
 * ficava nula.
 *
 * Agora o dublê aplica os filtros contra este estado e registra o que a linha
 * FICOU. Um teste só vale o que o dublê se recusa a fingir.
 */
let linhaConversa: Record<string, unknown> = { provider_conversation_id: null };
let rpcResposta: Record<string, unknown> = {
  fn_upsert_wa_contact: "contact-1",
  fn_upsert_wa_conversation: "conv-1",
};
let insertErro: { code?: string; message: string } | null = null;
/** Conversa que o provider já associou a esta thread — o caminho curto. */
let conversaExistente: { id: string; contact_id: string } | null = null;
/** O erro da leitura da conversa pela thread (o PostgREST devolve, não lança). */
let erroDaThread: { code?: string; message: string } | null = null;
/** A linha já gravada que o `23505` esconde, e o que a ingestão interrompida deixou. */
let mensagemGravada: Record<string, unknown> | null = null;
let carimboDaConversa: string | null = null;
let despachoPedido = false;
let erroDaRetomada: { message: string } | null = null;

/** Imita o builder do PostgREST: encadeável, resolve no `maybeSingle`. */
function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  let casa = true;
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          // A busca pela THREAD é um `select` em conversations; o insert de
          // mensagem também termina em maybeSingle. Separar por tabela+op é o
          // que impede o dublê de responder a pergunta errada.
          if (tabela === "conversations" && op === "select") {
            return async () =>
              payload === "last_inbound_at"
                ? { data: { last_inbound_at: carimboDaConversa }, error: null }
                : { data: erroDaThread ? null : conversaExistente, error: erroDaThread };
          }
          if (tabela === "messages" && op === "select") {
            return async () => ({ data: erroDaRetomada ? null : mensagemGravada, error: erroDaRetomada });
          }
          if (tabela === "event_log" && op === "select") {
            return async () => ({ data: despachoPedido ? { id: "evento-1" } : null, error: null });
          }
          if (tabela === "contacts" && op === "select") {
            return async () => ({ data: null, error: null });
          }
          return async () =>
            insertErro ? { data: null, error: insertErro } : { data: { id: "msg-1" }, error: null };
        }
        if (prop === "then") {
          // O efeito acontece AQUI, no await — depois de TODOS os filtros da
          // cadeia terem sido aplicados. Fazê-lo a cada elo (como a primeira
          // versão fazia) grava antes de o `.neq()` sequer ser avaliado, e o
          // dublê volta a mentir exatamente sobre o que precisa vigiar.
          return (ok: (v: unknown) => unknown) => {
            if (tabela === "conversations" && op === "update" && casa && payload) {
              Object.assign(linhaConversa, payload as Record<string, unknown>);
            }
            // Devolve as linhas AFETADAS, não `null` fixo: quem chama lê o
            // tamanho para saber se a gravação valeu, e um dublê que sempre diz
            // "nenhuma" faz um caminho correto parecer quebrado.
            return ok({ data: casa ? [{ id: "row-1" }] : [], error: null });
          };
        }
        return (...args: unknown[]) => {
          if (prop === "eq" || prop === "neq") {
            const [coluna, valor] = args as [string, unknown];
            const atual = tabela === "conversations" ? linhaConversa[coluna] : undefined;
            if (coluna === "provider_conversation_id") {
              // A semântica de SQL, não a intuição: comparação com NULL é NULL,
              // e NULL não é TRUE — a linha NÃO casa.
              if (atual === null || atual === undefined) casa = false;
              else if (prop === "eq" ? atual !== valor : atual === valor) casa = false;
            }
          }
          if (["update", "eq", "neq", "not", "is"].includes(String(prop))) {
            ops.push({ tabela, op: `${op}.${String(prop)}`, payload: args[0] });
          }
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  ops.push({ tabela, op, payload });
  return proxy;
}

const admin = {
  rpc: async (nome: string, args: unknown) => {
    ops.push({ tabela: "rpc", op: nome, payload: args });
    const v = rpcResposta[nome];
    return v === null ? { data: null, error: { message: "falhou" } } : { data: v, error: null };
  },
  from: (tabela: string) => ({
    select: (colunas: string) => chain(tabela, "select", colunas),
    insert: (payload: unknown) => chain(tabela, "insert", payload),
    update: (payload: unknown) => chain(tabela, "update", payload),
  }),
} as never;

vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/zernio/credentials")>()),
  // Sem retorno configurado = sem credencial: a busca do pino nem começa.
  resolveZernioCreds: vi.fn(),
}));

import { resolveZernioCreds } from "@/lib/channels/zernio/credentials";
import { ingestZernioInbound, waIdentityFrom } from "@/lib/channels/zernio/ingest";
import { verifyZernioSignature } from "@/lib/channels/zernio/webhook";
import { acceptsInboundWebhook, handleInboundWebhook } from "@/lib/channels/inbound";

const evento = (msg: Record<string, unknown> = {}) => ({
  id: "evt_1",
  event: "message.received",
  account: { id: "acc_1" },
  message: {
    id: "m_1",
    conversationId: "6a76a2dc4b8fe115e5f6c300",
    platform: "whatsapp",
    platformMessageId: "wamid.ABC",
    direction: "incoming",
    text: "hola",
    attachments: [],
    sender: { phoneNumber: "+595991733685", name: "Marcelo" },
    sentAt: "2026-08-08T01:00:00.000Z",
    ...msg,
  },
});

const ENTRADA = { organizationId: "org-1", channelSessionId: "sess-1" };

beforeEach(() => {
  ops.length = 0;
  linhaConversa = { provider_conversation_id: null };
  conversaExistente = null;
  erroDaThread = null;
  mensagemGravada = null;
  carimboDaConversa = null;
  despachoPedido = false;
  erroDaRetomada = null;
  insertErro = null;
  rpcResposta = { fn_upsert_wa_contact: "contact-1", fn_upsert_wa_conversation: "conv-1" };
});

describe("identidade → wa_identity", () => {
  it("telefone vira phone:, o mesmo vocabulário do canal por QR", () => {
    expect(
      waIdentityFrom({ phone: "+595991733685", bsuid: null, username: null, displayName: null, anchor: { kind: "phone", value: "+595991733685" } }),
    ).toBe("phone:+595991733685");
  });

  it("BSUID vira lid: — mesma NATUREZA de id, então é o MESMO contato nos dois canais", () => {
    // Inventar um terceiro prefixo criaria dois contatos para uma pessoa só.
    expect(
      waIdentityFrom({ phone: null, bsuid: "BS_1", username: null, displayName: null, anchor: { kind: "bsuid", value: "BS_1" } }),
    ).toBe("lid:BS_1");
  });

  it("sem âncora devolve null", () => {
    expect(
      waIdentityFrom({ phone: null, bsuid: null, username: "@x", displayName: null, anchor: null }),
    ).toBeNull();
  });
});

describe("o que a ingestão GRAVA", () => {
  it("grava a thread do provider — é o motivo deste módulo existir", async () => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(r.status).toBe("ingested");
    // O que importa não é a CHAMADA, é a linha ter ficado com o valor. Foi
    // exatamente essa diferença que deixou o defeito passar para produção.
    expect(linhaConversa.provider_conversation_id).toBe("6a76a2dc4b8fe115e5f6c300");
  });

  it("grava a thread mesmo quando a coluna está NULL — o caso de TODA conversa nova", async () => {
    // O defeito que foi a produção: `NULL <> 'valor'` é NULL, e um filtro
    // condicional nunca alcançava a linha recém-criada.
    linhaConversa = { provider_conversation_id: null };
  conversaExistente = null;
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(linhaConversa.provider_conversation_id).toBe("6a76a2dc4b8fe115e5f6c300");
  });

  it("atualiza a thread quando o provider abre uma NOVA para o mesmo contato", async () => {
    // Aconteceu de verdade no canal por QR: reconectar abriu threads novas e
    // partiu o histórico de 12 contatos. Guardar a mais recente é o que mantém
    // a resposta indo para onde a pessoa escreveu.
    linhaConversa = { provider_conversation_id: "thread-antiga" };
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(linhaConversa.provider_conversation_id).toBe("6a76a2dc4b8fe115e5f6c300");
  });

  it("a mensagem entra como inbound com o wamid como external_id", async () => {
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert");
    expect(ins?.payload).toMatchObject({
      organization_id: "org-1",
      conversation_id: "conv-1",
      external_id: "wamid.ABC",
      direction: "inbound",
      type: "text",
      body: "hola",
    });
  });

  it("ancora o clique CTWA da mensagem inbound, sem confundir source_id do anúncio", async () => {
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: evento({ referral: { source_type: "ad", source_id: "ad-123", ctwa_clid: "click-456" } }),
    });
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(ins.metadata).toMatchObject({
      meta_ctwa_message_v1: { platform: "meta_ads", source_type: "ad", ctwa_clid: "click-456" },
    });

    ops.length = 0;
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: evento({ referral: { source_type: "ad", source_id: "ad-123" } }),
    });
    const somenteAnuncio = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(somenteAnuncio.metadata).not.toHaveProperty("meta_ctwa_message_v1");
  });

  it("anexo define o tipo e a url fica no metadata, não no body", async () => {
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: evento({ attachments: [{ type: "image", url: "https://z/media/1" }] }),
    });
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(ins.type).toBe("image");
    // A url é endpoint AUTENTICADO e expira: guardar é ponteiro, não conteúdo.
    expect(ins.metadata).toEqual({ provider_attachments: [{ type: "image", url: "https://z/media/1" }] });
  });

  it("grava o TELEFONE mesmo quando a âncora é o id opaco", async () => {
    // O payload traz os dois. Descartar o telefone deixou o contato sem número:
    // o envio parou em `missing_phone_number` e a tela não tinha o que mostrar
    // ao atendente.
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: evento({ sender: { phoneNumber: "+595991733685", businessScopedUserId: "PY.853", name: "M" } }),
    });
    const up = ops.find((o) => o.tabela === "contacts" && o.op === "update");
    expect(up?.payload).toEqual({ phone_number: "+595991733685" });
    // E a âncora segue sendo o BSUID: é a que sobrevive a trocar de número.
    const rpc = ops.find((o) => o.op === "fn_upsert_wa_contact");
    expect((rpc?.payload as Record<string, unknown>).p_lid).toBe("PY.853");
    expect((rpc?.payload as Record<string, unknown>).p_phone).toBe("+595991733685");
  });

  it("reusa a RPC do canal por QR para o contato — a corrida já está resolvida lá", async () => {
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    const rpc = ops.find((o) => o.op === "fn_upsert_wa_contact");
    expect(rpc?.payload).toMatchObject({ p_org: "org-1", p_kind: "phone", p_phone: "+595991733685" });
  });
});

describe("o pino do WhatsApp — as coordenadas vêm no próprio webhook", () => {
  // Medido em 24/09/2026: o evento chegava com `text: "📍 Location"` e nada mais,
  // e a ingestão buscava as coordenadas na API DENTRO da requisição do webhook.
  // Medido de novo em 27/10/2026 no log de entregas do provedor (30 dias): os 50
  // pinos chegaram com `metadata.location`, e 29 das 129 entregas de pino tinham
  // vencido o limite de 5 s. A API saiu do caminho da requisição.
  const pinoDoWebhook = (location: Record<string, unknown>, texto = "📍 Location", id = "wamid.PINO") => ({
    ...evento({ text: texto, platformMessageId: id }),
    metadata: { location },
  });
  const pinoSemCoordenadas = () => evento({ text: "📍 Location", platformMessageId: "wamid.PINO" });
  const chamadasAoProvedor = (f: { mock: { calls: unknown[][] } }) =>
    f.mock.calls.filter(([u]) => String(u).includes("z.test")).length;
  const pediuNovaBusca = () =>
    ops.find(
      (o) => o.op === "emit_event" && (o.payload as { p_event_type?: string }).p_event_type === "message.location_retry_requested",
    )?.payload as Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(resolveZernioCreds).mockResolvedValue({
      accountId: "acc_1", apiKey: "k", baseUrl: "https://z.test/api", source: "session",
    });
  });

  afterEach(() => {
    vi.mocked(resolveZernioCreds).mockReset();
  });

  it("⭐ grava tipo location, link do mapa e coordenadas do webhook — sem nenhuma chamada ao provedor", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: pinoDoWebhook({ latitude: -23.561414, longitude: -46.655881 }),
    });

    expect(chamadasAoProvedor(f), "a ingestão perguntou ao provedor o que o webhook já trouxe").toBe(0);
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(ins.type).toBe("location");
    expect(ins.body).toBe("📍 https://maps.google.com/?q=-23.561414,-46.655881");
    expect(ins.metadata).toEqual({ location: { latitude: -23.561414, longitude: -46.655881 } });
    // Com coordenadas, nada a buscar de novo.
    expect(pediuNovaBusca()).toBeUndefined();
  });

  it("lugar com nome ('📍 Praça…'): nome e endereço do webhook entram no corpo", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: pinoDoWebhook(
        { latitude: -23.55, longitude: -46.63, name: "Praça da Matriz", address: "Centro, São Paulo, SP" },
        "📍 Praça da Matriz",
        "wamid.PRACA",
      ),
    });
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(ins.type).toBe("location");
    expect(ins.body).toBe("📍 Praça da Matriz — Centro, São Paulo, SP — https://maps.google.com/?q=-23.55,-46.63");
  });

  it("⭐ webhook SEM coordenadas: nenhuma chamada ao provedor dentro da requisição — a busca vai para depois", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: pinoSemCoordenadas() });

    expect(r.status).toBe("ingested");
    expect(chamadasAoProvedor(f), "a busca do pino segurou a resposta ao provedor").toBe(0);
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(ins).toMatchObject({ type: "text", body: "📍 Location", metadata: {} });
    expect(pediuNovaBusca()).toMatchObject({
      p_event_type: "message.location_retry_requested",
      p_entity_id: "msg-1",
      p_organization_id: "org-1",
      p_payload: { message_id: "msg-1", account_id: "acc_1", provider_conversation_id: "6a76a2dc4b8fe115e5f6c300" },
    });
  });

  it("texto que só COMEÇA com o alfinete segue como texto (quem decide, depois, é a API)", async () => {
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: evento({ text: "📍 minha casa é a do portão azul", platformMessageId: "wamid.TXT" }),
    });
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(ins).toMatchObject({ type: "text", body: "📍 minha casa é a do portão azul" });
  });

  it("o mesmo pedido de nova busca no caminho da conversa JÁ associada à thread", async () => {
    conversaExistente = { id: "conv-existente", contact_id: "contact-1" };
    const f = vi.spyOn(globalThis, "fetch");
    await ingestZernioInbound(admin, { ...ENTRADA, payload: pinoSemCoordenadas() });
    expect(f).not.toHaveBeenCalled();
    expect(pediuNovaBusca()).toMatchObject({ p_payload: { message_id: "msg-1", external_id: "wamid.PINO" } });
  });

  it("texto comum não consulta a API — nem pede nova busca", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(f).not.toHaveBeenCalled();
    expect(pediuNovaBusca()).toBeUndefined();
  });
});

describe("o que a ingestão RECUSA", () => {
  const recusa = async (payload: unknown, motivo: string) => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload });
    expect(r.status).toBe("ignored");
    expect(r.reason).toBe(motivo);
    expect(ops.some((o) => o.tabela === "messages")).toBe(false);
  };

  it("outra plataforma na mesma conta", () =>
    recusa(evento({ platform: "instagram" }), "evento_sem_interesse"));

  it("sem identidade utilizável — criar contato anônimo faria a próxima mensagem virar um segundo contato", () =>
    recusa(evento({ sender: { whatsappUsername: "@x" } }), "sem_identidade_utilizavel"));
});

describe("a THREAD é a prova de identidade", () => {
  it("conversa já associada à thread REUSA o contato — não cria um segundo", async () => {
    // O defeito que apareceu em produção: a entrada traz o BSUID (âncora
    // preferida) e a saída só traz o telefone do participante. Resolver pela
    // âncora criava DOIS contatos e DUAS conversas para a mesma pessoa, ambas
    // apontando para a mesma thread do provider.
    conversaExistente = { id: "conv-existente", contact_id: "contato-existente" };
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });

    expect(r.conversationId).toBe("conv-existente");
    // E NÃO cria contato nem conversa novos.
    expect(ops.some((o) => o.op === "fn_upsert_wa_contact")).toBe(false);
    expect(ops.some((o) => o.op === "fn_upsert_wa_conversation")).toBe(false);
  });

  it("a mensagem entra na conversa achada pela thread", async () => {
    conversaExistente = { id: "conv-existente", contact_id: "contato-existente" };
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")
      ?.payload as Record<string, unknown>;
    expect(ins.conversation_id).toBe("conv-existente");
    expect(ins.contact_id).toBe("contato-existente");
  });

  it("sem conversa para a thread, cai no caminho normal e CRIA", async () => {
    conversaExistente = null;
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(ops.some((o) => o.op === "fn_upsert_wa_contact")).toBe(true);
  });
});

describe("envio feito FORA do CRM aparece no histórico", () => {
  it("mensagem de saída entra como outbound", async () => {
    // Mandada do celular do operador, ou por outra plataforma na mesma conta.
    // Antes era descartada, e o histórico do cliente ficava pela metade.
    const r = await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: {
        ...evento({ direction: "outgoing" }),
        event: "message.sent",
        conversation: { participantId: "595991733685", participantName: "Cliente" },
      },
    });
    expect(r.status).toBe("ingested");
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")
      ?.payload as Record<string, unknown>;
    expect(ins.direction).toBe("outbound");
    expect(ins.status).toBe("sent");
  });

  it("o eco do NOSSO envio vira duplicate, não linha repetida", async () => {
    // A proteção contra duplicar já existia: unique (org, external_id).
    insertErro = { code: "23505", message: "duplicate key" };
    const r = await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: {
        ...evento({ direction: "outgoing" }),
        event: "message.sent",
        conversation: { participantId: "595991733685" },
      },
    });
    expect(r.status).toBe("duplicate");
  });
});

describe("clique em anúncio", () => {
  it("o referral em metadata marca o contato como vindo do anúncio (primeiro toque)", async () => {
    // Forma real do Zernio (24/09/2026): `metadata.referral`, no nível do evento.
    const r = await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: {
        ...evento(),
        metadata: {
          referral: { ctwa_clid: "ARAkZ_sintetico", source_id: "1202", source_type: "ad", headline: "FRETE GRÁTIS" },
        },
      },
    });
    expect(r.status).toBe("ingested");
    const estampa = ops.find((o) => o.tabela === "rpc" && o.op === "fn_estampar_atribuicao_de_anuncio");
    expect(estampa?.payload).toMatchObject({
      p_org: "org-1",
      p_platform: "meta_ads",
      p_metadata: { ad_source_id: "ARAkZ_sintetico", ad_id: "1202", ad_title: "FRETE GRÁTIS" },
    });
  });
});

describe("desfecho de entrega", () => {
  const statusEvt = (event: string, extra: Record<string, unknown> = {}) => ({
    ...evento({ direction: "outgoing" }),
    event,
    conversation: { participantId: "595991733685" },
    ...extra,
  });

  it("delivered ATUALIZA, não insere — senão haveria uma linha por transição", async () => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: statusEvt("message.delivered") });
    expect(r.reason).toBe("status_delivered");
    expect(ops.some((o) => o.tabela === "messages" && o.op === "insert")).toBe(false);
    const up = ops.find((o) => o.tabela === "messages" && o.op === "update");
    expect(up?.payload).toMatchObject({ status: "delivered" });
  });

  it("failed grava o motivo — é o que o operador lê para saber o que fazer", async () => {
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: statusEvt("message.failed", {
        error: { code: 131047, title: "Re-engagement message", explanation: "Janela fechada." },
      }),
    });
    const up = ops.find((o) => o.tabela === "messages" && o.op === "update");
    expect(String((up?.payload as Record<string, unknown>).error_message)).toContain("131047");
  });

  it("delivered carimba delivered_at com a hora do WhatsApp, uma vez só", async () => {
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: statusEvt("message.delivered", { statusAt: "2026-09-24T16:10:35.000Z" }),
    });
    const carimbo = ops.find(
      (o) => o.tabela === "messages" && o.op === "update" && (o.payload as Record<string, unknown>)?.delivered_at,
    );
    expect(carimbo?.payload).toEqual({ delivered_at: "2026-09-24T16:10:35.000Z" });
    expect(ops.some((o) => o.tabela === "messages" && o.op === "update.is" && o.payload === "delivered_at")).toBe(true);
    expect(ops.some((o) => (o.payload as Record<string, unknown> | undefined)?.read_at)).toBe(false);
  });

  it("read carimba read_at — e delivered_at, se a entrega nunca foi carimbada", async () => {
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: statusEvt("message.read", { statusAt: "2026-09-24T14:24:23.000Z" }),
    });
    const carimbos = ops
      .filter((o) => o.tabela === "messages" && o.op === "update" && !("status" in ((o.payload as object) ?? {})))
      .map((o) => o.payload);
    expect(carimbos).toEqual([
      { delivered_at: "2026-09-24T14:24:23.000Z" },
      { read_at: "2026-09-24T14:24:23.000Z" },
    ]);
    const guardas = ops.filter((o) => o.tabela === "messages" && o.op === "update.is").map((o) => o.payload);
    expect(guardas).toEqual(["delivered_at", "read_at"]);
  });

  it("NÃO rebaixa: um delivered atrasado não desfaz um read", async () => {
    // A ordem de entrega do webhook não é garantida.
    await ingestZernioInbound(admin, { ...ENTRADA, payload: statusEvt("message.delivered") });
    const naoRebaixa = ops.find(
      (o) => o.tabela === "messages" && o.op === "update.not" && o.payload === "status",
    );
    expect(naoRebaixa, "falta o guard que impede rebaixar de read para delivered").toBeTruthy();
  });
});

describe("idempotência", () => {
  it("reentrega do MESMO evento devolve duplicate, não erro", async () => {
    // O provider reenvia o que não recebeu 200. Tratar como falha faria a rota
    // devolver 500 e ele reenviar de novo, para sempre.
    insertErro = { code: "23505", message: "duplicate key" };
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(r.status).toBe("duplicate");
  });

  it("outro erro de escrita LANÇA — aí a reentrega é o que queremos", async () => {
    insertErro = { code: "42501", message: "permission denied" };
    await expect(
      ingestZernioInbound(admin, { ...ENTRADA, payload: evento() }),
    ).rejects.toThrow(/zernio_ingest_insert_failed/);
  });
});

describe("falha de banco não vira `ignored`", () => {
  // A resposta já saiu quando a ingestão roda: `ignored` fecha a linha como
  // processada e a mensagem some. Lançar é o que a deixa pendente para o cron.
  it("a RPC do contato falhou: lança", async () => {
    rpcResposta.fn_upsert_wa_contact = null;
    await expect(ingestZernioInbound(admin, { ...ENTRADA, payload: evento() })).rejects.toThrow(
      /zernio_contact_upsert_failed/,
    );
  });

  it("a RPC da conversa falhou: lança", async () => {
    rpcResposta.fn_upsert_wa_conversation = null;
    await expect(ingestZernioInbound(admin, { ...ENTRADA, payload: evento() })).rejects.toThrow(
      /zernio_conversation_upsert_failed/,
    );
  });

  it("a leitura pela thread falhou: lança antes de criar contato", async () => {
    erroDaThread = { code: "57014", message: "canceling statement due to statement timeout" };
    await expect(ingestZernioInbound(admin, { ...ENTRADA, payload: evento() })).rejects.toThrow(
      /zernio_thread_lookup_failed/,
    );
    expect(ops.some((o) => o.op === "fn_upsert_wa_contact"), "falha de leitura virou contato novo").toBe(false);
  });

  it("controle: duas conversas na mesma thread não são falha de banco, e a âncora resolve", async () => {
    erroDaThread = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(r.status).toBe("ingested");
  });

  it("controle: RPC sem erro e sem id segue `ignored` — é ausência, não falha", async () => {
    delete rpcResposta.fn_upsert_wa_contact;
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(r).toEqual({ status: "ignored", reason: "contato_nao_resolvido" });
  });
});

describe("o reprocessamento retoma a mensagem gravada sem os efeitos", () => {
  const SENT_AT = "2026-08-08T01:00:00.000Z";
  const emitidos = (tipo: string) =>
    ops.filter((o) => o.op === "emit_event" && (o.payload as { p_event_type?: string }).p_event_type === tipo);
  const carimbos = () => ops.filter((o) => o.op === "fn_mark_conversation_message");
  const DESPACHO = "ai_agent.dispatch_requested";

  beforeEach(() => {
    insertErro = { code: "23505", message: "duplicate key" };
    mensagemGravada = {
      id: "msg-gravada",
      conversation_id: "conv-1",
      contact_id: "contact-1",
      direction: "inbound",
      sent_at: SENT_AT,
    };
  });

  it("⭐ morreu logo depois do INSERT: carimba uma vez, despacha uma vez, com a mensagem que já existe", async () => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento(), retomada: true });

    expect(r).toEqual({ status: "duplicate", conversationId: "conv-1", reason: "efeitos_retomados" });
    expect(carimbos()).toHaveLength(1);
    expect((carimbos()[0]!.payload as { p_at: string }).p_at).toBe(SENT_AT);
    expect(emitidos(DESPACHO)).toHaveLength(1);
    expect((emitidos(DESPACHO)[0]!.payload as { p_entity_id: string }).p_entity_id).toBe("msg-gravada");
  });

  it("⭐ morreu depois do carimbo: a não lida não soma de novo, e o despacho sai", async () => {
    carimboDaConversa = SENT_AT;
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento(), retomada: true });
    expect(carimbos()).toHaveLength(0);
    expect(emitidos(DESPACHO)).toHaveLength(1);
  });

  it("⭐ o despacho já saiu: nada roda, e não há segundo turno", async () => {
    despachoPedido = true;
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento(), retomada: true });
    expect(r).toEqual({ status: "duplicate", conversationId: "conv-1" });
    expect(carimbos()).toHaveLength(0);
    expect(emitidos(DESPACHO)).toHaveLength(0);
  });

  it("vale também no caminho da conversa já associada à thread", async () => {
    conversaExistente = { id: "conv-1", contact_id: "contact-1" };
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento(), retomada: true });
    expect(r.reason).toBe("efeitos_retomados");
    expect(emitidos(DESPACHO)).toHaveLength(1);
  });

  it("⭐ a entrada ao vivo não retoma: os efeitos da primeira entrega podem estar em curso", async () => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(r).toEqual({ status: "duplicate", conversationId: "conv-1" });
    expect(carimbos()).toHaveLength(0);
    expect(emitidos(DESPACHO)).toHaveLength(0);
  });

  it("saída duplicada não é retomada: é o eco do nosso envio", async () => {
    mensagemGravada = { ...mensagemGravada, direction: "outbound" };
    const r = await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: {
        ...evento({ direction: "outgoing" }),
        event: "message.sent",
        conversation: { participantId: "+595991733685" },
      },
      retomada: true,
    });
    expect(r.reason).toBeUndefined();
    expect(carimbos()).toHaveLength(0);
  });

  it("leitura que falha lança: a linha fica pendente para a rodada seguinte", async () => {
    erroDaRetomada = { message: "canceling statement due to statement timeout" };
    await expect(ingestZernioInbound(admin, { ...ENTRADA, payload: evento(), retomada: true })).rejects.toThrow(
      /zernio_retomada_failed/,
    );
  });
});

describe("a entrada do seam — o que a rota chama", () => {
  const SECRET = "segredo-longo-o-suficiente";
  const corpo = JSON.stringify(evento());
  const firma = createHmac("sha256", SECRET).update(corpo).digest("hex");
  const headers = (v: string | null) => new Headers(v ? { "x-zernio-signature": v } : {});
  const sessao = { id: "sess-1", organization_id: "org-1", provider: "zernio" };

  it("aceita o canal que recebe por aqui e recusa os outros", () => {
    expect(acceptsInboundWebhook("zernio")).toBe(true);
    expect(acceptsInboundWebhook("waha")).toBe(false);
    expect(acceptsInboundWebhook("meta_cloud")).toBe(false);
  });

  it("assinatura válida ingere", async () => {
    const r = await handleInboundWebhook(admin, {
      session: sessao,
      rawBody: corpo,
      headers: headers(firma),
      secret: SECRET,
    });
    expect(r.ok).toBe(true);
  });

  it("assinatura inválida NÃO ingere", async () => {
    const r = await handleInboundWebhook(admin, {
      session: sessao,
      rawBody: corpo,
      headers: headers("deadbeef"),
      secret: SECRET,
    });
    expect(r).toMatchObject({ ok: false, code: "unauthorized" });
    expect(ops.some((o) => o.tabela === "messages")).toBe(false);
  });

  it("SEM segredo utilizável não processa — fail-closed, sem a exceção do vizinho", async () => {
    // Na rota do canal por QR, "não consegui verificar" já virou "processa
    // assim mesmo", e isso deixou toda instalação aceitando mensagem forjada.
    for (const s of [null, "curto"]) {
      const r = await handleInboundWebhook(admin, {
        session: sessao,
        rawBody: corpo,
        headers: headers(firma),
        secret: s,
      });
      expect(r).toMatchObject({ ok: false, code: "unauthorized" });
    }
    expect(ops.some((o) => o.tabela === "messages")).toBe(false);
  });

  it("canal que não recebe por esta rota devolve provider_mismatch", async () => {
    const r = await handleInboundWebhook(admin, {
      session: { ...sessao, provider: "waha" },
      rawBody: corpo,
      headers: headers(firma),
      secret: SECRET,
    });
    expect(r).toMatchObject({ ok: false, code: "provider_mismatch" });
  });

  it("json inválido com assinatura válida devolve invalid_json, não 500", async () => {
    const cru = "{nao é json";
    const f = createHmac("sha256", SECRET).update(cru).digest("hex");
    const r = await handleInboundWebhook(admin, {
      session: sessao,
      rawBody: cru,
      headers: headers(f),
      secret: SECRET,
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("a assinatura cobre o CORPO — adulterar o payload invalida", () => {
    expect(verifyZernioSignature(corpo + " ", firma, SECRET)).toBe(false);
  });
});

describe("o carimbo da conversa — o elo que faltava", () => {
  it("marca a conversa com a mensagem que chegou", async () => {
    // Faltava. Medido em produção: conversa com cinco mensagens do cliente e
    // `last_inbound_at` NULL. Os outros dois canais fazem esta chamada; este
    // ingest a omitia.
    ops.length = 0;
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    const carimbo = ops.find((o) => o.op === "fn_mark_conversation_message");
    expect(carimbo, "a conversa não foi carimbada").toBeTruthy();
    expect(carimbo?.payload).toMatchObject({ p_direction: "inbound" });
  });

  it("usa a hora do PROVIDER, não a da chegada do webhook", async () => {
    // Numa reentrega atrasada as duas diferem por horas — e é desta hora que
    // sai a janela de 24h e a ordem da lista.
    ops.length = 0;
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    const carimbo = ops.find((o) => o.op === "fn_mark_conversation_message");
    expect((carimbo?.payload as { p_at?: string })?.p_at).toBe("2026-08-08T01:00:00.000Z");
  });

  it("saída também carimba — envio feito fora do CRM conta", async () => {
    ops.length = 0;
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      // `conversation.participantId` porque na SAÍDA o `sender` é o negócio: a
      // identidade do cliente vem da conversa, não de quem mandou.
      payload: {
        ...evento({ direction: "outgoing" }),
        event: "message.sent",
        conversation: { participantId: "+595991733685" },
      },
    });
    const carimbo = ops.find((o) => o.op === "fn_mark_conversation_message");
    expect(carimbo?.payload).toMatchObject({ p_direction: "outbound" });
  });
});
