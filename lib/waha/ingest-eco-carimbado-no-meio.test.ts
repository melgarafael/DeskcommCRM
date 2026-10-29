/**
 * O ECO QUE O ENVIO CARIMBA NO MEIO DA INGESTÃO — #3165.
 *
 * ─── O defeito (achado na triagem do #3162, na main) ────────────────────────
 *
 * A mensagem `fromMe` sem id é tratada nesta ordem:
 *
 *   1. re-checagem pós-insert (`lib/waha/ingest.ts:1503`);
 *   2. `markConversation` (`lib/waha/ingest.ts:1531`);
 *   3. `ehEcoDeEnvioNosso` (`lib/waha/ingest.ts:96`, chamada em `:1558`).
 *
 * O passo 3 exigia uma linha NOSSA com `external_id` NULO. Se o envio
 * (`limparEco` + `marcarEnviada`, em `app/api/v1/messages/_handler.ts`) gravar
 * `sent` mais o id entre os passos 1 e 3, a guarda já não acha a linha sem id: o
 * eco é lido como resposta humana e a IA pausa por 1 hora. O estado final fica
 * idêntico ao relato do #3138 — uma linha só, a da IA, já com o id.
 *
 * ─── Como esta sonda prova que EXERCITA a corrida ───────────────────────────
 *
 * O dublê carimba o id em TODOS os pontos entre a re-checagem e a decisão, e não
 * num só: ele conta as leituras de `messages` que acontecem depois de o eco ser
 * gravado e deixa o envio confirmar (limparEco + marcarEnviada) exatamente
 * depois da k-ésima delas. O primeiro caso (`sonda:`) mede a janela e afirma, com
 * os retratos das leituras, que a re-checagem rodou ANTES do carimbo e que a
 * leitura da DECISÃO (a que filtra `sent_via` por lista) rodou DEPOIS — as duas
 * coisas no MESMO despacho. Sem essas asserções o verde seria acidental: uma
 * implementação que carimbasse antes da re-checagem (a corrida do #3162) passaria
 * aqui sem nunca ter exercitado a janela que este arquivo mede.
 *
 * ⚠️ O gancho NÃO pode ser o `rpc('fn_mark_conversation_message')`: o carimbo do
 * id não passa por ali, e uma sonda presa naquele ponto fica verde por acaso.
 * Ele também não pode carimbar só "na primeira leitura" — é justamente esse
 * recorte que deixa passar a releitura por id antes da guarda (duas consultas,
 * id primeiro e texto depois): o carimbo cai ENTRE as duas e a IA pausa de novo.
 * Por isso a sonda enumera a janela inteira.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

interface Linha {
  id: string;
  organization_id: string;
  conversation_id?: string;
  external_id: string | null;
  direction?: string;
  status?: string;
  body?: string | null;
  sent_via?: string;
  type?: string;
  [k: string]: unknown;
}

type Filtro = [string, unknown, "eq" | "in" | "neq" | "is"];

/** Retrato de UMA leitura de `messages` feita dentro da janela. */
interface Leitura {
  /** posição na janela: 1 = a re-checagem pós-insert. */
  n: number;
  /** `external_id` da linha do envio NO MOMENTO desta leitura (null = ainda em voo). */
  envioId: string | null;
  /** esta leitura é a DECISÃO de eco (filtra `sent_via` por lista)? */
  decisao: boolean;
}

const BARE = "3EB06FABDB312F95A4EB7B";
const TEXTO = "Olá, Luciano! Somos da RODAÊ bikes elétricas. Teria interesse?\n1. Sim\n2. Não";

/**
 * Dublê do único pedaço do banco que o desfecho depende: `messages` e a linha de
 * `bot_silenced_until` da conversa (é ela que mostra "Automático pausado").
 */
/**
 * O que o carimbo grava na NOSSA linha. `sent` é o `marcarEnviada`; `delivered`
 * (ack 2) e `read` (ack 3) são o `handleAck` chegando logo depois do carimbo —
 * ele acha a linha pela coluna `external_id`, que passa a existir no instante
 * do carimbo. A marca 2 (o id igual) tem de valer nos três.
 */
