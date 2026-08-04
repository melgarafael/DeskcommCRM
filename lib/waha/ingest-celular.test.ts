import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, parseChatId, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

/**
 * A MENSAGEM QUE O DONO DIGITA NO CELULAR TEM QUE CHEGAR NO CRM.
 *
 * Sintoma relatado numa instalação real: o atendente responde pelo WhatsApp do
 * próprio celular e a conversa no CRM não mostra nada — sem erro em lugar
 * nenhum, porque o webhook devolve 200. As mensagens enviadas pelo composer e
 * pela IA apareciam (essas nascem no banco ANTES do webhook), o que fazia o
 * defeito parecer "às vezes some".
 *
 * ⚠️ O TESTE ENTRA PELO CAMINHO DE PRODUÇÃO (`dispatchWahaEvent`). O handler do
 * caso, `handleOutboundFromUserPhone`, é privado: chamá-lo direto provaria a
 * função e mentiria sobre o roteamento — é o roteador que os dois route
 * handlers de webhook chamam, e é onde `fromMe` decide o ramo.
 *
 * O duplo de admin implementa a ÚNICA regra de banco que o desfecho depende: o
 * unique (organization_id, external_id). Sem ela, o teste do eco passaria por
 * não ter constraint nenhuma para violar.
 */

interface LinhaMessage {
  id: string;
  organization_id: string;
  external_id: string | null;
  direction?: string;
  body?: string | null;
  sent_via?: string;
  [k: string]: unknown;
}

interface Duplo {
  admin: unknown;
  messages: LinhaMessage[];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

/** Admin de mentira com um "banco" em memória só de `messages`. */
function bancoDeMentira(preexistentes: Array<Partial<LinhaMessage>> = []): Duplo {
  const messages: LinhaMessage[] = preexistentes.map((m, i) => ({
    id: `pre-${i + 1}`,
    organization_id: "org-1",
    external_id: null,
    ...m,
  }));
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const consulta = () => {
    let org: string | null = null;
    let externos: string[] = [];
    const q = {
      eq(coluna: string, valor: string) {
        if (coluna === "organization_id") org = valor;
        return q;
      },
      in(coluna: string, valores: string[]) {
        if (coluna === "external_id") externos = valores;
        return q;
      },
      limit() {
        return q;
      },
      async maybeSingle() {
        const achou = messages.find(
          (m) => m.organization_id === org && m.external_id !== null && externos.includes(m.external_id),
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
    update: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
  });

  const admin = {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      // Sem os ids de retorno o ingest desiste antes do insert e o teste
      // passaria por não ter exercitado nada.
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };

  return { admin, messages, rpcs };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };

function envelope(payload: WahaPayload): WahaEnvelope {
  return { event: "message.any", session: "default", payload };
}

/**
 * Payload REAL capturado numa instalação com o engine NOWEB (o padrão do kit),
 * quando o dono digita no celular. Note o que NÃO existe aqui: `to`.
 */
const CELULAR_NOWEB: WahaPayload = {
  id: "true_250302204792918@lid_2A1B890FB8AA87730CBC",
  from: "250302204792918@lid",
  fromMe: true,
  body: "respondi por aqui mesmo",
  timestamp: 1_760_000_000,
};

describe("mensagem digitada no celular do dono (fromMe)", () => {
  it("NOWEB sem `to`: a mensagem é gravada como outbound", async () => {
    const { admin, messages, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR_NOWEB), "req-1");

    expect(messages, "a mensagem do celular sumiu — o webhook devolveu 200 e nada foi gravado").toHaveLength(1);
    expect(messages[0]!.external_id).toBe(CELULAR_NOWEB.id);
    expect(messages[0]!.direction).toBe("outbound");
    expect(messages[0]!.body).toBe("respondi por aqui mesmo");
    expect(messages[0]!.sent_via).toBe("external_device");

    // O contato tem que ser o CHAT (o cliente), com a identidade @lid preservada.
    const contato = rpcs.find((c) => c.fn === "fn_upsert_wa_contact");
    expect(contato!.args.p_chat_id).toBe("250302204792918@lid");
    expect(contato!.args.p_lid).toBe("250302204792918");
  });

  it("controle: o MESMO payload COM `to` sempre gravou — a única variável é a ausência de `to`", async () => {
    // Isola a causa. Se este caso também falhasse, o defeito estaria em outro
    // lugar (guarda de conteúdo, filtro de grupo, dedup) e não em `p.to ?? ""`.
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ ...CELULAR_NOWEB, to: "250302204792918@lid" }),
      "req-1",
    );

    expect(messages).toHaveLength(1);
  });

