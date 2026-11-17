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
 * ─── Os DOIS desfechos da exibição, no mesmo arquivo, de propósito ───────────
 *
 * 1. **No acervo da empresa** (`contacts.wa_lid` = o LID da menção): o nome do
 *    contato substitui o código na exibição e na prévia da lista.
 * 2. **Fora do acervo**: a palavra do dicionário ("Participante"). O número
 *    bruto NUNCA aparece na tela — era o defeito relatado na issue.
 *
 * O `metadata.group_sender` é o AUTOR da mensagem, não quem foi mencionado, e o
 * payload não traz nome por menção: o nome do autor NUNCA vira rótulo de menção
 * (senão "João" marcando Pedro e Ana sairia "@João e @João").
 *
 * Em nenhum dos dois o `body` gravado muda: ele continua com `@<lid>`, que é o
 * dado do provedor e o que a auditoria precisa ver.
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
async function ingerir(
  contatos: Contato[],
  body: string,
  jids: string[],
  remetente: Parameters<typeof gravarMensagemDeGrupo>[1]["remetente"] = {
    name: "João do Grupo",
    phone: null,
    lid: "11111111111111",
  },
) {
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
    remetente,
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
    // A MESMA chamada que a bolha faz (`MessageBubble`): a lista do metadata e a
    // palavra de reserva. O `group_sender` (o autor) não entra.
    exibido: textoComMencoesResolvidas(linha.body as string, lerMencoesDeGrupo(linha.metadata), {
      palavraDesconhecida: "Participante",
    }),
  };
}

describe("menção em grupo — LID vira NOME quando o contato está no acervo", () => {
  it("(a) o número que existe no CRM mostra o nome do contato — na bolha e na prévia", async () => {
    const r = await ingerir(
      [{ name: "Maria Exemplo", display_name: null, phone_number: "+5511988887777", wa_lid: LID_CONHECIDO }],
      `Bom dia @${LID_CONHECIDO}, pode confirmar?`,
      [LID_CONHECIDO],
    );

    expect(r.desfecho).toBe("gravada");
    // A bolha mostra o nome…
    expect(r.exibido).toBe("Bom dia @Maria Exemplo, pode confirmar?");
    // …e a prévia desnormalizada também (ela é o que a lista da Inbox mostra).
    expect(r.previews.at(-1)).toBe("Bom dia @Maria Exemplo, pode confirmar?");
  });

  it("(d) o `body` gravado continua IDÊNTICO ao recebido e a lista aparece em `messages.metadata`", async () => {
    const body = `Bom dia @${LID_CONHECIDO}, pode confirmar?`;
    const r = await ingerir(
      [{ name: "Maria Exemplo", display_name: null, phone_number: "+5511988887777", wa_lid: LID_CONHECIDO }],
      body,
      [LID_CONHECIDO],
    );

    // O dado do provedor é auditável: nada de reescrever histórico na entrada.
    expect(r.linha.body).toBe(body);
    expect(r.linha.body).toContain(`@${LID_CONHECIDO}`);
    expect((r.linha.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: LID_CONHECIDO, phone: null, name: "Maria Exemplo" },
    ]);
    // E o `group_sender` continua lá, intacto, no mesmo metadata.
    expect((r.linha.metadata as Record<string, unknown>).group_sender).toEqual({
      name: "João do Grupo",
      phone: null,
      lid: "11111111111111",
    });
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
    // Sem contato, cai para a palavra — nunca para o LID nem para o autor.
    expect(r.exibido).toBe("Oi @Participante");
  });
});

