/**
 * #3138 — O ECO DA NOSSA PRÓPRIA MENSAGEM NÃO PODE PAUSAR A IA QUANDO A LINHA
 * DO ENVIO FICOU `sent` SEM O ID DO CANAL.
 *
 * Defeito relatado (v1.86.0, WAHA NOWEB, contato @lid): a IA responde
 * (`messages.sent_via = ai`), o eco volta pelo webhook 4 s depois e o app pausa
 * a IA por 1 h — `[atendimento-manual] IA pausada — pessoa respondeu pelo
 * canal`, `bot_silenced_until = +1h` — seguido de linha duplicada e de
 * `waha.ingest: lead nao criado a partir do celular`. Ninguém digitou nada no
 * aparelho.
 *
 * ─── Onde a régua estava cega (medido na main, com arquivo:linha) ───────────
 *
 *   lib/waha/ingest.ts:1393   dedup por `external_id` — a régua por ID, a
 *                             primeira e a mais forte: se QUALQUER linha já tem
 *                             o id do evento, o eco sai antes da decisão;
 *   lib/waha/ingest.ts:1558   `ehEcoDeEnvioNosso` — a segunda régua, para a
 *                             janela em que a linha do envio AINDA NÃO tem o
 *                             id. Era ela que exigia
 *                             `status in ('queued','sending')`;
 *   lib/waha/ingest.ts:1596   `pausarIaPorAtendimentoManual` — a pausa.
 *
 * A linha NOSSA `sent` + `external_id null` não é acidente: é desfecho escrito
 * de propósito em dois caminhos nossos, os dois com o comentário do "saiu e
 * fica `sent` sem o id":
 *
 *   app/api/v1/messages/_handler.ts:1254-1257   o eco venceu o unique duas
 *     vezes; "a mensagem SAIU e fica `sent` sem o id — nunca `queued`, que é
 *     pedir para ser reenviada";
 *   lib/agent-engine/edge/crm/session-reconciler.ts:471-479   o watchdog
 *     reenviou, o eco já ocupava o id (`markRedriveSent` devolve true), o
 *     `removeRedriveEcho` apaga a linha do eco e o `stampExternalIdAfterEcho`
 *     é BLINDADO — se ele falhar, a linha NOSSA fica `sent` sem id e a do eco
 *     já não existe.
 *
 * Com a linha do eco apagada (é o trabalho declarado das duas limpezas) e a
 * nossa sem id, uma REENTREGA do mesmo eco — o WAHA reentrega, e `message` e
 * `message.any` chegam os dois pelo mesmo roteador — não tem nada para casar:
 * o dedup não acha id, a re-checagem pós-insert exige uma linha NOSSA com o
 * id, e a régua da janela recusava a linha porque o status já dizia `sent`. O
 * eco do nosso próprio envio era lido como "uma pessoa respondeu pelo canal".
 *
 * ─── O que este arquivo prova, pelo caminho REAL (`dispatchWahaEvent`) ──────
 *
 *   1. ⭐ linha NOSSA que SAIU (`sent`) sem o id + eco com o MESMO texto do
 *      envio -> a IA NÃO é pausada (nenhuma escrita de `bot_silenced_until`,
 *      nenhum log de pausa). VERMELHO antes do conserto: o `status='sent'` era
 *      recusado na régua da janela;
 *   2. CONTROLE: mesma linha, texto DIFERENTE (digitação de verdade no
 *      aparelho) -> a IA É pausada, com o log e o rastro de sempre;
 *   3. CONTROLE: nenhuma linha nossa -> qualquer mensagem do celular pausa;
 *   4. catraca do ID: a linha NOSSA já com o id do canal -> não pausa e não
 *      duplica (a régua por ID, que já rodava antes do conserto — este caso
 *      fica verde nos dois mundos, e é ele que prova que o conserto não
 *      substituiu a régua por ID).
 *
 * A régua do conserto não é texto: o sinal é o ESTADO DA LINHA (saiu para o
 * canal e ainda não tem o id do canal), e a comparação de corpo que já existia
 * não foi ampliada — quem digitar outra frase continua pausando a IA (caso 2).
 */