  it("o descarte era silencioso porque chatId vazio caía na classificação de grupo", async () => {
    // COMO ERA, e por que o defeito não deixava rastro: `p.to ?? ""` produzia ""
    // e `parseChatId("")` não casava nenhum sufixo conhecido → devolvia `group`.
    // O `return` executado era o do filtro de grupo, uma linha ANTES da guarda
    // que a descrição do PR apontava. Grupo é descarte esperado, então ninguém
    // jamais pensaria em instrumentar ali — daí o silêncio total.
    //
    // COMO É AGORA: string vazia é `unknown`, não `group`. A ausência de dado
    // parou de se disfarçar de decisão de produto, e o descarte emite
    // `whatsapp.chat_id_not_recognized`. Ver ingest-chat-desconhecido.test.ts.
    expect(parseChatId("")).toEqual({ kind: "unknown", phone: null, lid: null });
  });

  it("pushName de mensagem fromMe é do OPERADOR — nunca vira nome do contato", async () => {
    // Sintoma real: dono manda msg do celular p/ cliente novo e o contato nasce
    // na lista como "connectsmartphones" (o nome de WhatsApp da LOJA). Em
    // payload fromMe, _data.pushName identifica o remetente — o operador — e
    // não o destinatário; e o coalesce do fn_upsert_wa_contact congela o nome
    // errado para sempre.
    const { admin, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ ...CELULAR_NOWEB, _data: { pushName: "connectsmartphones" } }),
      "req-1",
    );

    const contato = rpcs.find((c) => c.fn === "fn_upsert_wa_contact");
    expect(contato, "o contato do cliente nem foi criado").toBeDefined();
    expect(contato!.args.p_notify, "outbound batizou o cliente com o nome do operador").toBeNull();
  });
});

describe("controles — o que tem que continuar sendo descartado", () => {
  it("grupo continua fora do CRM mesmo quando o chat vem do id", async () => {
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({
        id: "true_120363000000000000@g.us_2A1B890FB8AA87730CBC",
        from: "120363000000000000@g.us",
        fromMe: true,
        body: "mensagem no grupo",
      }),
      "req-1",
    );

    expect(messages, "grupo não faz binding CRM").toHaveLength(0);
  });

  it("id de 4 segmentos (grupo, formato documentado do WAHA) não cria contato", async () => {
    // A doc do WAHA declara `{fromMe}_{chatId}_{messageId}[_{participant}]` — o
    // 4º segmento existe em GRUPO. Com ele, `chatIdFromWaMessageId` devolve
    // "…@g.us_4CC5…": lixo NÃO-nulo, que por ser não-nulo atropela o `?? p.from`.
    //
    // Hoje o desfecho ainda é o certo, mas por ACIDENTE: `parseChatId` joga
    // qualquer sufixo desconhecido no balde `group`, e grupo é descartado. A
    // segurança mora em ingest.ts, não no parser — então quem mexer no
    // `parseChatId` quebra isto aqui, e é para isso que este caso existe.
    const { admin, messages, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({
        id: "true_11111111111@g.us_4CC5EDD64BC22EBA6D639F2AF571346C_9999@lid",
        from: "11111111111@g.us",
        fromMe: true,
        body: "mensagem de grupo com participant no id",
      }),
      "req-1",
    );

    expect(messages).toHaveLength(0);
    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_contact"), "criou contato a partir do id de grupo").toBe(false);
  });

  it("evento sem corpo e sem mídia continua descartado", async () => {
    // WAHA emite eventos vazios para status/read-receipt/presence.
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope({ ...CELULAR_NOWEB, body: undefined }), "req-1");

    expect(messages).toHaveLength(0);
  });

  it("id sem chat embutido e sem `to` não inventa contato a partir de lixo", async () => {
    const { admin, messages, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ id: "true_naoehchat_2A1B890", fromMe: true, body: "oi" }),
      "req-1",
    );

    expect(messages).toHaveLength(0);
    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_contact")).toBe(false);
  });
});

