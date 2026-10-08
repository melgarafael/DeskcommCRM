/**
 * O ECO DO PRÓPRIO ENVIO NÃO CALA A IA POR TRÊS HORAS (issue #519).
 *
 * ─── O defeito, medido em c5b45b24 ──────────────────────────────────────────
 *
 * Todo envio do CRM (IA, composer, follow-up, MCP) grava a linha ANTES de falar
 * com o canal: `status='queued'`, `external_id=null`. O `external_id` só existe
 * DEPOIS que o WAHA responde. Nessa janela, o eco do WhatsApp chega com
 * `fromMe: true`, o dedup por `external_id` não casa nada (a linha do envio
 * ainda não tem id), e `handleOutboundFromUserPhone` conclui que um humano
 * respondeu pelo celular:
 *
 *     lib/waha/ingest.ts:857   await silenciarBotPorRetomadaHumana(...)
 *     lib/waha/ingest.ts:47    HUMAN_TAKEOVER_SILENCE_MS = 3 * 60 * 60 * 1000
 *
 * A IA se cala por TRÊS HORAS por ter falado.
 *
 * ⚠️ ATUALIZAÇÃO (merge do #406): as duas linhas citadas acima são do estado em
 * `c5b45b24` e não existem mais. O gesto foi unificado com o dos outros canais
 * em `pausarIaPorAtendimentoManual` (`lib/escalacao/atendimento-manual.ts`), e o
 * prazo virou `PRAZO_DO_SILENCIO_MS`. O DEFEITO é o mesmo, e ficou PIOR de
 * herdar: o #406 propunha `bot_silenced_until='infinity'` neste caminho, ou
 * seja, a IA muda para sempre por ter falado. Estes casos passaram a guardar a
 * chamada nova — a citação acima fica como registro do que foi medido, não como
 * afirmação sobre o código de hoje. E a tela mostra "Automático
 * pausado" — um estado legítimo, que ninguém investiga
 * (`lib/inbox/comando-da-conversa.ts:239` deriva `automaticoAtivo` do silêncio).
 *
 * A janela já estava documentada como defeito aberto na própria suíte:
 * `lib/waha/ingest-celular.test.ts:315` — "JANELA CONHECIDA: enquanto o envio
 * está `queued` sem external_id, o eco duplica".
 *
 * ─── Por que o gate barra o SILÊNCIO e não o INSERT ─────────────────────────
 *
 * O #108 já custou caro nesta casa: casar o eco por proximidade descartou uma
 * mensagem legítima digitada no celular ("esperado 2 mensagens e obtido 1"), e o
 * comentário de `_handler.ts:47-53` registra isso.
 *
 * Por isso as duas decisões, que hoje são uma só, se separam: **gravar a linha
 * continua tolerante** (na dúvida, grava — perder mensagem é pior que duplicar)
 * e **silenciar o bot passa a ser estrito** (na dúvida, não cala — calar a IA
 * por engano é pior que não calar). São direções opostas de propósito.
 *
 * Quem reaproveitar a condição deste gate para pular o INSERT reabre o #108.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";
import { PRAZO_DO_SILENCIO_MS } from "@/lib/escalacao/atendimento-manual";

interface Linha {
  id: string;
  organization_id: string;
  conversation_id?: string;
  external_id: string | null;
  direction?: string;
  status?: string;
  body?: string | null;
  sent_via?: string;
  sent_at?: string | null;
  type?: string;
  [k: string]: unknown;
}

/**
 * Dublê que, além de `messages`, guarda a linha de `conversations` e REGISTRA os
 * updates nela. O dublê do arquivo irmão descarta updates — e é justamente o
 * update de `bot_silenced_until` que este teste precisa ver.
 */
