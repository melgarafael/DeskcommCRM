/**
 * O CAMINHO DE ENVIO DO TERCEIRO CANAL, PELO HANDLER — não pelo adapter.
 *
 * Por que este arquivo existe, sendo que o PR já traz 5 suítes de canal: as 5
 * exercitam `zernioAdapter.send()` direto, com a credencial e a thread entregues
 * na mão. Nenhuma passa por `sendMessageHandler`, que é a ÚNICA porta de saída
 * do sistema (UI, automação, MCP e o agente entram todos aqui). O que o adapter
 * devolve e o que a linha de `messages` acaba dizendo são duas coisas — e é a
 * segunda que o operador vê na tela.
 *
 * Duas classes que só aparecem deste lado do seam:
 *
 * ## 1. A coluna do select, que se perde sem barulho
 *
 * `conversations.provider_conversation_id` chega ao adapter por três elos
 * (string do `select` → campo do tipo `Joined` → argumento do `adapter.send`), e
 * o primeiro é uma **string** consumida por `as unknown as Joined`: apagá-la não
 * gera erro de tipo, não muda nenhum símbolo e nenhum `grep` a acha. O valor
 * simplesmente volta `undefined` em runtime, e só neste canal, e só quando
 * alguém responde dentro da janela de 24h.
 *
 * O PR guarda esse elo por REGEX no fonte (`/group_chat_id,\s*provider_conversation_id/`
 * em `canal-zernio-vocabulario.test.ts`). Regex de posição é o guarda errado
 * aqui por um motivo medido: o #194 reescreve EXATAMENTE essa linha para
 * acrescentar `wa_lid` no embed de contatos, os dois lados conflitam, e quem
 * resolver o conflito pode legitimamente reordenar as colunas. O guarda de texto
 * reprova uma resolução correta e aprova uma errada que mantenha a ordem.
 *
 * Aqui o dublê de Supabase **projeta a linha pelo `select` que o handler pediu**
 * — coluna que não está no `select` não chega, igual ao PostgREST. Assim o que
 * se prova é o elo, não a grafia dele. (A não-vacuidade do projetor tem caso
 * próprio: sem ele, todo caso abaixo passaria por acidente.)
 *
 * ## 2. Nenhum desfecho pode dizer `sent` sem nada ter saído
 *
 * `sent` é o que a Central mostra como entregue ao canal. Histórico medido: com
 * credencial ausente, `zernioAdapter.send` devolvia `{ externalId: null }` sem
 * tocar a rede — o contrato de "canal não conectado" que o oficial também
 * carregava — e o handler, que só olha se houve exceção, gravava `sent`. Num
 * produto self-host ninguém está olhando: o dono da instalação lê "enviada" e
 * conclui que o produto funciona.
 *
 * Os DOIS canais trocaram esse contrato por LANÇAR `*_not_configured`, e quem
 * decide passou a ser o `send` (async), porque o pre-check síncrono não alcança
 * o banco — onde a credencial de quem conectou pela tela mora (o intermediado
 * primeiro; o oficial na #674). Este arquivo cobre os dois lados pelo canal
 * oficial: o envio que SAI com a credencial da sessão e a fila com motivo
 * nomeado quando não há credencial nenhuma.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const CONTA = "6a3572a15f7d1751ab117832";
const THREAD = "6a76a2dc4b8fe115e5f6c300";

// O admin client é usado para assinar mídia e para resolver a credencial de
// sessão. Aqui a sessão NUNCA tem credencial gravada (é o estado de quem só
// configurou env), então o `select` devolve linha vazia.
/**
 * O estado da credencial de sessão que a resolução encontra no "banco".
 *
 * - `token` → instalação de uma organização só (quem conectou pela tela e não
 *   escreveu `.env`);
 * - `porOrg` → busca filtrada por organização (#236): a chave é
 *   `organization_id|phone_number_id`, e cada tenant tem o SEU cifrado e o SEU
 *   token — é o que prova que cada organização envia pelo token dela;
 * - `erro` → falha de consulta (PGRST116 etc.);
 * - `decifravel: false` → a decifra devolve null (GUC da chave ausente).
 */