describe("eco do próprio envio", () => {
  it("linha já gravada com o id bare não vira segunda mensagem", async () => {
    // O envio (composer/IA) grava `external_id` = id bare devolvido pelo WAHA
    // NOWEB (`2A1B…`); o mesmo envio volta pelo webhook com o id COMPOSTO
    // (`true_<chat>_2A1B…`). São strings diferentes: o unique não dispara e
    // nasceria uma segunda linha com a mesma frase.
    const { admin, messages } = bancoDeMentira([
      { organization_id: "org-1", external_id: "2A1B890FB8AA87730CBC", direction: "outbound", body: "respondi por aqui mesmo" },
    ]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR_NOWEB), "req-1");

    expect(messages, "a mesma frase apareceu duas vezes na conversa").toHaveLength(1);
    expect(messages[0]!.external_id).toBe("2A1B890FB8AA87730CBC");
  });

  it("controle: mensagem DIFERENTE no mesmo chat continua entrando", async () => {
    // Sem este controle, um dedup largo demais (que casasse por chat, por
    // exemplo) passaria nas asserções acima engolindo mensagens legítimas.
    const { admin, messages } = bancoDeMentira([
      { organization_id: "org-1", external_id: "OUTRAMENSAGEM111", direction: "outbound" },
    ]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR_NOWEB), "req-1");

    expect(messages).toHaveLength(2);
  });

  it("JANELA CONHECIDA: enquanto o envio está `queued` sem external_id, o eco duplica", async () => {
    // ⚠️ Documenta um defeito conhecido, não o aprova. Se alguém fechar a
    // janela, este caso fica vermelho — e é para ficar: o número certo passa a
    // ser 1, e quem consertar atualiza aqui.
    //
    // O envio (app/api/v1/messages/_handler.ts) grava a linha ANTES de falar com
    // o canal (status `queued`, `external_id` NULL) e só carimba o external_id
    // num UPDATE depois que o adapter responde. O eco que chegar nesse intervalo
    // não encontra nada para casar — nem por id completo, nem por bare.
    //
    // Antes do PR isso não aparecia no NOWEB porque o eco era descartado junto
    // com as mensagens legítimas do celular. É o preço de consertar aquilo: no
    // engine padrão do kit, esta duplicação em corrida é comportamento NOVO.
    const { admin, messages } = bancoDeMentira([
      { organization_id: "org-1", external_id: null, direction: "outbound", body: "respondi por aqui mesmo" },
    ]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR_NOWEB), "req-1");

    expect(messages, "se virou 1, a janela foi fechada — atualize este caso").toHaveLength(2);
  });

  it("o dedup é por organização — o eco de outro tenant não bloqueia o meu", async () => {
    // Service role bypassa RLS: sem o filtro explícito de organization_id, uma
    // linha de OUTRO tenant com o mesmo id faria a mensagem desta org sumir.
    const { admin, messages } = bancoDeMentira([
      { organization_id: "org-2", external_id: "2A1B890FB8AA87730CBC", direction: "outbound" },
    ]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR_NOWEB), "req-1");

    expect(messages, "vazamento entre tenants: o dedup olhou fora da organização").toHaveLength(2);
  });
});

describe("precedência dos três candidatos a chat", () => {
  // `from` = OPERADOR é o cenário WEBJS (no NOWEB, `from` é o próprio chat).
  const WEBJS: WahaPayload = {
    id: "true_5511999999999@c.us_3EB0ABCDEF",
    from: "5599888888888@c.us",
    to: "5511999999999@c.us",
    fromMe: true,
    body: "resposta pelo WhatsApp Web",
  };

  it("`to` vence: com ele presente, o contato é o destinatário", async () => {
    const { admin, rpcs } = bancoDeMentira();
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(WEBJS), "req-1");
    expect(rpcs.find((c) => c.fn === "fn_upsert_wa_contact")!.args.p_chat_id).toBe("5511999999999@c.us");
  });

  it("sem `to`, o id composto vence `from` — mesmo com `from` sendo outro número", async () => {
    // Guarda de vacuidade: o `from` aqui é DIFERENTE do chat do id, senão o caso
    // passaria mesmo que a precedência estivesse invertida.
    const { admin, rpcs } = bancoDeMentira();
    await dispatchWahaEvent(admin as never, SESSION as never, envelope({ ...WEBJS, to: undefined }), "req-1");
    const chat = rpcs.find((c) => c.fn === "fn_upsert_wa_contact")!.args.p_chat_id;
    expect(chat).toBe("5511999999999@c.us");
    expect(chat).not.toBe("5599888888888@c.us");
  });

  it("sem `to` E com id sem chat embutido, `from` VIRA o contato — inclusive no WEBJS", async () => {
    // ⚠️ Este caso documenta um comportamento, não o aprova.
    //
    // No NOWEB está certo: `from` de uma mensagem fromMe É o chat. No WEBJS
    // seria errado — `from` é o número do operador, e o CRM criaria um contato
    // com o próprio número da empresa.
    //
    // O ingest NÃO sabe qual engine falou com ele. O que impede o dano hoje é o
    // WAHA nunca produzir a combinação (sem `to` + id bare) no WEBJS — garantia
    // EXTERNA, não uma proteção do nosso código. Se algum dia produzir, o
    // sintoma é contato fantasma com o número da empresa. Escrito aqui para que
    // isso seja uma decisão consciente e não uma surpresa.
    const { admin, rpcs } = bancoDeMentira();
    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ id: "3EB0ABCDEF", from: "5599888888888@c.us", fromMe: true, body: "oi" }),
      "req-1",
    );
    expect(rpcs.find((c) => c.fn === "fn_upsert_wa_contact")!.args.p_chat_id).toBe("5599888888888@c.us");
  });
});
