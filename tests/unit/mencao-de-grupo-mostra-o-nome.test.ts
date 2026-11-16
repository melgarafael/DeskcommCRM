// @vitest-environment node
/**
 * A MENÇÃO DE GRUPO MOSTRA O NOME — QUANDO O CONTATO ESTÁ NO ACERVO (#3566).
 *
 * ─── O defeito, medido no texto ─────────────────────────────────────────────
 *
 * Em grupo, o WhatsApp escreve a menção no `body` como o identificador opaco do
 * participante — `@75235009282237` —, e não como o nome que o celular mostra. A
 * mensagem chegava ao CRM com o código na tela porque ninguém guardava a lista
 * de quem foi mencionado: `metadata.group_sender` dizia quem ESCREVEU, e quem
 * foi mencionado se perdia.
 *
 * ─── Os DOIS desfechos, no mesmo arquivo, de propósito ──────────────────────
 *
 * 1. **No acervo da empresa** (`contacts.wa_lid` = o LID da menção): o nome do
 *    contato substitui o código na exibição e na prévia da lista.
 * 2. **Fora do acervo**: a menção continua `@<lid>`. Não inventamos nome e não
 *    apagamos a menção — o identificador que o texto já tinha é a informação
 *    disponível, e é o que o operador vê.
 *
 * O caminho exercitado é o de PRODUÇÃO: o payload cru do WAHA passa por
 * `mencoesDoGrupo` (o leitor do `contextInfo.mentionedJid`), o ingest grava o
 * `metadata.mentions` resolvendo pelo banco, e a exibição chama a MESMA função
 * da bolha (`textoComMencoesResolvidas`). A resolução do banco é a de verdade
 * (`criarIngestDeGrupoDb`), com um cliente Supabase falso — não um dublê do
 * `rotulosDasMencoes`, que provaria só o contrato do dublê.
 */
import { describe, expect, it } from "vitest";

import { criarIngestDeGrupoDb, gravarMensagemDeGrupo } from "@/lib/grupos/ingest";
import {
  lerMencoesDeGrupo,
  textoComMencoesResolvidas,
} from "@/lib/messaging/mencoes-de-grupo";
import { mencoesDoGrupo } from "@/lib/waha/ingest";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const GRUPO = "5511999990000-1600000000@g.us";

/** O LID do exemplo da issue; o segundo não existe no acervo. */
const LID_CONHECIDO = "75235009282237";
const LID_DESCONHECIDO = "99887766554433";

type Contato = {
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  wa_lid: string | null;
};

/**
 * Um Supabase de mentira que RESPONDE O QUE O CÓDIGO PERGUNTA: a chave do grupo
 * ligado, a mensagem inserida e, nas leituras de `contacts`, as linhas filtradas
 * pela coluna que o ingest usou (`wa_lid` ou `phone_number`).
 *
 * O filtro é aplicado de verdade para que a resolução dependa do ACERVO — um
 * banco que devolvesse tudo passaria mesmo se a consulta estivesse pela coluna
 * errada, que é exatamente o erro que o teste precisa pegar.
 */
function bancoFalso(contatos: Contato[]) {
  const inseridos: Record<string, unknown>[] = [];
  const previews: string[] = [];

  function from(tabela: string) {
    let colunaDoFiltro: keyof Contato | null = null;
    let valoresDoFiltro: string[] = [];
    const b: Record<string, unknown> = {};

    const devolve = () => b;
    b.select = devolve;
    b.eq = devolve;
    b.is = devolve;
    b.order = devolve;
    b.update = devolve;
    b.upsert = async () => ({ data: null, error: null });
    b.in = (coluna: string, valores: string[]) => {
      colunaDoFiltro = coluna as keyof Contato;
      valoresDoFiltro = valores;
      return b;
    };
    b.limit = async () => {
      if (tabela !== "contacts") return { data: [], error: null };
      const dados = colunaDoFiltro
        ? contatos.filter((c) => {
            const valor = c[colunaDoFiltro!];
            return valor !== null && valoresDoFiltro.includes(valor);
          })
        : [];
      return { data: dados, error: null };
    };
    b.maybeSingle = async () => ({
      data:
        tabela === "channel_session_groups"
          ? { id: "g1", subject: "Grupo Exemplo", contact_id: "contato-g", conversation_id: "conversa-g", ia_responde: false }
          : tabela === "messages"
            ? { id: "m1" }
            : null,
      error: null,
    });
    b.insert = (linha: Record<string, unknown>) => {
      inseridos.push(linha);
      return b;
    };
    return b;
  }

  const admin = {
    from,
    rpc: async (nome: string, args?: Record<string, unknown>) => {
      // `fn_mark_conversation_message` carrega a prévia da lista da Inbox.
      if (nome === "fn_mark_conversation_message" && typeof args?.p_preview === "string") {
        previews.push(args.p_preview);
      }
      return { data: null, error: null };
    },
  };

  return { admin, inseridos, previews };
}

