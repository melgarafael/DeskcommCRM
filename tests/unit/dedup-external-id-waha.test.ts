/**
 * O ECO DO PRÓPRIO ENVIO GRAVA A MESMA STRING DE IDENTIDADE QUE O ENVIO
 * (issue #196, parte (a)).
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 *
 * Em `handleOutboundFromUserPhone` (`lib/waha/ingest.ts`) o dedup é
 * CHECK-THEN-ACT: um `SELECT ... WHERE external_id IN (composto, bare)` e,
 * só depois, um `INSERT`. Entre as duas chamadas cabem dois RPCs — e é ali que
 * o envio (composer/IA) carimba o `external_id` da linha que nasceu `queued`.
 *
 * O SELECT, portanto, não fecha nada: ele lê o mundo de antes. Quem fecha é o
 * `unique (organization_id, external_id)` — a rede de segurança que o próprio
 * arquivo já usa no inbound (`23505` documentado em `ingest.ts`). Só que ela
 * também não fechava, porque OS DOIS LADOS GRAVAVAM FORMAS DIFERENTES do mesmo
 * id:
 *
 *     envio grava o BARE    2A1B890FB8AA87730CBC
 *     eco   grava o COMPOSTO true_250302204792918@lid_2A1B890FB8AA87730CBC
 *
 * Strings literalmente diferentes → nenhuma colisão → `23505` nunca dispara →
 * nasce a segunda linha com a mesma frase na conversa (e infla qualquer
 * métrica que conte linhas de `messages`).
 *
 * ─── O conserto medido aqui ──────────────────────────────────────────────────
 *
 * O INSERT passa a gravar `bareWaMessageId(p.id)` — a forma canônica, a mesma
 * que o envio grava e a mesma que `handleAck` e `wahaEchoExternalIds` já
 * consultam. Com isso as duas trilhas usam a MESMA string e a colisão passa a
 * existir: o `23505` dispara e o eco é recusado.
 *
 * ─── Por que este teste reprova com o código antigo ──────────────────────────
 *
 * O banco de mentira tem a ÚNICA regra de banco de que o desfecho depende — o
 * unique —, e a opção `carimbaEnvioAntesDoInsert` modela a corrida de verdade:
 * a linha do envio está `queued`/`external_id` NULL quando o SELECT do eco roda
 * (por isso ele não casa nada) e recebe o id ANTES do INSERT do eco (por isso
 * o unique pode agir). É o intervalo exato do check-then-act.
 *
 * COM o código antigo o eco insere o COMPOSTO, não colide com o BARE do envio e
 * a conversa termina com DUAS linhas → o caso reprova. Com o fix ele insere o
 * BARE, colide, recebe `23505`, e `handleOutboundFromUserPhone` devolve sem
 * criar linha → o caso passa.
 *
 * ⚠️ O teste entra pelo CAMINHO DE PRODUÇÃO (`dispatchWahaEvent`): a função do
 * caso é privada e o roteador é onde `fromMe` decide o ramo.
 */
import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

interface LinhaMessage {
  id: string;
  organization_id: string;
  external_id: string | null;
  direction?: string;
  status?: string;
  sent_via?: string;
  body?: string | null;
  [k: string]: unknown;
}

interface Duplo {
  admin: unknown;
  messages: LinhaMessage[];
}

interface Opcoes {
  /**
   * Modela a corrida: quando o INSERT do eco roda, a linha do envio que estava
   * `queued`/NULL carimba este `external_id` — o envio commitou ENTRE o SELECT
   * e o INSERT do eco. Sem isto o cenário não é o da issue: é só um dedup que
   * funciona porque não havia corrida.
   */
  carimbaEnvioAntesDoInsert?: string;
}

const ORG = "org-1";
const SESSION = { id: "sessao-1", organization_id: ORG };

/** A cauda que o WAHA NOWEB devolve no envio e que `_handler.ts` grava. */
const BARE = "2A1B890FB8AA87730CBC";
/** O MESMO id como o webhook do eco o entrega (fromMe composto). */
const COMPOSTO = `true_250302204792918@lid_${BARE}`;

