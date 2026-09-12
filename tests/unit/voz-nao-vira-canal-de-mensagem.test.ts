/**
 * A LINHA DE CHAMADA DE VOZ NÃO PODE SER ESCOLHIDA PARA MANDAR RECADO.
 *
 * `channel_sessions` deixou de ser só a tabela dos transportes de texto quando a
 * migration 0232 pôs `'wacalls'` no CHECK de `provider`. Dezenas de leituras
 * daquela tabela dizem "canal" e querem dizer "canal de mensagem" — e nenhuma
 * delas filtra provider. Uma organização que pareia voz passa a ter, na mesma
 * tabela, uma linha `WORKING`, sem `waha_session_name` e sem telefone.
 *
 * Os dois pontos medidos aqui são os que produzem EFEITO errado, não só tela
 * feia:
 *
 *   - `listSelectableChannels` é a fonte única dos seletores de "Número
 *     conectado" e alimenta `lib/ai/agents/first-publication.ts`, que amarra o
 *     primeiro agente publicado a `canais[0]` — o mais ANTIGO. Numa organização
 *     que pareou voz antes de conectar o WhatsApp, o primeiro agente nascia
 *     preso a um canal que nunca recebe mensagem.
 *   - `sessaoProntaParaEnvio` escolhe por onde uma automação envia. Com
 *     `.limit(1)` e sem provider, ela podia devolver a linha de voz e a
 *     automação "enviava" texto por um canal sem transporte de texto.
 *
 * O teste dirige as funções contra um banco de mentira que APLICA os filtros —
 * medir a query devolvida seria medir a forma, não o desfecho.
 */
import { describe, expect, it } from "vitest";

import { listSelectableChannels } from "@/lib/channels/selectable";
import { sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";

type Linha = Record<string, unknown>;

/**
 * Um `from(...)` encadeável que guarda predicados e só resolve no `await` —
 * como o PostgREST faz. Suporta o que estas duas funções usam: `eq`, `is`,
 * `in`, `order`, `limit`, `select`.
 */
function bancoDeMentira(linhas: Linha[]) {
  const chamadas: string[] = [];
  const construir = () => {
    let atual = [...linhas];
    let teto: number | null = null;
    const cadeia = {
      select: () => cadeia,
      order: (coluna: string) => {
        atual = [...atual].sort((a, b) =>
          String(a[coluna] ?? "").localeCompare(String(b[coluna] ?? "")),
        );
        return cadeia;
      },
      eq: (c: string, v: unknown) => {
        atual = atual.filter((l) => l[c] === v);
        return cadeia;
      },
      is: (c: string, v: unknown) => {
        atual = atual.filter((l) => (l[c] ?? null) === v);
        return cadeia;
      },
      in: (c: string, vs: unknown[]) => {
        chamadas.push(c);
        atual = atual.filter((l) => vs.includes(l[c]));
        return cadeia;
      },
      limit: (n: number) => {
        teto = n;
        return cadeia;
      },
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) =>
        ok({ data: teto === null ? atual : atual.slice(0, teto), error: null }),
    };
    return cadeia;
  };
  return { db: { from: () => construir() } as never, chamadas };
}

const VOZ: Linha = {
  id: "linha-de-voz",
  organization_id: "org",
  provider: "wacalls",
  display_name: null,
  phone_number: null,
  status: "WORKING",
  waha_session_name: null,
  archived_at: null,
  created_at: "2020-01-01T00:00:00Z", // a MAIS ANTIGA: ganharia o `[0]` e o `limit(1)`
};
const WHATSAPP: Linha = {
  id: "numero-de-verdade",
  organization_id: "org",
  provider: "waha",
  display_name: "Comercial",
  phone_number: "5511999990000",
  status: "WORKING",
  waha_session_name: "org-comercial",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

describe("o seletor de canais não oferece a linha de chamada de voz", () => {
  it("controle positivo: o canal de mensagem continua sendo oferecido", async () => {
    const { db } = bancoDeMentira([WHATSAPP]);
    const canais = await listSelectableChannels(db, "org");
    expect(canais.map((c) => c.id)).toEqual(["numero-de-verdade"]);
  });

  it("a voz some da lista, mesmo sendo a sessão mais antiga da organização", async () => {
    const { db } = bancoDeMentira([VOZ, WHATSAPP]);
    const canais = await listSelectableChannels(db, "org");
    expect(canais.map((c) => c.id)).toEqual(["numero-de-verdade"]);
    // O `[0]` de `first-publication.ts` é o que amarra o primeiro agente.
    expect(canais[0]?.id).not.toBe("linha-de-voz");
  });

  it("organização que SÓ pareou voz não tem canal nenhum a oferecer", async () => {
    // "Nenhum" é a resposta honesta: quem chama devolve `no_channel` e o retrato
    // da instalação conta zero, em vez de anunciar um canal conectado que não
    // recebe mensagem.
    const { db } = bancoDeMentira([VOZ]);
    expect(await listSelectableChannels(db, "org")).toEqual([]);
  });
});

describe("a automação não envia texto pela linha de chamada de voz", () => {
  it("controle positivo: escolhe o canal de mensagem WORKING", async () => {
    const { db } = bancoDeMentira([WHATSAPP]);
    expect(await sessaoProntaParaEnvio(db, "org")).toBe("numero-de-verdade");
  });

  it("com voz e WhatsApp, escolhe o WhatsApp mesmo a voz sendo mais antiga", async () => {
    const { db } = bancoDeMentira([VOZ, WHATSAPP]);
    expect(await sessaoProntaParaEnvio(db, "org")).toBe("numero-de-verdade");
  });

  it("só voz: devolve null em vez de um canal que não entrega", async () => {
    // O caminho de queda (`tentar(false)`, sem exigir WORKING) também precisa do
    // filtro — sem ele a voz voltava justamente quando não havia mais ninguém.
    const { db } = bancoDeMentira([VOZ]);
    expect(await sessaoProntaParaEnvio(db, "org")).toBeNull();
  });
});