const credencialDaSessao: {
  token: string | null;
  porOrg: Record<string, { cifrado: string; token: string }> | null;
  erro: { code?: string; message?: string } | null;
  decifravel: boolean;
} = { token: null, porOrg: null, erro: null, decifravel: true };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://signed.example/a.jpg" },
          error: null,
        }),
      }),
    },
    // Cadeia ENCADEÁVEL: a resolução por sessão filtra `organization_id`, o
    // identificador do provider E `archived_at is null` (issue #236 /
    // migration 0165). Um stub em que `eq()` já entrega `maybeSingle` deixa de
    // casar com o código real — e mock que não casa testa o mock.
    from: () => {
      const filtros: Record<string, unknown> = {};
      const alvo: Record<string, unknown> = {
        maybeSingle: async () => {
          if (credencialDaSessao.erro) return { data: null, error: credencialDaSessao.erro };
          const chave = `${filtros.organization_id ?? ""}|${filtros.meta_phone_number_id ?? ""}`;
          const daOrg = credencialDaSessao.porOrg?.[chave];
          const cifrado = credencialDaSessao.porOrg
            ? (daOrg?.cifrado ?? null)
            : credencialDaSessao.token
              ? "\\xdeadbeef"
              : null;
          return {
            data: cifrado
              ? {
                  meta_phone_number_id: String(filtros.meta_phone_number_id ?? "pn"),
                  meta_token_encrypted: cifrado,
                }
              : null,
            error: null,
          };
        },
      };
      alvo.select = () => alvo;
      alvo.eq = (col: string, val: unknown) => {
        filtros[col] = val;
        return alvo;
      };
      alvo.is = () => alvo;
      return alvo;
    },
    rpc: async (nome: string, args: { ciphertext?: string }) => {
      if (nome !== "fn_decrypt_oauth" || !credencialDaSessao.decifravel) {
        return { data: null, error: null };
      }
      const cifrado = String(args?.ciphertext ?? "");
      const daOrg = Object.values(credencialDaSessao.porOrg ?? {}).find((s) => s.cifrado === cifrado);
      return {
        data: daOrg?.token ?? (credencialDaSessao.porOrg ? null : credencialDaSessao.token),
        error: null,
      };
    },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;

/**
 * Colunas de PRIMEIRO NÍVEL de um `select` do PostgREST.
 *
 * `id, a, b:c(x, y), d` → `["id", "a", "b", "d"]`. Embeds entram pelo apelido
 * (o que vem antes de `:`), que é a chave que o PostgREST devolve.
 */
function colunasDoSelect(select: string): string[] {
  let profundidade = 0;
  let atual = "";
  const partes: string[] = [];
  for (const ch of select) {
    if (ch === "(") profundidade++;
    else if (ch === ")") profundidade--;
    if (ch === "," && profundidade === 0) {
      partes.push(atual);
      atual = "";
      continue;
    }
    atual += ch;
  }
  partes.push(atual);
  return partes
    .map((p) => p.trim().split("(")[0]!.split(":")[0]!.trim())
    .filter((p) => p.length > 0);
}

/** A linha como o PostgREST a devolveria: só o que o `select` pediu. */
/**
 * Colunas de DENTRO de um embed (`contacts:contact_id(phone_number, wa_lid)`).
 * `colunasDoSelect` devolve só o primeiro nível e descarta o miolo do embed —
 * então sem isto não há como aferir que uma coluna do embed foi pedida, e foi
 * exatamente ali que a perda passou despercebida.
 */
function colunasDoEmbed(select: string, apelido: string): string[] {
  const m = new RegExp(`${apelido}\\s*:[^(]*\\(([^)]*)\\)`).exec(select);
  if (m === null) return [];
  return m[1]!.split(",").map((c) => c.trim()).filter(Boolean);
}

function projetar(linha: Row, select: string): Row {
  const querem = new Set(colunasDoSelect(select));
  return Object.fromEntries(Object.entries(linha).filter(([k]) => querem.has(k)));
}

interface Forma {
  providerConversationId?: string | null;
  provider?: string;
  /** Canal excluído pela tela (migration 0106) — comporta o ramo `channel_archived`. */
  archivedAt?: string | null;
}