type Carimbo = { status: "sent" | "delivered" | "read"; ack: number };
const CARIMBO_DO_ENVIO: Carimbo = { status: "sent", ack: 0 };
const CARIMBOS_COM_ACK: Carimbo[] = [
  { status: "delivered", ack: 2 },
  { status: "read", ack: 3 },
];

function banco(opcoes: { carimbarDepoisDaLeitura?: number; carimbo?: Carimbo } = {}) {
  /** O envio do CRM: gravado ANTES de falar com o canal, sem id (`status='queued'`). */
  const envio: Linha = {
    id: "envio-ia",
    organization_id: "org-1",
    conversation_id: "conversa-1",
    external_id: null,
    direction: "outbound",
    status: "queued",
    sent_via: "ai",
    body: TEXTO,
    type: "chat",
  };
  const messages: Linha[] = [envio];
  const conversa: Record<string, unknown> = {
    id: "conversa-1",
    organization_id: "org-1",
    bot_silenced_until: null,
  };

  let ecoInserido = false;
  let envioConfirmou = false;
  const leituras: Leitura[] = [];
  const carimbarDepoisDaLeitura = opcoes.carimbarDepoisDaLeitura ?? null;
  const carimbo = opcoes.carimbo ?? CARIMBO_DO_ENVIO;

  /**
   * O envio confirma: `limparEco` (apaga a linha que o webhook acabou de gravar,
   * a `external_device`) + `marcarEnviada(true)` (`status='sent'` e o id do canal
   * na NOSSA linha). É o par exato de `app/api/v1/messages/_handler.ts`.
   */
  const confirmarEnvio = () => {
    envioConfirmou = true;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.sent_via === "external_device") messages.splice(i, 1);
    }
    Object.assign(envio, { external_id: BARE, status: carimbo.status, ack: carimbo.ack });
  };

  const casa = (m: Linha, filtros: Filtro[]) =>
    filtros.every(([c, v, op]) => {
      if (op === "in") return (v as unknown[]).includes(m[c]);
      if (op === "neq") return m[c] !== v;
      return m[c] === v;
    });

  /**
   * Registra a leitura e — só DEPOIS de ela resolver, portanto antes da próxima
   * — deixa o envio confirmar, quando é a posição pedida. `ecoInserido` marca o
   * começo da janela: a leitura anterior (o `jaRegistrada`, antes do insert) não
   * conta, senão a sonda mediria a corrida do #3162, que já está consertada.
   */
  const anotarLeitura = (filtros: Filtro[]) => {
    if (!ecoInserido) return;
    leituras.push({
      n: leituras.length + 1,
      envioId: envio.external_id,
      decisao: filtros.some(([c, , op]) => c === "sent_via" && op === "in"),
    });
    if (!envioConfirmou && carimbarDepoisDaLeitura === leituras.length) confirmarEnvio();
  };

  const consulta = (acao: "select" | "delete") => {
    const filtros: Filtro[] = [];
    const q: Record<string, unknown> = {
      eq(c: string, v: unknown) {
        filtros.push([c, v, "eq"]);
        return q;
      },
      in(c: string, v: unknown[]) {
        filtros.push([c, v, "in"]);
        return q;
      },
      neq(c: string, v: unknown) {
        filtros.push([c, v, "neq"]);
        return q;
      },
      is(c: string, v: unknown) {
        filtros.push([c, v, "is"]);
        return q;
      },
      gte: () => q,
      order: () => q,
      limit: () => q,
      async maybeSingle() {
        const achou = messages.find((m) => casa(m, filtros));
        const resposta: { data: unknown; error: null } = { data: achou ? { id: achou.id } : null, error: null };
        anotarLeitura(filtros);
        return resposta;
      },
      then(ok: (v: unknown) => unknown) {
        if (acao === "delete") {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && casa(m, filtros)) messages.splice(i, 1);
          }
          return Promise.resolve(ok({ error: null }));
        }
        // Retrato, não referência: cada linha volta COPIADA, como o banco entrega
        // um snapshot por statement. Sem a cópia, o carimbo que cai DEPOIS desta
        // leitura vazaria para dentro de um resultado já resolvido — e a posição
        // k=2 mediria um efeito que não existe em produção (onde a leitura que já
        // respondeu não enxerga o UPDATE seguinte).
        const casadas = messages.filter((m) => casa(m, filtros)).map((m) => ({ ...m }));
        const resposta = { data: casadas, error: null };
        anotarLeitura(filtros);
        return Promise.resolve(ok(resposta));
      },
    };
    return q;
  };

  const tabela = (nome: string) => ({
    select: () =>
      nome === "conversations"
        ? {
            eq() {
              return this;
            },
            async maybeSingle() {
              return { data: { bot_silenced_until: conversa.bot_silenced_until }, error: null };
            },
          }
        : consulta("select"),
    delete: () => consulta("delete"),
    insert: (linha: Record<string, unknown>) => ({
      select: () => ({
        async maybeSingle() {
          if (nome !== "messages") return { data: { id: "x" }, error: null };
          const nova = { id: `eco-${messages.length + 1}`, ...linha } as Linha;
          // O unique `(organization_id, external_id)`: o banco recusa a duplicata.
          const duplicada = messages.some(
            (m) => m.external_id !== null && m.organization_id === nova.organization_id && m.external_id === nova.external_id,
          );
          if (duplicada) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          messages.push(nova);
          ecoInserido = true;
          return { data: { id: nova.id }, error: null };
        },
      }),
    }),
    update: (patch: Record<string, unknown>) => {
      if (nome === "conversations") Object.assign(conversa, patch);
      const enc: Record<string, unknown> = { error: null };
      enc.eq = () => enc;
      enc.in = () => enc;
      return enc;
    },
  });

  const admin = {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string) => {
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };

  return { admin, messages, conversa, envio, leituras };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };
