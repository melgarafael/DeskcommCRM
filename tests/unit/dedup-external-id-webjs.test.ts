/**
 * O ENVIO GRAVA A MESMA STRING DE IDENTIDADE QUE O ECO — TAMBÉM NO WEBJS
 * (issue #196, resto da parte (a)).
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 *
 * Desde o #1855 o ECO grava sempre o `bare` (`lib/waha/ingest.ts:external_id:
 * bare`). O ENVIO, porém, grava o id cru que o adapter devolveu
 * (`app/api/v1/messages/_handler.ts` → `external_id: externalId`), e a forma
 * do id depende do ENGINE:
 *
 *     NOWEB  resposta de envio `3EB0…`                       → grava o BARE
 *     WEBJS  resposta de envio `_serialized: true_<chat>_3EB0…` → grava o COMPOSTO
 *
 * No NOWEB os dois lados gravam a MESMA string e o `unique (organization_id,
 * external_id)` recusa a segunda linha com `23505` — é a rede de segurança que
 * o próprio handler já sabe tratar (limpa o eco e carimba de novo). No WEBJS as
 * duas strings são DIFERENTES, o unique nunca dispara, e sobra só o `SELECT`
 * do eco — que lê o mundo de ANTES. O eco que entra DEPOIS da limpeza e ANTES
 * do carimbo nasce como segunda linha com a mesma frase.
 *
 * ─── O conserto ──────────────────────────────────────────────────────────────
 *
 * O carimbo passa a gravar `bareWaMessageId(externalId)` — a forma canônica, a
 * mesma que o eco grava em qualquer engine. O NOWEB não muda (o id dele já é
 * bare: `bareWaMessageId` devolve a string intacta), e o WEBJS passa a colidir:
 * o `23505` que o handler já trata passa a existir também lá. Nenhuma migration
 * e nenhum backfill — os leitores (`handleAck`, `wahaEchoExternalIds`,
 * `removerEcoDoProprioEnvio`, `idCompletoDaMensagem`) procuram o par
 * `[composto, bare]` e o edit/apagar reconstrói o id completo a partir do
 * destinatário (`app/api/v1/messages/[id]/route.ts` resolve o chat do CONTATO,
 * nunca do id gravado).
 *
 * ─── Por que este teste reprova com o código de hoje ─────────────────────────
 *
 * O dublê tem o índice único `(organization_id, external_id)` LIGADO — é a
 * regra de banco da qual o desfecho depende. O WAHA é stubado devolvendo o
 * `_serialized` do WEBJS, e o eco é injetado ENTRE a limpeza e o carimbo, que é
 * a ordem exata da corrida: com o carimbo gravando o COMPOSTO não há colisão
 * nenhuma e a conversa termina com DUAS linhas de mesma frase.
 *
 * ⚠️ Entra pelo `sendMessageHandler` de verdade (não por um model do dedup): o
 * que está em jogo é O QUE O ENVIO GRAVA, e só o caminho de produção escreve
 * aquilo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const OUTRA_CONV = "99999999-9999-4999-8999-999999999999";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

/** A cauda que o WhatsApp chama de id da mensagem. */
const BARE = "3EB0ABCDEF0123456789";
/** O MESMO id na forma que o WEBJS devolve no envio (`_serialized`). */
const SERIALIZADO = `true_5531999998888@c.us_${BARE}`;

type Row = Record<string, unknown>;

function conversationRow(): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    contacts: { phone_number: "+553****8888", wa_identity: null, is_blocked: false },
    channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING" },
  };
}

function dubleCom(preexistentes: Row[] = []) {
  const { supabase, mensagens } = criarDubleDoHandler({
    conversation: conversationRow(),
    mensagensIniciais: preexistentes,
    // Sem o índice não há rede de segurança nenhuma para violar: gravar um id
    // que outra linha já tem passaria batido e o teste mentiria.
    indiceUnicoMensagem: true,
  });
  return { supabase, messages: mensagens };
}

/**
 * A linha que o WEBHOOK cria para o eco — na forma que o eco grava desde o
 * #1855, isto é, o BARE (não o composto).
 */
function ecoDoWebhook(over: Row = {}): Row {
  return {
    id: "eco-1",
    organization_id: ORG,
    conversation_id: CONV,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    external_id: BARE,
    direction: "outbound",
    status: "sent",
    body: "oi",
    sent_via: "external_device",
    ...over,
  };
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };
const input = { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput;

/** WEBJS: a resposta de envio traz o `_serialized` completo. */
function wahaRespondendoWebjs() {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: { _serialized: SERIALIZADO } }), { status: 200 })),
  );
}

/**
 * Injeta o eco logo APÓS a primeira limpeza do eco (`removerEcoDoProprioEnvio`)
 * e antes do UPDATE que carimba o id — exatamente a ordem que a corrida
 * produz. Uma injeção só, para o segundo DELETE (o por sufixo) e a nova
 * limpeza do tratamento de `23505` não reinjetarem.
 */
