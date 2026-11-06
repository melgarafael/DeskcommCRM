import { describe, expect, it, vi } from "vitest";

// `ingest.ts` importa `@/lib/audit` (→ `supabase/server` → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste. Mesma montagem de
// `ingest-celular.test.ts`.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";
import { limparCacheDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";

/**
 * O ECO DO AVISO DE CASO NÃO VIRA CONTATO NEM CONVERSA — EM NENHUM MODO.
 *
 * O aviso sai por TRANSPORTE DIRETO (`criarTransporteDoAviso`), fora do
 * `sendMessageHandler`: ele não nasce como linha em `messages`, e por isso o
 * dedup de eco não o reconhece como nosso. Quem o barra é o corte de
 * `ehNumeroInternoDeAviso`, que precisa rodar ANTES de `upsertContact` — é o
 * INSERT da conversa que dispara o pedido de rodízio pelo banco, então cortar
 * depois já teria criado o "cliente" que na verdade é o plantão.
 *
 * ⚠️ O TESTE ENTRA PELO CAMINHO DE PRODUÇÃO (`dispatchWahaEvent`), não pela
 * função privada: o defeito desta rodada estava no ROTEAMENTO de qual
 * identidade o corte recebe, e chamar `handleOutboundFromUserPhone` direto
 * esconderia exatamente isso.
 *
 * ⚠️ O CASO `@lid` É O QUE FALHAVA. Em modo privacidade o chat chega como
 * `250302204792918@lid` e `parseChatId` devolve `phone: null` — o número
 * cadastrado em `config_aviso_de_caso.telefone_destino` só aparece em
 * `_data.key.remoteJidAlt`. O caminho de ENTRADA já passava
 * `identidadeDoRemetente(p, parsed)`, que injeta esse telefone; o de SAÍDA
 * passava `parsed` cru, e o corte só casava pelo `destino_jid` — que é gravado
 * DEPOIS do envio (`registraJidDoAviso`). Resultado: o primeiro aviso de uma
 * instalação em modo privacidade criava contato e conversa com o número da
 * equipe, rotulados "Celular" (`sent_via: external_device`).
 */

const ORG = "org-1";
const SESSAO = "sessao-1";
/** O número da EQUIPE, como o banco guarda (`config_aviso_de_caso.telefone_destino`). */
const NUMERO_DO_AVISO = "+5519999999999";

interface Duplo {
  admin: unknown;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  inserts: Array<{ tabela: string; linha: Record<string, unknown> }>;
}

/**
 * Admin de mentira com o mínimo que o desfecho depende: as duas tabelas de
 * configuração (a resposta do corte sai delas) e o registro das RPCs de
 * escrita. `config: null` = organização que nunca ligou o aviso.
 */
function bancoDeMentira(
  config: { telefone_destino: string | null; destino_jid: string | null } | null,
): Duplo {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inserts: Array<{ tabela: string; linha: Record<string, unknown> }> = [];

  const consultaVazia = () => {
    const q: Record<string, unknown> = {
      eq: () => q,
      in: () => q,
      is: () => q,
      neq: () => q,
      gte: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: [], error: null })),
    };
    return q;
  };

  const admin = {
    from(tabela: string) {
      if (tabela === "config_aviso_de_caso") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: config, error: null }) }),
          }),
        };
      }
      if (tabela === "config_aviso_de_agendamento") {
        // Sem aviso de agendamento com número próprio: o corte do aviso de caso
        // é o único em jogo aqui.
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        };
      }
      return {
        select: () => consultaVazia(),
        insert: (linha: Record<string, unknown>) => {
          inserts.push({ tabela, linha });
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "x" }, error: null }) }) };
        },
        update: () => {
          const encadeavel: { error: null; eq: () => typeof encadeavel; in: () => typeof encadeavel } = {
            error: null,
            eq: () => encadeavel,
            in: () => encadeavel,
          };
          return encadeavel;
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      // Sem os ids de retorno o ingest desiste antes do INSERT e o teste
      // passaria por não ter exercitado nada.
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };

  return { admin, rpcs, inserts };
}