describe("menção em grupo — fora do acervo, a menção sai como \"Participante\", nunca com o nome do autor", () => {
  it("(b) o número que NÃO existe no CRM mostra \"Participante\", e o nome do AUTOR (`group_sender`) não aparece", async () => {
    const body = `Fala @${LID_DESCONHECIDO}, tudo certo?`;
    const r = await ingerir(
      [{ name: "Maria Exemplo", display_name: null, phone_number: "+5511988887777", wa_lid: LID_CONHECIDO }],
      body,
      [LID_DESCONHECIDO],
    );

    expect(r.desfecho).toBe("gravada");
    // A menção foi GUARDADA (a informação não se perde), só sem rótulo de contato.
    expect((r.linha.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: LID_DESCONHECIDO, phone: null, name: null },
    ]);
    // O `body` continua cru; quem troca é a leitura.
    expect(r.linha.body).toBe(body);
    expect(r.exibido).toBe("Fala @Participante, tudo certo?");
    expect(r.exibido).not.toContain(LID_DESCONHECIDO);
    // O remetente padrão de `ingerir` é "João do Grupo": ele ESCREVEU, não foi
    // mencionado, e o nome dele não pode aparecer no lugar da menção.
    expect(r.exibido).not.toContain("João do Grupo");
    // A prévia da lista (e a busca por conteúdo, que lê essa coluna) segue a
    // mesma régua.
    expect(r.previews.at(-1)).toBe("Fala @Participante, tudo certo?");
    expect(r.previews.join("\n")).not.toContain("João do Grupo");
  });

  it("CONTROLE: o autor menciona DUAS pessoas fora do CRM — nenhuma das duas ganha o nome dele", async () => {
    const OUTRO_DESCONHECIDO = "55443322110099";
    const body = `@${LID_DESCONHECIDO} e @${OUTRO_DESCONHECIDO}, podem vir amanhã?`;
    const r = await ingerir([], body, [LID_DESCONHECIDO, OUTRO_DESCONHECIDO], {
      name: "João",
      phone: null,
      lid: "11111111111111",
    });

    expect(r.exibido).toBe("@Participante e @Participante, podem vir amanhã?");
    expect(r.exibido).not.toContain("João");
    expect(r.previews.at(-1)).toBe("@Participante e @Participante, podem vir amanhã?");
    expect(r.previews.join("\n")).not.toContain("João");
  });

  it("(c) sem nome de autor também, a menção não mostra dígitos crus: sai a palavra do dicionário", async () => {
    const body = `Oi @${LID_DESCONHECIDO}`;
    // Payload sem `pushName` e sem `participantAlt`: o webhook não deu nome nenhum.
    const r = await ingerir([], body, [LID_DESCONHECIDO], { name: null, phone: null, lid: null });

    expect(r.exibido).toBe("Oi @Participante");
    expect(r.exibido).not.toMatch(/\d/);
    // A palavra é a mesma chave do dicionário, com espanhol (a cerca de i18n
    // roda no gate): a tela traduz, a prévia gravada fica em pt.
    expect(r.previews.at(-1)).toBe("Oi @Participante");
    expect((r.linha.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: LID_DESCONHECIDO, phone: null, name: null },
    ]);
    // O `group_sender` entra sem nome (o schema aceita os três campos nulos); com
    // ou sem ele, a menção desconhecida cai na palavra.
    const participante = (r.linha.metadata as Record<string, unknown>).group_sender as { name: string | null } | undefined;
    expect(participante?.name ?? null).toBeNull();
  });

  it("(e) `@` de e-mail no texto não é tocado pela resolução", async () => {
    const body = `Fala @${LID_DESCONHECIDO}, manda para maria@exemplo.com`;
    const r = await ingerir([], body, [LID_DESCONHECIDO], { name: null, phone: null, lid: null });

    expect(r.exibido).toBe("Fala @Participante, manda para maria@exemplo.com");
    expect(r.exibido).toContain("maria@exemplo.com");
    // O corpo gravado continua com o e-mail e com o LID.
    expect(r.linha.body).toBe(body);
  });

  it("CONTROLE: mensagem sem menção não paga leitura de contato nem ganha a chave", async () => {
    const body = "Bom dia a todos, sem marcar ninguém";
    const r = await ingerir([], body, []);
    expect(r.exibido).toBe(body);
    expect(r.previews.at(-1)).toBe(body);
    expect((r.linha.metadata as Record<string, unknown>).mentions).toBeUndefined();
  });
});