function ecoDepoisDaLimpeza(supabase: unknown, messages: Row[], eco: Row) {
  const cliente = supabase as { from: (tabela: string) => unknown };
  const from = cliente.from.bind(cliente);
  let injetado = false;
  cliente.from = (tabela: string) => {
    const q = from(tabela) as { delete?: () => { then: PromiseLike<unknown>["then"] } };
    if (tabela !== "messages" || !q.delete) return q;
    const del = q.delete.bind(q);
    q.delete = () => {
      const cadeia = del();
      const then = cadeia.then.bind(cadeia);
      cadeia.then = (ok, falha) =>
        then(
          (v) => {
            if (!injetado) {
              injetado = true;
              messages.push(eco);
            }
            return ok ? ok(v) : v;
          },
          falha,
        ) as never;
      return cadeia;
    };
    return q;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("WEBJS: o envio carima a mesma forma que o eco grava", () => {
  it("o eco que entra entre a limpeza e o carimbo não deixa a frase duas vezes", async () => {
    // O cenário da issue #196 (a) no engine em que a rede de segurança não
    // existia: o eco já gravou o BARE, o envio está prestes a gravar o
    // COMPOSTO — strings diferentes, unique mudo, duas linhas na conversa.
    wahaRespondendoWebjs();
    const { supabase, messages } = dubleCom();
    ecoDepoisDaLimpeza(supabase, messages, ecoDoWebhook());

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.body === "oi");
    expect(daMensagem, "a mesma frase ficou duas vezes na conversa — o unique não pegou").toHaveLength(1);
    expect(
      daMensagem[0]!.sent_via,
      "sobrou a linha do webhook, não a do envio (a do envio é quem carrega a autoria)",
    ).toBe("user");
    expect(daMensagem[0]!.status).toBe("sent");
    expect(
      daMensagem[0]!.external_id,
      "o envio gravou uma forma que o eco nunca vai colidir: o dedup continua sem rede de segurança",
    ).toBe(BARE);
  });

  it("sem eco nenhum, o envio grava a forma canônica e segue `sent`", async () => {
    // Controle de vacuidade: se o carimbo virasse `null` para "não duplicar",
    // o caso de cima passaria perdendo o id — e a mensagem ficaria sem ack.
    wahaRespondendoWebjs();
    const { supabase, messages } = dubleCom();

    await sendMessageHandler(supabase, ctx, input);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
    expect(messages[0]!.status).toBe("sent");
  });

  it("o eco ANTES do envio continua sumindo: a limpeza alcança as duas grafias", async () => {
    // A outra ordem da mesma corrida, que já funcionava e não pode regredir:
    // o eco nasceu primeiro, a limpeza apaga pelo par `[composto, bare]` e o
    // carimbo ocupa o id sem colidir.
    wahaRespondendoWebjs();
    const { supabase, messages } = dubleCom([ecoDoWebhook()]);

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.body === "oi");
    expect(daMensagem, "o eco que chegou primeiro sobreviveu e a frase duplicou").toHaveLength(1);
    expect(daMensagem[0]!.external_id).toBe(BARE);
  });

  it("controle: a mensagem de OUTRA conversa no mesmo intervalo não é engolida", async () => {
    // Sem este controle, um dedup que recusasse tudo passaria nos casos acima.
    // O eco é de outro id, o unique não vê colisão nenhuma e as DUAS linhas
    // têm de ficar — perder mensagem é pior que duplicar.
    wahaRespondendoWebjs();
    const outroEco = ecoDoWebhook({ id: "eco-2", conversation_id: OUTRA_CONV, body: "outra" });
    const { supabase, messages } = dubleCom();
    ecoDepoisDaLimpeza(supabase, messages, outroEco);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.find((m) => m.body === "outra"), "comeu mensagem que não era eco").toBeDefined();
    expect(messages.filter((m) => m.body === "oi")).toHaveLength(1);
  });
});

/**
 * GRUPO: o eco de grupo grava o id INTACTO (`ingerirMensagemDeGrupo` em
 * `lib/waha/ingest.ts` passa `p.id` a `lib/grupos/ingest.ts`), não a cauda.
 * Reduzir o id do envio aqui faria as duas strings divergirem de novo — a
 * corrida que o caso individual fecha reabriria espelhada no grupo. E o id de
 * grupo pode trazer o participante como 4º segmento: a "cauda" seria o JID do
 * participante, a mesma string para todo envio da sessão no grupo.
 */
describe("WEBJS em GRUPO: o envio grava o id intacto, como o eco de grupo", () => {
  const GRUPO = "120363000000000000@g.us";
  const ID_GRUPO_3 = `true_${GRUPO}_${BARE}`;
  const ID_GRUPO_4 = `true_${GRUPO}_${BARE}_5531999998888@c.us`;

  function dubleDeGrupo() {
    const { supabase, mensagens } = criarDubleDoHandler({
      conversation: { ...conversationRow(), is_group: true, group_chat_id: GRUPO },
      indiceUnicoMensagem: true,
    });
    return { supabase, messages: mensagens };
  }

  function wahaRespondendo(serializado: string) {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "hash123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: { _serialized: serializado } }), { status: 200 })),
    );
  }

  it.each([
    ["3 segmentos", ID_GRUPO_3],
    ["4 segmentos (com participante)", ID_GRUPO_4],
  ])("%s: grava o id composto, a mesma string que o eco de grupo grava", async (_rotulo, serializado) => {
    wahaRespondendo(serializado);
    const { supabase, messages } = dubleDeGrupo();

    await sendMessageHandler(supabase, ctx, input);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.external_id, "o envio reduziu o id de grupo: o eco de grupo nunca colide").toBe(serializado);
    expect(messages[0]!.status).toBe("sent");
  });

  it.each([
    ["3 segmentos", ID_GRUPO_3],
    ["4 segmentos (com participante)", ID_GRUPO_4],
  ])("%s: o eco de grupo entre a limpeza e o carimbo não deixa a frase duas vezes", async (_rotulo, serializado) => {
    wahaRespondendo(serializado);
    const { supabase, messages } = dubleDeGrupo();
    ecoDepoisDaLimpeza(supabase, messages, ecoDoWebhook({ external_id: serializado }));

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.body === "oi");
    expect(daMensagem, "a mesma frase ficou duas vezes no grupo — o unique não pegou").toHaveLength(1);
    expect(daMensagem[0]!.sent_via).toBe("user");
    expect(daMensagem[0]!.external_id).toBe(serializado);
  });
});