import { describe, expect, it, vi } from "vitest";

const logs: Array<{ nivel: string; mensagem: string }> = [];
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (mensagem: string) => {
      logs.push({ nivel: "info", mensagem });
    },
    warn: (mensagem: string) => {
      logs.push({ nivel: "warn", mensagem });
    },
    error: (mensagem: string) => {
      logs.push({ nivel: "error", mensagem });
    },
    debug: () => {},
  },
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => false }));

// `lib/waha/ingest.ts` alcança `lib/env.ts` (que valida na importação) e o
// vigia de saúde do canal. Mesma isca dos arquivos irmãos.
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
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

const ORG = "org-1";
const CONVERSA = "conversa-1";
const TEXTO = "Consigo te colocar amanhã às 15h. Fica bom?";
/** O id do canal (NOWEB devolve a cauda crua; o webhook entrega o composto). */
const BARE = "3EB0C824A1B2C3D4E5F607";

interface Linha {
  id: string;
  organization_id: string;
  conversation_id: string;
  external_id: string | null;
  direction: string;
  status: string;
  sent_via: string;
  body: string | null;
  type: string;
  created_at: string;
  updated_at: string;
  [k: string]: unknown;
}

type Filtro = [string, unknown, "eq" | "in" | "neq" | "is" | "gte"];

/**
 * Dublê HONESTO: aplica os filtros de verdade (`eq`/`in`/`neq`/`is`/`gte`), e
 * inclusive o filtro de `status` — é justamente ele que separa o mundo com o
 * defeito do mundo consertado. Um dublê que respondesse pelo cenário (como o de
 * `waha-ingest-atendimento-manual.test.ts` faz, de propósito lá) deixaria este
 * arquivo verde pelos dois lados e não provaria nada.
 */