const envelope = (p: WahaPayload): WahaEnvelope => ({ event: "message.any", session: "default", payload: p });

/** O eco real: o envio gravou o id bare (`3EB0…`) e o webhook entrega o composto. */
const eco = (body: string, id = `true_5513996919846@c.us_${BARE}`): WahaPayload => ({
  id,
  from: "5513996919846@c.us",
  fromMe: true,
  body,
  timestamp: 1_760_000_000,
});

const despachar = (b: ReturnType<typeof banco>, p: WahaPayload, req = "req-1") =>
  dispatchWahaEvent(b.admin as never, SESSION as never, envelope(p), req);

/**
 * A janela medida na própria implementação sob teste: quantas leituras de
 * `messages` acontecem depois de o eco ser gravado. A sonda carimba o id depois
 * de CADA uma delas — as posições saem do encadeamento real, não de um chute.
 */
async function medirJanela(): Promise<number> {
  const b = banco();
  await despachar(b, eco(TEXTO), "req-sonda");
  return b.leituras.length;
}

const POSICOES = Array.from({ length: await medirJanela() }, (_, i) => i + 1);

describe("eco carimbado no meio da ingestão (#3165)", () => {
  it("sonda: a janela tem re-checagem e decisão, e o carimbo cai no meio delas", async () => {
    const b = banco({ carimbarDepoisDaLeitura: 1 });

    await despachar(b, eco(TEXTO), "req-sonda-1");

    // Não é vácuo: existem DUAS leituras na janela, e a primeira é a re-checagem.
    expect(
      b.leituras.length,
      "a ingestão não leu `messages` duas vezes depois do insert do eco — a janela que este caso mede não existe",
    ).toBeGreaterThanOrEqual(2);
    expect(
      b.leituras[0]!.decisao,
      "a primeira leitura da janela já é a decisão de eco — a ordem mudou e a sonda está medindo outro caminho",
    ).toBe(false);
    // A re-checagem rodou ANTES do carimbo…
    expect(b.leituras[0]!.envioId, "o carimbo caiu antes da re-checagem: é a corrida do #3162, não a daqui").toBeNull();

    // …e a leitura da decisão rodou DEPOIS, já vendo a NOSSA linha com o id: é
    // esta asserção que prova que a sonda exercita a janela, e não a borda.
    const decisao = b.leituras.find((l) => l.decisao);
    expect(decisao, "nenhuma leitura com o filtro de `sent_via` (a decisão de eco) aconteceu").toBeDefined();
    expect(
      decisao!.envioId,
      "a decisão leu a linha do envio SEM o id — o carimbo não chegou à janela e o verde seria acidental",
    ).toBe(BARE);

    // E, com o id carimbado no meio, a IA não é pausada.
    expect(b.conversa.bot_silenced_until, "a IA foi pausada por ter falado (#3138)").toBeNull();
  });

  for (const k of POSICOES) {
    it(`⭐ carimbo depois da ${k}ª leitura da janela: o eco continua sendo reconhecido e a IA NÃO é pausada`, async () => {
      const b = banco({ carimbarDepoisDaLeitura: k });

      await despachar(b, eco(TEXTO), `req-k${k}`);

      // A sonda só vale se o carimbo aconteceu DURANTE o processamento…
      expect(
        b.envio.external_id,
        "o carimbo não chegou a acontecer — este caso passaria sem exercitar a corrida",
      ).toBe(BARE);
      // …na posição pedida…
      expect(b.leituras.length, `a janela tem menos de ${k} leitura(s): a posição não existe`).toBeGreaterThanOrEqual(k);
      // …e o desfecho é o certo: eco reconhecido, IA solta.
      expect(
        b.conversa.bot_silenced_until,
        `carimbo na ${k}ª leitura: o eco foi lido como resposta humana e a IA pausou por 1 h (#3165)`,
      ).toBeNull();
      // O estado final é o do #3138: uma linha só, a nossa, já com o id.
      expect(b.messages.map((m) => m.id), "a mensagem ficou duas vezes na conversa").toEqual(["envio-ia"]);
      expect(b.messages[0]!.external_id).toBe(BARE);
    });
  }

  for (const carimbo of CARIMBOS_COM_ACK) {
    for (const k of POSICOES) {
      it(`⭐ carimbo + ack \`${carimbo.status}\` depois da ${k}ª leitura: o id igual basta, o status não restringe`, async () => {
        const b = banco({ carimbarDepoisDaLeitura: k, carimbo });

        await despachar(b, eco(TEXTO), `req-${carimbo.status}-k${k}`);

        expect(b.envio.status, "o carimbo não gravou o status pedido — o caso não mede o ack").toBe(carimbo.status);
        expect(
          b.conversa.bot_silenced_until,
          `ack \`${carimbo.status}\` na ${k}ª leitura: a linha carimbada saiu do recorte de status e a IA pausou (#3165)`,
        ).toBeNull();
        expect(b.messages.map((m) => m.id), "a mensagem ficou duas vezes na conversa").toEqual(["envio-ia"]);
      });
    }
  }
});