function banco(preexistentes: Array<Partial<Linha>> = []) {
  const messages: Linha[] = preexistentes.map((m, i) => ({
    id: `pre-${i + 1}`,
    organization_id: "org-1",
    conversation_id: "conversa-1",
    external_id: null,
    ...m,
  }));
  const conversa: Record<string, unknown> = {
    id: "conversa-1",
    organization_id: "org-1",
    bot_silenced_until: null,
  };

  const consultaMessages = () => {
    let org: string | null = null;
    let externos: string[] = [];
    const filtros: Array<[string, unknown]> = [];
    // `.neq()` aplicado: a re-checagem pós-insert exclui a linha recém-inserida.
    const diferentes: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {
      neq(coluna: string, valor: unknown) {
        diferentes.push([coluna, valor]);
        return q;
      },
      eq(coluna: string, valor: unknown) {
        if (coluna === "organization_id") org = valor as string;
        else filtros.push([coluna, valor]);
        return q;
      },
      in(coluna: string, valores: string[]) {
        if (coluna === "external_id") externos = valores;
        else filtros.push([coluna, valores]);
        return q;
      },
      is(coluna: string, valor: unknown) {
        // `.is(col, null)` no PostgREST é `col IS NULL` — o dublê tem de aplicar
        // o predicado, senão a consulta que separa "em voo" de "já confirmada"
        // devolveria tudo e o gate passaria pelo motivo errado.
        filtros.push([coluna, valor]);
        return q;
      },
      gte: () => q,
      order: () => q,
      limit: () => q,
      async maybeSingle() {
        const achou = messages.find(
          (m) =>
            m.organization_id === org &&
            m.external_id !== null &&
            externos.includes(m.external_id) &&
            filtros.every(([c, v]) => (Array.isArray(v) ? v.includes(m[c]) : m[c] === v)) &&
            diferentes.every(([c, v]) => m[c] !== v),
        );
        return { data: achou ? { id: achou.id } : null, error: null };
      },
      then(ok: (v: unknown) => unknown) {
        const casadas = messages.filter(
          (m) =>
            (org === null || m.organization_id === org) &&
            filtros.every(([c, v]) => (Array.isArray(v) ? v.includes(m[c]) : m[c] === v)) &&
            (externos.length === 0 || (m.external_id !== null && externos.includes(m.external_id))) &&
            diferentes.every(([c, v]) => m[c] !== v),
        );
        return Promise.resolve(ok({ data: casadas, error: null }));
      },
    };
    return q;
  };

  const consultaConversa = () => {
    const q: Record<string, unknown> = {
      eq: () => q,
      async maybeSingle() {
        return { data: { bot_silenced_until: conversa.bot_silenced_until }, error: null };
      },
    };
    return q;
  };

  const tabela = (nome: string) => ({
    select: () => (nome === "conversations" ? consultaConversa() : consultaMessages()),
    insert: (linha: Record<string, unknown>) => ({
      select: () => ({
        async maybeSingle() {
          if (nome !== "messages") return { data: { id: "x" }, error: null };
          const externo = linha.external_id as string | null;
          if (
            externo !== null &&
            messages.some((m) => m.organization_id === linha.organization_id && m.external_id === externo)
          ) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const nova = { id: `msg-${messages.length + 1}`, ...linha } as Linha;
          messages.push(nova);
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

  return { admin, messages, conversa };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };
const TEXTO = "Thiago, consigo te colocar amanhã às 15h. Fica bom?";

const envelope = (p: WahaPayload): WahaEnvelope => ({
  event: "message.any",
  session: "default",
  payload: p,
});

/** O eco do próprio envio, no formato `@lid_` do NOWEB. */
const eco = (body: string): WahaPayload => ({
  id: "true_10200698331209@lid_3EB0C767D097E9ECA6B1",
  from: "10200698331209@lid",
  fromMe: true,
  body,
  timestamp: 1_760_000_000,
});

/** Uma linha de envio do CRM ainda EM VOO: gravada, sem id do canal. */
const emVoo = (over: Partial<Linha> = {}): Partial<Linha> => ({
  conversation_id: "conversa-1",
  external_id: null,
  direction: "outbound",
  status: "queued",
  sent_via: "ai",
  body: TEXTO,
  type: "chat",
  sent_at: new Date().toISOString(),
  ...over,
});

describe("eco do próprio envio — a IA não se cala por ter falado", () => {
  it("⭐ envio da IA em voo + eco com o MESMO texto: o bot NÃO é silenciado", async () => {
    const { admin, conversa } = banco([emVoo()]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-1");

    expect(
      conversa.bot_silenced_until,
      "a IA se calou por três horas por ter falado — e a tela mostra 'Automático pausado', um estado legítimo que ninguém investiga",
    ).toBeNull();
  });

  it("⭐ CONTROLE POSITIVO: digitação real no celular AINDA silencia", async () => {
    // Sem este caso, um "conserto" que simplesmente removesse a chamada de
    // silêncio ficaria verde — e mataria a feature que o #371 pede.
    const { admin, conversa } = banco([emVoo()]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope(eco("oi, aqui é o Rafael falando do meu celular")),
      "req-2",
    );

    expect(
      conversa.bot_silenced_until,
      "o atendente respondeu pelo celular e a IA continuou solta — é o defeito do #371 de volta",
    ).not.toBeNull();

    // …e o silêncio tem PRAZO. As duas condições ficam LIGADAS de propósito:
    // separadas, um conserto que voltasse a gravar 'infinity' aqui deixaria este
    // caso verde, e a decisão do dono do produto ("sim, mas com prazo") morreria
    // sem nenhum vermelho.
    expect(conversa.bot_silenced_until, "voltou a calar a IA para sempre").not.toBe("infinity");
    const ate = new Date(String(conversa.bot_silenced_until)).getTime();
    expect(Number.isFinite(ate), "bot_silenced_until tem de ser um instante real").toBe(true);
    expect(ate).toBeLessThanOrEqual(Date.now() + PRAZO_DO_SILENCIO_MS);
  });

  it("CONTROLE 2: sem envio em voo, qualquer mensagem do celular silencia", async () => {
    // A janela de tempo sozinha não pode ser o gate: sem uma linha nossa em voo,
    // não há eco possível, e toda mensagem `fromMe` é digitação humana.
    const { admin, conversa } = banco([]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-3");

    expect(conversa.bot_silenced_until).not.toBeNull();
  });

  it("CONTROLE 3: envio em voo com texto DIFERENTE não protege o eco", async () => {
    const { admin, conversa } = banco([emVoo({ body: "outra coisa completamente" })]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-4");

    expect(conversa.bot_silenced_until).not.toBeNull();
  });

  it("o envio do COMPOSER também é protegido — não é privilégio da IA", async () => {
    const { admin, conversa } = banco([emVoo({ sent_via: "user" })]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-5");

    expect(conversa.bot_silenced_until).toBeNull();
  });

  it("o envio da INTEGRAÇÃO (token) também é protegido — o valor novo entrou no filtro", async () => {
    // `system` passou a ser gravado quando o token deixou de se disfarçar de IA
    // (#866). Se o filtro desta checagem continuar em `['ai', 'user']`, a linha
    // da integração não é reconhecida como envio NOSSO: o eco do próprio envio
    // vira "resposta pelo celular" e cala a IA por três horas — o defeito do
    // #519 de volta, por um caminho novo e com o sintoma idêntico.
    const { admin, conversa } = banco([emVoo({ sent_via: "system" })]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-5b");

    expect(
      conversa.bot_silenced_until,
      "a linha gravada pela integração não foi reconhecida como envio nosso: o eco do próprio envio calou a IA",
    ).toBeNull();
  });

  it("⭐ a linha continua sendo GRAVADA — o gate barra o silêncio, nunca o insert", async () => {
    // A direção oposta, e ela é o coração do desenho: gravar é tolerante
    // (perder mensagem é pior que duplicar, é o #108), silenciar é estrito
    // (calar a IA por engano é pior que não calar).
    const { admin, messages } = banco([emVoo()]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-6");

    expect(
      messages.length,
      "o gate pulou o INSERT — isso reabre o #108, em que uma mensagem legítima do celular sumiu",
    ).toBe(2);
  });

  it("silêncio permanente (handoff formal) não é tocado", async () => {
    const { admin, conversa } = banco([emVoo({ body: "digitei no celular" })]);
    conversa.bot_silenced_until = "infinity";

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco("digitei no celular")), "req-7");

    expect(conversa.bot_silenced_until, "encurtou um handoff formal").toBe("infinity");
  });
});

/**
 * O ECO DO ENVIO DA AUTOMAÇÃO (#652).
 *
 * Depois de o carimbo da automação virar `'automation'`, a linha do envio deixa
 * de casar com o filtro de `sent_via` desta checagem — e o eco do próprio envio
 * da regra passa a ser lido como "o atendente respondeu pelo celular". O
 * desfecho é a IA pausada na conversa (a tela mostra "Automático pausado", um
 * estado legítimo que ninguém investiga), causado por uma mensagem que o CRM
 * mandou sozinho.
 *
 * A checagem e o carimbo são duas pontas do MESMO vocabulário: quem mexer numa
 * sem a outra reabre `lib/waha/ingest-celular.test.ts:315` (a janela conhecida
 * em que o eco duplica) do lado de dentro da regra.
 */
describe("eco do envio da automação — reconhecido como nosso (#652)", () => {
  it("⭐ envio da AUTOMAÇÃO em voo + eco com o MESMO texto: o bot NÃO é pausado", async () => {
    const { admin, conversa } = banco([emVoo({ sent_via: "automation" })]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-652-1");

    expect(
      conversa.bot_silenced_until,
      "a regra mandou uma mensagem e a IA ficou pausada por causa do eco dela mesma",
    ).toBeNull();
  });

  it("o envio da automação já CONFIRMADO não vira uma segunda linha na conversa", async () => {
    // O eco depois do ack: a linha do envio já tem `external_id`, o dedup por id
    // casa e nada é inserido. É o caso normal (o eco chega segundos depois do
    // envio voltar), e ele não pode depender do valor de `sent_via`.
    const { admin, messages } = banco([
      emVoo({ sent_via: "automation", external_id: eco(TEXTO).id, status: "sent" }),
    ]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-652-2");

    expect(
      messages.length,
      "a frase da automação apareceu duas vezes na conversa",
    ).toBe(1);
  });

  it("o eco da automação continua GRAVANDO a linha — o gate barra o silêncio, nunca o insert", async () => {
    // A direção oposta, e ela é o desenho do #108: gravar é tolerante (perder
    // mensagem é pior que duplicar), silenciar é estrito. O caso roda para a
    // automação pela mesma razão que roda para a IA e para o composer.
    const { admin, messages } = banco([emVoo({ sent_via: "automation" })]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-652-3");

    expect(messages.length).toBe(2);
  });
});


/**
 * O ECO DO ENVIO ASSINADO (#2066, PR #2079).
 *
 * Com a assinatura do emissor ligada, o que vai ao canal é `*Nome*\ntexto`,
 * mas `messages.body` guarda só `texto` (a assinatura é do canal, não do
 * histórico). O eco do WhatsApp devolve o que SAIU — com a linha do nome. Pela
 * igualdade exata, o eco do próprio envio assinado deixava de casar com a linha
 * em voo e era lido como "o atendente respondeu pelo celular": a IA, assinando
 * as próprias respostas, se calava depois de cada uma delas.
 */
describe("eco do envio assinado — a linha do nome não esconde o eco (#2066)", () => {
  it("⭐ envio da IA em voo + eco com a assinatura da IA: o bot NÃO é pausado", async () => {
    const { admin, conversa } = banco([emVoo()]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope(eco(`*Assistente Virtual*\n${TEXTO}`)),
      "req-2066-1",
    );

    expect(
      conversa.bot_silenced_until,
      "a IA assinou a própria resposta e o eco dela calou a IA — a linha do nome escondeu o eco",
    ).toBeNull();
  });

  it("⭐ envio do atendente em voo + eco com o nome dele: o bot NÃO é pausado", async () => {
    const { admin, conversa } = banco([emVoo({ sent_via: "user" })]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope(eco(`*Carlos Gaban*\n${TEXTO}`)),
      "req-2066-2",
    );

    expect(conversa.bot_silenced_until).toBeNull();
  });

  it("CONTROLE: eco SEM assinatura continua casando pela igualdade de sempre", async () => {
    const { admin, conversa } = banco([emVoo()]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-2066-3");

    expect(conversa.bot_silenced_until).toBeNull();
  });

  it("CONTROLE: linha de nome + texto DIFERENTE do envio em voo ainda silencia", async () => {
    // Tirar a assinatura não pode virar "qualquer mensagem com negrito é eco":
    // o resto do texto continua tendo de ser o MESMO da linha em voo.
    const { admin, conversa } = banco([emVoo()]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope(eco("*Carlos Gaban*\noi, respondi pelo celular")),
      "req-2066-4",
    );

    expect(conversa.bot_silenced_until).not.toBeNull();
  });
});