function banco(linhas: Linha[]) {
  const messages: Linha[] = linhas.map((l) => ({ ...l }));
  const conversa: Record<string, unknown> = { id: CONVERSA, organization_id: ORG, bot_silenced_until: null };
  const atualizacoesDaConversa: Array<Record<string, unknown>> = [];

  const casa = (m: Linha, filtros: Filtro[]) =>
    filtros.every(([coluna, valor, op]) => {
      if (op === "in") return (valor as unknown[]).includes(m[coluna]);
      if (op === "neq") return m[coluna] !== valor;
      if (op === "is") return valor === null ? m[coluna] === null : m[coluna] === valor;
      if (op === "gte") return String(m[coluna]) >= String(valor);
      return m[coluna] === valor;
    });

  const consultaDeMessages = (acao: "select" | "delete") => {
    const filtros: Filtro[] = [];
    const q: Record<string, unknown> = {
      eq: (c: string, v: unknown) => {
        filtros.push([c, v, "eq"]);
        return q;
      },
      in: (c: string, v: unknown[]) => {
        filtros.push([c, v, "in"]);
        return q;
      },
      neq: (c: string, v: unknown) => {
        filtros.push([c, v, "neq"]);
        return q;
      },
      is: (c: string, v: unknown) => {
        filtros.push([c, v, "is"]);
        return q;
      },
      gte: (c: string, v: unknown) => {
        filtros.push([c, v, "gte"]);
        return q;
      },
      order: () => q,
      limit: () => q,
      async maybeSingle() {
        if (acao === "delete") return { data: null, error: null };
        const achou = messages.find((m) => casa(m, filtros));
        return { data: achou ? { id: achou.id, body: achou.body, type: achou.type } : null, error: null };
      },
      then(ok: (v: unknown) => unknown) {
        if (acao === "delete") {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && casa(m, filtros)) messages.splice(i, 1);
          }
          return Promise.resolve(ok({ error: null }));
        }
        return Promise.resolve(ok({ data: messages.filter((m) => casa(m, filtros)), error: null }));
      },
    };
    return q;
  };

  const tabela = (nome: string) => {
    if (nome === "messages") {
      return {
        select: () => consultaDeMessages("select"),
        delete: () => consultaDeMessages("delete"),
        insert: (linha: Record<string, unknown>) => ({
          select: () => ({
            async maybeSingle() {
              const externo = (linha.external_id ?? null) as string | null;
              // O `unique (organization_id, external_id)` do Postgres.
              const duplicada =
                externo !== null &&
                messages.some(
                  (m) =>
                    m.organization_id === linha.organization_id && m.external_id !== null && m.external_id === externo,
                );
              if (duplicada) {
                return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
              }
              const nova = { id: `eco-${messages.length + 1}`, ...linha } as Linha;
              messages.push(nova);
              return { data: { id: nova.id }, error: null };
            },
          }),
        }),
        update: () => {
          const enc: Record<string, unknown> = { error: null };
          enc.eq = () => enc;
          enc.in = () => enc;
          enc.maybeSingle = async () => ({ data: null, error: null });
          enc.then = (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: null, error: null }));
          return enc;
        },
      };
    }

    if (nome === "conversations") {
      return {
        select: (cols?: string) => {
          const q: Record<string, unknown> = {
            eq: () => q,
            in: () => q,
            is: () => q,
            limit: () => q,
            async maybeSingle() {
              // A pausa lê `bot_silenced_until`; `agenteAceitaComandoDeCelular`
              // lê `channel_session_id, active_ai_agent_id` e espera null.
              return (cols ?? "").includes("bot_silenced_until")
                ? { data: { bot_silenced_until: conversa.bot_silenced_until }, error: null }
                : { data: null, error: null };
            },
            then: (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: null, error: null })),
          };
          return q;
        },
        update: (patch: Record<string, unknown>) => {
          atualizacoesDaConversa.push(patch);
          Object.assign(conversa, patch);
          const enc: Record<string, unknown> = { error: null };
          enc.eq = () => enc;
          enc.in = () => enc;
          // A pausa termina o UPDATE com `select("id")` e confere as linhas
          // afetadas (#534): o dublê devolve a linha, como o supabase-js.
          enc.select = () => enc;
          enc.then = (ok: (v: unknown) => unknown) =>
            Promise.resolve(ok({ data: [{ id: "conversa-1" }], error: null }));
          return enc;
        },
      };
    }

    // Qualquer outra tabela: vazia. `crm_leads` responde uma linha para o
    // controle exercitar o mesmo desfecho do relato ("lead nao criado a partir
    // do celular"), que só roda no ramo que NÃO é eco.
    const vazio = (): { data: unknown; error: null } =>
      nome === "crm_leads" ? { data: { id: "lead-1" }, error: null } : { data: null, error: null };
    const generico: Record<string, unknown> = {
      eq: () => generico,
      in: () => generico,
      neq: () => generico,
      is: () => generico,
      gte: () => generico,
      limit: () => generico,
      order: () => generico,
      maybeSingle: async () => vazio(),
      single: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(ok(vazio())),
    };
    return {
      select: () => generico,
      update: () => generico,
      insert: () => ({ ...generico, select: () => generico }),
      delete: () => generico,
      upsert: () => generico,
    };
  };

  const admin = {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string) => {
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: CONVERSA, error: null };
      if (fn === "fn_mark_conversation_message") return { data: null, error: null };
      return { data: null, error: null };
    },
  };

  return { admin, messages, conversa, atualizacoesDaConversa };
}

const SESSION = { id: "sessao-1", organization_id: ORG };
const envelope = (p: WahaPayload): WahaEnvelope => ({ event: "message.any", session: "default", payload: p });

/** O eco de um envio nosso, no formato `@lid` do NOWEB. */
const eco = (body: string): WahaPayload => ({
  id: `true_10200698331209@lid_${BARE}`,
  from: "10200698331209@lid",
  fromMe: true,
  body,
  type: "chat",
  timestamp: Math.floor(Date.now() / 1000),
});