/** O payload cru do WAHA: a menção mora em `contextInfo.mentionedJid`. */
function payloadComMencoes(lids: string[]): Parameters<typeof mencoesDoGrupo>[0] {
  return {
    id: "false_5511999990000-1600000000@g.us_ABC",
    from: GRUPO,
    type: "chat",
    body: "Oi!",
    _data: {
      message: {
        extendedTextMessage: {
          text: "Oi!",
          contextInfo: { mentionedJid: lids.map((lid) => `${lid}@lid`) },
        },
      },
    },
  } as never;
}

/** Grava uma mensagem de grupo com menções, do payload ao banco. */
async function ingerir(contatos: Contato[], body: string, jids: string[]) {
  const { admin, inseridos, previews } = bancoFalso(contatos);
  const db = criarIngestDeGrupoDb(admin as never);
  const mencoes = mencoesDoGrupo(payloadComMencoes(jids));

  const desfecho = await gravarMensagemDeGrupo(db, {
    organizationId: ORG,
    channelSessionId: SESS,
    groupChatId: GRUPO,
    direction: "inbound",
    externalId: "ext-1",
    type: "text",
    body,
    mediaUrl: null,
    mediaMime: null,
    sentAt: "2026-09-23T12:00:00.000Z",
    remetente: { name: "João do Grupo", phone: null, lid: "11111111111111" },
    rawType: "chat",
    mencoes,
  });

  const linha = inseridos[0]!;
  return {
    desfecho,
    linha,
    mencoes,
    inseridos,
    previews,
    exibido: textoComMencoesResolvidas(
      linha.body as string,
      lerMencoesDeGrupo(linha.metadata),
    ),
  };
}

describe("menção em grupo — LID vira NOME quando o contato está no acervo", () => {
  it("o texto da bolha e a prévia da lista mostram @Maria Exemplo", async () => {
    const r = await ingerir(
      [{ name: "Maria Exemplo", display_name: null, phone_number: "+5511988887777", wa_lid: LID_CONHECIDO }],
      `Bom dia @${LID_CONHECIDO}, pode confirmar?`,
      [LID_CONHECIDO],
    );

    expect(r.desfecho).toBe("gravada");
    // O CORPO gravado continua cru: o dado do provedor é auditável, quem resolve
    // é a exibição.
    expect(r.linha.body).toBe(`Bom dia @${LID_CONHECIDO}, pode confirmar?`);
    // A lista foi guardada com o nome do contato do acervo.
    expect((r.linha.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: LID_CONHECIDO, phone: null, name: "Maria Exemplo" },
    ]);
    // A bolha mostra o nome…
    expect(r.exibido).toBe("Bom dia @Maria Exemplo, pode confirmar?");
    // …e a prévia desnormalizada também (ela é o que a lista da Inbox mostra).
    expect(r.previews.at(-1)).toBe("Bom dia @Maria Exemplo, pode confirmar?");
  });

  it("o nome vem do ACERVO pelo `wa_lid` — contato com outro LID não resolve", async () => {
    // Um contato existe, mas é OUTRA pessoa: o filtro por `wa_lid` não pode
    // devolver o primeiro contato da tabela por conveniência.
    const r = await ingerir(
      [{ name: "Outra Pessoa", display_name: null, phone_number: "+5511977776666", wa_lid: "12345678901234" }],
      `Oi @${LID_CONHECIDO}`,
      [LID_CONHECIDO],
    );
    expect((r.linha.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: LID_CONHECIDO, phone: null, name: null },
    ]);
    expect(r.exibido).toBe(`Oi @${LID_CONHECIDO}`);
  });
});

describe("menção em grupo — LID desconhecido PERMANECE LID", () => {
  it("não inventa nome e não apaga a menção: o texto sai idêntico", async () => {
    const body = `Fala @${LID_DESCONHECIDO}, tudo certo?`;
    const r = await ingerir(
      [{ name: "Maria Exemplo", display_name: null, phone_number: "+5511988887777", wa_lid: LID_CONHECIDO }],
      body,
      [LID_DESCONHECIDO],
    );

    expect(r.desfecho).toBe("gravada");
    // A menção foi GUARDADA (a informação não se perde), só sem rótulo.
    expect((r.linha.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: LID_DESCONHECIDO, phone: null, name: null },
    ]);
    // O texto exibido é byte a byte o mesmo: nem nome inventado, nem menção apagada.
    expect(r.exibido).toBe(body);
    expect(r.previews.at(-1)).toBe(body);
  });

  it("acervo vazio e não-acervo dão o mesmo desfecho — o LID fica", async () => {
    const body = `Oi @${LID_DESCONHECIDO}`;
    const r = await ingerir([], body, [LID_DESCONHECIDO]);
    expect(r.exibido).toBe(body);
    expect((r.linha.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: LID_DESCONHECIDO, phone: null, name: null },
    ]);
  });
});