function conversaCompleta(forma: Forma = {}): Row {
  const provider = forma.provider ?? "zernio";
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    provider_conversation_id: forma.providerConversationId ?? null,
    contacts: { phone_number: "+595991733685", wa_identity: null, wa_lid: "999888", is_blocked: false },
    channel_sessions: {
      provider,
      waha_session_name: provider === "waha" ? "default" : null,
      meta_phone_number_id: provider === "meta_cloud" ? "1103328999528818" : null,
      zernio_account_id: provider === "zernio" ? CONTA : null,
      status: "WORKING",
      archived_at: forma.archivedAt ?? null,
    },
  };
}

/**
 * Dublê de Supabase que **honra o `select`**. É a única diferença relevante em
 * relação ao dublê de `messages-handler-desfechos.test.ts`, e é ela que faz a
 * rede morder a perda de uma coluna.
 */
function makeSupabase(linhaCompleta: Row) {
  const estado: {
    message: Row | null;
    selects: string[];
    contactPatch: Row | null;
    contactFilters: Record<string, unknown>;
  } = { message: null, selects: [], contactPatch: null, contactFilters: {} };
  const client = {
    from(tabela: string) {
      if (tabela === "conversations") {
        return {
          select: (cols: string) => {
            estado.selects.push(cols);
            return {
              eq: () => ({
                maybeSingle: async () => ({ data: projetar(linhaCompleta, cols), error: null }),
              }),
            };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (tabela === "meta_templates") {
        // O espelho da definição aprovada, consultado pelo pré-voo que roda
        // ANTES de escolher transporte. `null` = não espelhada, e o pré-voo
        // deixa passar de propósito: recusar o que não se sabe barraria todo
        // envio de modelo numa instalação cujo sync ainda não rodou.
        //
        // Encadeável sem limite: um dublê que fixa a quantidade de filtros faz
        // o teste quebrar quando a consulta ganha um `eq` novo, com um erro que
        // não fala do comportamento sob teste.
        const cadeia: Record<string, unknown> = {
          eq: () => cadeia,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return { select: () => cadeia };
      }
      if (tabela === "messages") {
        return {
          insert: (row: Row) => {
            estado.message = {
              id: "msg-1",
              external_id: null,
              ack: null,
              error_code: null,
              error_message: null,
              ...row,
            };
            return {
              select: () => ({ single: async () => ({ data: { ...estado.message }, error: null }) }),
            };
          },
          update: (patch: Row) => {
            estado.message = { ...estado.message, ...patch };
            return {
              eq: () => ({
                select: () => ({ maybeSingle: async () => ({ data: { ...estado.message }, error: null }) }),
              }),
            };
          },
        };
      }
      if (tabela === "contacts") {
        // O envio carimba `contacts.last_activity_at` (migration 0162), com
        // filtro por id E por organização — este handler também roda com o
        // client de service role, que bypassa RLS.
        //
        // Encadeável sem limite, pelo mesmo motivo escrito no dublê de
        // `meta_templates` logo acima: um dublê que fixa a quantidade de
        // filtros quebra quando a consulta ganha um `eq` novo, com um erro que
        // não fala do comportamento sob teste. Foi exatamente o que aconteceu
        // aqui quando o filtro de tenant entrou.
        const cadeia: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            estado.contactFilters[col] = val;
            return cadeia;
          },
          then: (resolve: (v: { error: null }) => unknown) =>
            Promise.resolve({ error: null }).then(resolve),
        };
        return {
          update: (patch: Row) => {
            estado.contactPatch = patch;
            return cadeia;
          },
        };
      }
      throw new Error(`dublê: tabela inesperada '${tabela}'`);
    },
    rpc: async () => ({ error: null }),
  };
  return { supabase: client as unknown as SupabaseClient, estado };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "req-1",
};
const texto = (over: Partial<SendMessageInput> = {}): SendMessageInput =>
  ({ conversation_id: CONV, type: "text", body: "oi", ...over }) as SendMessageInput;

function respostaOk(messageId = "wamid.OK") {
  return vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { messageId } }),
  }));
}