function envelope(payload: WahaPayload): WahaEnvelope {
  return { event: "message.any", session: "default", payload };
}

const sessao = { id: SESSAO, organization_id: ORG };

function contatos(rpcs: Duplo["rpcs"]) {
  return rpcs.filter((c) => c.fn === "fn_upsert_wa_contact");
}
function conversas(rpcs: Duplo["rpcs"]) {
  return rpcs.filter((c) => c.fn === "fn_upsert_wa_conversation");
}

/** O eco do aviso, em modo privacidade: chat `@lid`, telefone só no `remoteJidAlt`. */
const ECO_EM_MODO_PRIVACIDADE: WahaPayload = {
  id: "true_250302204792918@lid_3EB0AABBCC",
  fromMe: true,
  body: "Caso #123 aberto — acompanhe pelo painel: https://app.exemplo.com/app/ai/cases/123",
  timestamp: 1_760_000_000,
  _data: { key: { remoteJidAlt: "5519999999999@s.whatsapp.net" } },
};

/** O mesmo eco com o chat em telefone puro (`@c.us`) — o caso que já funcionava. */
const ECO_COM_TELEFONE: WahaPayload = {
  id: "true_5519999999999@c.us_3EB0AABBCC",
  to: "5519999999999@c.us",
  fromMe: true,
  body: "Caso #123 aberto — acompanhe pelo painel: https://app.exemplo.com/app/ai/cases/123",
  timestamp: 1_760_000_000,
};

describe("eco do aviso de caso para o número interno de avisos (fromMe)", () => {
  it("⭐ modo privacidade: o `@lid` não cria contato nem conversa", async () => {
    limparCacheDoNumeroInterno();
    const { admin, rpcs, inserts } = bancoDeMentira({
      telefone_destino: NUMERO_DO_AVISO,
      destino_jid: null,
    });

    await dispatchWahaEvent(admin as never, sessao as never, envelope(ECO_EM_MODO_PRIVACIDADE), "req-1");

    expect(
      contatos(rpcs),
      "o aviso do sistema virou um CONTATO — é o número do plantão, não um cliente",
    ).toHaveLength(0);
    expect(
      conversas(rpcs),
      "o aviso do sistema virou uma CONVERSA — e é o INSERT da conversa que pede rodízio pelo banco",
    ).toHaveLength(0);
    expect(
      inserts.filter((i) => i.tabela === "messages"),
      "o aviso não é mensagem do atendimento: não entra na timeline de ninguém",
    ).toHaveLength(0);
  });

  it("o descarte deixa rastro no contador — silêncio na tela é indistinguível de defeito", async () => {
    limparCacheDoNumeroInterno();
    const { admin, rpcs } = bancoDeMentira({
      telefone_destino: NUMERO_DO_AVISO,
      destino_jid: null,
    });

    await dispatchWahaEvent(admin as never, sessao as never, envelope(ECO_EM_MODO_PRIVACIDADE), "req-1");

    expect(rpcs.some((c) => c.fn === "fn_contar_mensagem_ignorada")).toBe(true);
  });

  it("telefone puro (`@c.us`) continua cortado — a catraca do caso já coberto", async () => {
    limparCacheDoNumeroInterno();
    const { admin, rpcs } = bancoDeMentira({
      telefone_destino: NUMERO_DO_AVISO,
      destino_jid: null,
    });

    await dispatchWahaEvent(admin as never, sessao as never, envelope(ECO_COM_TELEFONE), "req-1");

    expect(contatos(rpcs)).toHaveLength(0);
    expect(conversas(rpcs)).toHaveLength(0);
  });

  it("CONTROLE: sem aviso configurado, o MESMO eco cria contato e conversa", async () => {
    // Sem este caso o teste acima passaria por vacuidade — um dublê que nunca
    // chega ao upsert também "não cria contato".
    limparCacheDoNumeroInterno();
    const { admin, rpcs } = bancoDeMentira(null);

    await dispatchWahaEvent(admin as never, sessao as never, envelope(ECO_EM_MODO_PRIVACIDADE), "req-1");

    expect(contatos(rpcs)).toHaveLength(1);
    expect(conversas(rpcs)).toHaveLength(1);
  });
});