/**
 * Admin de mentira com um "banco" em memória só de `messages`, que implementa
 * as DUAS regras de que o desfecho depende:
 *   1. o dedup por SELECT (leituras `eq/in/is/limit/maybeSingle`);
 *   2. o unique `messages_org_external_id_unique (organization_id, external_id)`
 *      — é ele que devolve `23505`, e é a única coisa que fecha a janela.
 * Sem a 2 o teste passaria por não haver constraint nenhuma para violar.
 */
function bancoDeMentira(preexistentes: Array<Partial<LinhaMessage>> = [], opcoes: Opcoes = {}): Duplo {
  const messages: LinhaMessage[] = preexistentes.map((m, i) => ({
    id: `pre-${i + 1}`,
    organization_id: ORG,
    external_id: null,
    ...m,
  }));

  let corridaFeita = false;

  const consulta = () => {
    let org: string | null = null;
    let externos: string[] = [];
    const filtrosExtras: Array<[string, unknown]> = [];
    // `.neq` filtra de verdade: a busca da linha nossa exclui a recém-inserida.
    const diferentes: Array<[string, unknown]> = [];
    const q = {
      eq(coluna: string, valor: string) {
        if (coluna === "organization_id") org = valor;
        else filtrosExtras.push([coluna, valor]);
        return q;
      },
      in(coluna: string, valores: string[]) {
        if (coluna === "external_id") externos = valores;
        else filtrosExtras.push([coluna, valores]);
        return q;
      },
      neq(coluna: string, valor: unknown) {
        diferentes.push([coluna, valor]);
        return q;
      },
      is(coluna: string, valor: unknown) {
        filtrosExtras.push([coluna, valor]);
        return q;
      },
      gte() {
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return q;
      },
      then(ok: (v: unknown) => unknown) {
        // A checagem de eco (`ehEcoDeEnvioNosso`) lê LISTA; o dedup lê
        // `.maybeSingle()`. Mesmo filtro dos dois lados, para não inventar
        // comportamento que a consulta real não tem.
        const casadas = messages.filter(
          (m) =>
            (org === null || m.organization_id === org) &&
            filtrosExtras.every(([c, v]) => (Array.isArray(v) ? v.includes(m[c]) : (m[c] ?? null) === v)) &&
            diferentes.every(([c, v]) => (m[c] ?? null) !== v),
        );
        return Promise.resolve(ok({ data: casadas, error: null }));
      },
      async maybeSingle() {
        const achou = messages.find(
          (m) =>
            m.organization_id === org &&
            m.external_id !== null &&
            externos.includes(m.external_id) &&
            diferentes.every(([c, v]) => (m[c] ?? null) !== v),
        );
        return { data: achou ? { id: achou.id } : null, error: null };
      },
    };
    return q;
  };

  const tabela = (nome: string) => ({
    select: () => consulta(),
    insert: (linha: Record<string, unknown>) => ({
      select: () => ({
        async maybeSingle() {
          if (nome !== "messages") return { data: { id: "x" }, error: null };

          // A CORRIDA. O SELECT do eco já rodou (e não viu nada: o envio ainda
          // estava NULL); agora o envio carimba. Quem lê é o mundo de depois.
          if (opcoes.carimbaEnvioAntesDoInsert && !corridaFeita) {
            corridaFeita = true;
            const emVoo = messages.find((m) => m.external_id === null);
            if (emVoo) emVoo.external_id = opcoes.carimbaEnvioAntesDoInsert;
          }

          const externo = linha.external_id as string | null;
          const colide =
            externo !== null &&
            messages.some((m) => m.organization_id === linha.organization_id && m.external_id === externo);
          if (colide) {
            return {
              data: null,
              error: { code: "23505", message: 'duplicate key value violates "messages_org_external_id_unique"' },
            };
          }
          const nova = { id: `msg-${messages.length + 1}`, ...linha } as LinhaMessage;
          messages.push(nova);
          return { data: { id: nova.id }, error: null };
        },
      }),
    }),
    // Encadeável em qualquer profundidade/ordem (.eq().in(), .eq().eq()...).
    update: () => {
      const encadeavel: { error: null; eq: () => typeof encadeavel; in: () => typeof encadeavel } = {
        error: null,
        eq: () => encadeavel,
        in: () => encadeavel,
      };
      return encadeavel;
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

  return { admin, messages };
}

function envelope(payload: WahaPayload): WahaEnvelope {
  return { event: "message.any", session: "default", payload };
}

/** Payload real de eco NOWEB: sem `to`, o chat vem embutido no id. */
const ECO: WahaPayload = {
  id: COMPOSTO,
  from: "250302204792918@lid",
  fromMe: true,
  body: "respondi por aqui mesmo",
  timestamp: 1_760_000_000,
};

/** A linha do envio (composer/IA) que nasceu ANTES de falar com o canal. */
const ENVIO_EM_VOO: Partial<LinhaMessage> = {
  direction: "outbound",
  status: "queued",
  sent_via: "ai",
  body: "respondi por aqui mesmo",
  external_id: null,
};

describe("eco do próprio envio — a mesma string de identidade nas duas trilhas", () => {
  it("a janela do check-then-act: o envio carimba entre o SELECT e o INSERT e o eco não nasce", async () => {
    // O cenário da issue #196 (a), linha por linha:
    //   1. o envio grava a linha `queued`, `external_id` NULL;
    //   2. o eco chega e o SELECT do dedup não acha nada (não há id ainda);
    //   3. ENTRE o SELECT e o INSERT o envio carimba o BARE;
    //   4. o INSERT do eco tem de ser recusado pelo unique.
    //
    // Com o código antigo o eco grava o COMPOSTO, o unique não enxerga colisão
    // nenhuma e a conversa termina com duas linhas de mesma frase.
    const { admin, messages } = bancoDeMentira([ENVIO_EM_VOO], { carimbaEnvioAntesDoInsert: BARE });

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(ECO), "req-1");

    expect(messages, "a mesma frase apareceu duas vezes na conversa — o unique não pegou").toHaveLength(1);
    expect(messages[0]!.external_id, "sobreviveu a linha do envio, com o id que ele carimbou").toBe(BARE);
    expect(
      messages.some((m) => m.external_id === COMPOSTO),
      "o eco gravou a forma composta: ela nunca vai colidir com o BARE do envio",
    ).toBe(false);
  });

  it("o INSERT do eco grava a forma canônica (bare), não o id cru que o webhook entrega", async () => {
    // Sem corrida nenhuma — só a forma gravada. É o que faz o unique virar rede
    // de segurança: mesma string dos dois lados, qualquer ordem de escrita.
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(ECO), "req-1");

    expect(messages, "o eco legítimo não pode sumir — perder mensagem é pior que duplicar").toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
    expect(messages[0]!.direction).toBe("outbound");
    expect(messages[0]!.sent_via).toBe("external_device");
  });

  it("controle: um eco de OUTRA mensagem na mesma janela continua sendo inserido", async () => {
    // Sem este controle, um dedup que recusasse tudo passaria nos casos acima.
    // Aqui a corrida existe, mas o id é de outra mensagem: não há colisão, e a
    // linha tem que nascer.
    const OUTRO = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const { admin, messages } = bancoDeMentira([ENVIO_EM_VOO], { carimbaEnvioAntesDoInsert: BARE });

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ ...ECO, id: `true_250302204792918@lid_${OUTRO}` }),
      "req-1",
    );

    expect(messages, "dedup largo demais: engoliu uma mensagem que não era eco").toHaveLength(2);
    expect(messages.some((m) => m.external_id === OUTRO)).toBe(true);
  });

  it("controle: o dedup por SELECT continua valendo quando o envio já commitou antes do eco", async () => {
    // O caso de hoje, que já funcionava e não pode regredir: o SELECT acha o
    // BARE do envio e a função devolve antes de qualquer INSERT.
    const { admin, messages } = bancoDeMentira([{ ...ENVIO_EM_VOO, external_id: BARE }]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(ECO), "req-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
  });
});