/** Resposta da Graph API (canal oficial): o id vem em `messages[0].id`. */
function respostaMeta(messageId = "wamid.M") {
  return vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: messageId }] }),
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  credencialDaSessao.token = null;
  credencialDaSessao.porOrg = null;
  credencialDaSessao.erro = null;
  credencialDaSessao.decifravel = true;
});

describe("o projetor do dublê é discriminante (guarda de vacuidade)", () => {
  it("coluna fora do select não chega — sem isto, todo caso abaixo passaria por acidente", () => {
    const linha = conversaCompleta({ providerConversationId: THREAD });
    expect(projetar(linha, "id, group_chat_id, provider_conversation_id")).toHaveProperty(
      "provider_conversation_id",
    );
    expect(projetar(linha, "id, group_chat_id")).not.toHaveProperty("provider_conversation_id");
  });

  /**
   * O `wa_lid` no embed de contatos NÃO tinha guarda nenhuma — medido nesta
   * árvore: removê-lo do `select` passa `pnpm typecheck` (a linha é consumida por
   * `conv as unknown as Joined`, então o compilador não a vê) e passa a suíte unit
   * INTEIRA: 2199 casos, exit 0.
   *
   * A linha 243 é disputada — o #200 acrescentou `provider_conversation_id` e o
   * #194 acrescentou `wa_lid`, no mesmo ponto. O git obriga a escolher e escolher
   * um lado não emite sinal. O `provider_conversation_id` já tinha o dele; este é
   * o do outro lado.
   *
   * Afere que a coluna foi PEDIDA, não onde ela aparece: reordenar o `select`
   * continua verde, apagar a coluna fica vermelho.
   */
  it("o embed de contatos pede `wa_lid` — sem ele o contato @lid perde a correlação", async () => {
    vi.stubEnv("ZERNIO_ACCOUNT_ID", CONTA);
    vi.stubEnv("ZERNIO_API_KEY", "sk_env");
    vi.stubGlobal("fetch", respostaOk("wamid.LID"));
    const { supabase, estado } = makeSupabase(conversaCompleta({ providerConversationId: THREAD }));
    await sendMessageHandler(supabase, ctx, texto());
    expect(estado.selects.length, "guarda de vacuidade: o handler consultou a conversa").toBeGreaterThan(0);
    expect(estado.selects.every((sel) => colunasDoEmbed(sel, "contacts").includes("wa_lid"))).toBe(
      true,
    );
  });

  it("embed entra pelo APELIDO, como o PostgREST devolve", () => {
    expect(colunasDoSelect("id, contacts:contact_id(phone_number, wa_identity), status")).toEqual([
      "id",
      "contacts",
      "status",
    ]);
  });
});