describe("controles — a decisão de eco não pode ter ficado mais larga", () => {
  it("CONTROLE: envio ainda EM VOO (id nulo, `queued`) + eco do mesmo texto segue reconhecido", async () => {
    const b = banco();

    await despachar(b, eco(TEXTO), "req-ctrl-1");

    expect(b.conversa.bot_silenced_until, "o eco normal voltou a calar a IA (#519 de volta)").toBeNull();
    expect(b.envio.external_id, "a sonda carimbou sem ter sido pedida").toBeNull();
  });

  it("CONTROLE: digitação real no celular (texto diferente) AINDA pausa", async () => {
    const b = banco();

    await despachar(b, eco("oi, é o Cristiano respondendo do celular"), "req-ctrl-2");

    expect(b.conversa.bot_silenced_until, "o atendente respondeu pelo celular e a IA continuou solta (#371)").not.toBeNull();
  });

  it("CONTROLE: sem envio nenhum, qualquer mensagem `fromMe` pausa", async () => {
    const b = banco();
    b.messages.length = 0;

    await despachar(b, eco(TEXTO), "req-ctrl-3");

    expect(b.conversa.bot_silenced_until).not.toBeNull();
  });

  it("CONTROLE: id NOSSO já gravado antes do eco sai pelo dedup de sempre, sem inserir", async () => {
    const b = banco();
    Object.assign(b.envio, { external_id: BARE, status: "sent" });

    await despachar(b, eco(TEXTO), "req-ctrl-4");

    expect(b.conversa.bot_silenced_until).toBeNull();
    expect(b.messages).toHaveLength(1);
  });
});