/** A linha NOSSA do envio: `sent_via='ai'`, status `sent`, SEM o id do canal. */
const envioQueSaiuSemId = (over: Partial<Linha> = {}): Linha => ({
  id: "envio-da-ia",
  organization_id: ORG,
  conversation_id: CONVERSA,
  external_id: null,
  direction: "outbound",
  status: "sent",
  sent_via: "ai",
  body: TEXTO,
  type: "chat",
  created_at: new Date(Date.now() - 4_000).toISOString(),
  // A janela do eco mede `updated_at` desde o reenvio (#3192); sem a coluna no
  // dublê, o filtro `gte` comparava "undefined" e passava por acidente.
  updated_at: new Date(Date.now() - 4_000).toISOString(),
  ...over,
});

const logouPausa = () => logs.some((l) => l.mensagem.includes("IA pausada"));
const escreveuSilencio = (us: Array<Record<string, unknown>>) =>
  us.some((u) => "bot_silenced_until" in u);

describe("#3138 — eco da linha que saiu sem id do canal", () => {
  it("⭐ linha NOSSA `sent` sem id + eco com o MESMO texto: a IA NÃO é pausada", async () => {
    const { admin, conversa, atualizacoesDaConversa } = banco([envioQueSaiuSemId()]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-3138-1");

    expect(
      conversa.bot_silenced_until,
      "o eco do nosso próprio envio pausou a IA — a linha que SAIU ficou `sent` sem o id e a régua da janela recusou o status `sent`",
    ).toBeNull();
    expect(escreveuSilencio(atualizacoesDaConversa), "houve escrita de `bot_silenced_until`").toBe(false);
    expect(logouPausa(), "saiu o log `[atendimento-manual] IA pausada — pessoa respondeu pelo canal`").toBe(false);
  });

  it("CONTROLE: mesma linha, texto DIFERENTE (digitação no aparelho) AINDA pausa", async () => {
    const { admin, conversa, atualizacoesDaConversa } = banco([envioQueSaiuSemId()]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope(eco("oi, aqui é o Rafael falando do meu celular")),
      "req-3138-2",
    );

    expect(
      conversa.bot_silenced_until,
      "o atendente respondeu pelo celular e a IA continuou solta — é o #371 de volta",
    ).not.toBeNull();
    expect(escreveuSilencio(atualizacoesDaConversa)).toBe(true);
    expect(logouPausa(), "a pausa tem de deixar o rastro no log").toBe(true);
    expect(
      logs.some((l) => l.mensagem.includes("lead nao criado a partir do celular")),
      "o desfecho do relato some sem o log do funil",
    ).toBe(true);
  });

  it("CONTROLE: sem nenhuma linha nossa, mensagem do celular continua pausando", async () => {
    const { admin, conversa } = banco([]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-3138-3");

    expect(
      conversa.bot_silenced_until,
      "sem linha nossa não há eco possível: toda mensagem `fromMe` é digitação humana",
    ).not.toBeNull();
  });

  it("catraca do ID: a linha NOSSA já com o id do canal não pausa e não duplica", async () => {
    // A régua por ID (dédup em `lib/waha/ingest.ts:1393`) roda ANTES de qualquer
    // decisão sobre a IA. Este caso é verde com e sem o conserto — é ele que
    // prova que o conserto não trocou a régua por ID por outra coisa.
    const { admin, conversa, messages } = banco([envioQueSaiuSemId({ external_id: BARE })]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-3138-4");

    expect(conversa.bot_silenced_until, "a IA foi pausada por ter falado").toBeNull();
    expect(messages, "a frase do nosso envio apareceu duas vezes").toHaveLength(1);
  });

  it("o eco continua sendo GRAVADO: o conserto barra a pausa, nunca o insert (o #108)", async () => {
    const { admin, messages } = banco([envioQueSaiuSemId()]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-3138-5");

    expect(
      messages.length,
      "o gate pulou o INSERT — perder mensagem do celular é o #108",
    ).toBe(2);
  });
});