describe("a thread do provider atravessa os três elos até o transporte", () => {
  it("com thread na conversa, ela endereça o envio — e o telefone NÃO", async () => {
    vi.stubEnv("ZERNIO_ACCOUNT_ID", CONTA);
    vi.stubEnv("ZERNIO_API_KEY", "sk_env");
    const fetchMock = respostaOk("wamid.THREAD");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase, estado } = makeSupabase(conversaCompleta({ providerConversationId: THREAD }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("sent");
    expect(msg.external_id).toBe("wamid.THREAD");
    const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(url).toContain(THREAD);
    // O telefone identifica o contato, não endereça este envio.
    expect(url).not.toContain("595991733685");
    // E a coluna foi de fato PEDIDA — a prova de que o elo existe, sem depender
    // de onde ela aparece na string.
    expect(estado.selects.every((s) => colunasDoSelect(s).includes("provider_conversation_id"))).toBe(
      true,
    );
  });

  it("mídia passa pela MESMA thread — os dois call sites, não só o de texto", async () => {
    vi.stubEnv("ZERNIO_ACCOUNT_ID", CONTA);
    vi.stubEnv("ZERNIO_API_KEY", "sk_env");
    const fetchMock = respostaOk("wamid.MEDIA");
    vi.stubGlobal("fetch", fetchMock);

    // `media_storage_path` é o que seleciona o OUTRO ramo do `try` (storage-first
    // com URL assinada). Usar `media_url` cairia no ramo de texto e este caso
    // viraria uma segunda cópia do anterior — cobertura aparente, elo real não
    // exercitado.
    const { supabase } = makeSupabase(conversaCompleta({ providerConversationId: THREAD }));
    const msg = await sendMessageHandler(
      supabase,
      ctx,
      texto({
        type: "image",
        body: undefined,
        media_storage_path: `${ORG}/${CONV}/a.jpg`,
        media_mime: "image/jpeg",
      }),
    );

    expect(msg.status).toBe("sent");
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain(THREAD);
    // Prova de que foi o ramo de MÍDIA: a URL assinada do Storage viaja no corpo.
    const corpo = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(corpo.attachmentUrl).toBe("https://signed.example/a.jpg");
    expect(corpo.attachmentType).toBe("image");
  });

  it("sem thread: failed com o motivo nomeado — nunca `sending` nem `queued`", async () => {
    // `sending` só é varrido pelo cron `recover-stuck-messages` depois de 5min, e
    // `queued` não é varrido por ninguém (tem dono no agent-engine). Um envio que
    // não pode sair NUNCA precisa terminar num estado que espera algo.
    vi.stubEnv("ZERNIO_ACCOUNT_ID", CONTA);
    vi.stubEnv("ZERNIO_API_KEY", "sk_env");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ providerConversationId: null }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("failed");
    expect(msg.error_code).toBe("zernio_error");
    expect(String(msg.error_message)).toMatch(/zernio_no_conversation/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("o canal por QR não é afetado pelo campo novo — ele deriva o destino do contato", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "hash123");
    const fetchMock = vi.fn(async () => Response.json({ key: { id: "TEXT1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(
      conversaCompleta({ provider: "waha", providerConversationId: null }),
    );
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("sent");
    expect(msg.external_id).toBe("TEXT1");
  });
});

describe("nenhum desfecho diz `sent` sem nada ter saído", () => {
  it("credencial de env INCOMPLETA não pode virar `sent` com zero chamadas de rede", async () => {
    // ⚠️ REPRODUZ O BLOQUEADOR (lib/channels/adapters/zernio.ts:97).
    // `isConfigured()` devolve true só com `ZERNIO_API_KEY`, mas
    // `zernioCredsFromEnv()` exige TAMBÉM `ZERNIO_ACCOUNT_ID` — então `send`
    // cai no noop de "canal não conectado" e o handler, que só olha exceção,
    // grava `sent`. Observado: status `sent`, external_id null, 0 fetches.
    vi.stubEnv("ZERNIO_API_KEY", "sk_env");
    vi.stubEnv("ZERNIO_ACCOUNT_ID", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ providerConversationId: THREAD }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.status).not.toBe("sent");
  });

  it("CONTROLE: o canal oficial, com env igualmente incompleto, fica `queued`", async () => {
    // O par é o que dá sentido ao caso acima: mesma classe de má configuração,
    // desfecho oposto. Desde a #674 a decisão de elegibilidade é do `send` (o
    // pre-check síncrono não alcança o banco): ele resolve a sessão, cai no env
    // e, sem credencial nenhuma, LANÇA — o handler traduz o prefixo para
    // `queued` com motivo. O desfecho observável é o mesmo de antes.
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ provider: "meta_cloud" }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("queued");
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe("meta_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("o MODELO sai pelo canal da conversa — não pelo número da Meta", async () => {
    // Medido antes deste caso: `_handler.ts` desviava `type:'template'` para
    // `sendTemplateForSession`, que lê `META_PHONE_NUMBER_ID` e
    // `META_SYSTEM_USER_TOKEN` do ambiente e fala com a Graph API. Com os dois
    // canais configurados, o modelo de uma conversa do canal intermediado saía
    // pelo número da META, com o token da META.
    //
    // Isso não é "falha de envio": é a mensagem chegando ao cliente CERTO pelo
    // número ERRADO. Ninguém percebe, porque ela sai.
    //
    // O caso afere o DOMÍNIO da chamada, que é a única evidência que separa os
    // dois caminhos — nome de função em `grep` não separa.
    vi.stubEnv("ZERNIO_API_KEY", "k");
    vi.stubEnv("ZERNIO_ACCOUNT_ID", CONTA);
    vi.stubEnv("META_PHONE_NUMBER_ID", "111");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok-meta");
    const fetchMock = respostaOk("wamid.TPL");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ providerConversationId: THREAD }));
    await sendMessageHandler(
      supabase,
      ctx,
      texto({ type: "template", body: undefined, template_name: "cuenta_activa", template_language: "es" }),
    );

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.join(" "), "o modelo saiu pela Graph API da Meta").not.toMatch(/graph\.facebook\.com/);
    expect(urls.join(" ")).toMatch(/zernio/);
  });

  it("sem nenhuma credencial: `queued` com o motivo do canal, e nada pela rede", async () => {
    vi.stubEnv("ZERNIO_API_KEY", "");
    vi.stubEnv("ZERNIO_ACCOUNT_ID", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ providerConversationId: THREAD }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("queued");
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe("zernio_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * A promessa da TELA de conexão, do lado do handler (issue #674): quem conectou
 * o número oficial pela Central de Conexões guarda a credencial cifrada no
 * banco — e o envio tem de SAIR, sem `.env`. O pre-check síncrono respondia
 * "não configurado" para essa instalação e a mensagem morria em fila, sem erro,
 * sem nunca tentar.
 */
describe("canal oficial conectado pela TELA — a credencial da sessão manda (#674)", () => {
  it("sessão válida SEM ambiente: a mensagem SAI, com o token da sessão", async () => {
    credencialDaSessao.token = "tok-da-sessao";
    const fetchMock = respostaMeta("wamid.M1");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ provider: "meta_cloud" }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("sent");
    expect(msg.external_id).toBe("wamid.M1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/1103328999528818/messages");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer tok-da-sessao");
  });

  it("sessão ausente e sem ambiente: `queued` com `meta_not_configured`, nada na rede", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ provider: "meta_cloud" }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("queued");
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe("meta_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falha de CONSULTA fecha a ação com o código — não engole em `sent`", async () => {
    // Doutrina da #236: resolução que falha fecha a ação e abre a informação.
    credencialDaSessao.erro = { code: "PGRST116", message: "duas linhas casaram" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ provider: "meta_cloud" }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("failed");
    expect(msg.error_code).toBe("meta_error");
    expect(String(msg.error_message)).toMatch(/meta_creds_lookup_failed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("decifragem que falha e sem env: `queued` — canal não conectado é recuperável", async () => {
    credencialDaSessao.token = "cifrado-existe";
    credencialDaSessao.decifravel = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(conversaCompleta({ provider: "meta_cloud" }));
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("queued");
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe("meta_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sessão ARQUIVADA: `failed` com `channel_archived`, sem consultar credencial", async () => {
    credencialDaSessao.token = "tok-que-nao-deve-ser-usado";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = makeSupabase(
      conversaCompleta({ provider: "meta_cloud", archivedAt: "2026-08-01T00:00:00.000Z" }),
    );
    const msg = await sendMessageHandler(supabase, ctx, texto());

    expect(msg.status).toBe("failed");
    expect(msg.error_code).toBe("channel_archived");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("duas organizações: cada envio sai com o token do SEU tenant", async () => {
    const OUTRA = "99999999-9999-4999-8999-999999999999";
    credencialDaSessao.porOrg = {
      [`${ORG}|1103328999528818`]: { cifrado: "\\xaa", token: "tok-A" },
      [`${OUTRA}|1103328999528818`]: { cifrado: "\\xbb", token: "tok-B" },
    };
    const fetchMock = respostaMeta("wamid.T");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase: sbA } = makeSupabase(conversaCompleta({ provider: "meta_cloud" }));
    await sendMessageHandler(sbA, ctx, texto());
    const { supabase: sbB } = makeSupabase(conversaCompleta({ provider: "meta_cloud" }));
    await sendMessageHandler(sbB, { ...ctx, organization_id: OUTRA }, texto());

    const auth = fetchMock.mock.calls.map(
      (c) => (c[1] as { headers: Record<string, string> }).headers.Authorization,
    );
    expect(auth).toEqual(["Bearer tok-A", "Bearer tok-B"]);
  });
});
