/**
 * Task 4a do seam de canais — rede de caracterização do caminho de envio.
 *
 * Fixa os 6 desfechos que `sendMessageHandler` produz DEPOIS de inserir a linha
 * (`_handler.ts:219-318`), escrita contra o código ATUAL, antes de qualquer
 * refactor. As Tasks 4b–4d trocam `getWahaClient`/`resolveWahaChatId`/`sendMedia`
 * por `ChannelAdapter` — por isso aqui se asserta o **estado final da linha de
 * mensagem**, nunca a sequência de chamadas internas: teste que asserta chamada
 * travaria exatamente o refactor que ele deveria proteger.
 *
 * Fake próprio de propósito: `tests/invariants/automation-send-whatsapp.test.ts`
 * é o único outro teste que exercita este handler, mas arrasta `gov-helpers` e
 * exige Postgres real — e a pasta `tests/invariants/` está fora do `test:unit` e
 * do CI. Duplicar scaffolding é o preço de uma rede que gateia PR em segundos.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import { deriveActor } from '@/lib/mcp/auth';
import type { SendMessageInput } from '@/lib/schemas';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const WAHA_BASE = 'http://localhost:3030';

// A URL assinada do Storage é montada com o admin client; ele valida env no
// import, e o desfecho de mídia precisa controlar sucesso E falha da assinatura.
const signedUrl = vi.fn<() => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>>(
  async () => ({ data: { signedUrl: 'https://signed.example/a.jpg' }, error: null }),
);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: signedUrl }) } }),
}));
// Audit é fire-and-forget e escreve em outra tabela; fora do escopo dos desfechos.
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;

interface ConversationShape {
  isGroup?: boolean;
  groupChatId?: string | null;
  phoneNumber?: string | null;
  waIdentity?: string | null;
  isBlocked?: boolean;
  sessionStatus?: string | null;
  provider?: string;
  /** Canal excluído pelo usuário (migration 0106) — a linha sobrevive, o canal não. */
  archivedAt?: string | null;
}

function conversationRow(shape: ConversationShape = {}): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: shape.isGroup ?? false,
    group_chat_id: shape.groupChatId ?? null,
    contacts: {
      phone_number: shape.phoneNumber === undefined ? '+5531999998888' : shape.phoneNumber,
      wa_identity: shape.waIdentity ?? null,
      is_blocked: shape.isBlocked ?? false,
    },
    channel_sessions:
      shape.sessionStatus === null
        ? null
        : {
            // `provider` sai do banco desde a migration 0087 — o handler não
            // supõe mais o canal, então a linha falsa também não pode supor.
            provider: shape.provider ?? 'waha',
            waha_session_name: 'default',
            status: shape.sessionStatus ?? 'WORKING',
            archived_at: shape.archivedAt ?? null,
          },
  };
}

/**
 * Fake de `SupabaseClient` com o mínimo que o handler encadeia:
 *   conversations: select().eq().maybeSingle() · update().eq()
 *   messages:      insert().select().single() · update().eq().select().maybeSingle()
 *   rpc('emit_event')
 * O update é merge raso — igual ao que o Postgres faz com um SET de colunas.
 */
function makeSupabase(
  conversation: Row,
  templateRow: Row | null = null,
  /** `semColunaArquivada`: banco em que a migration 0106 ainda não rodou. */
  opts: { semColunaArquivada?: boolean; channelMetadata?: Row } = {},
) {
  const state: { message: Row | null } = { message: null };

  const client = {
    from(table: string) {
      if (table === "channel_sessions") {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: { metadata: opts.channelMetadata ?? {} }, error: null }),
        };
        return query;
      }
      if (table === 'conversations') {
        return {
          select: (cols?: string) => {
            // Encadeável SEM LIMITE de propósito: a consulta da conversa filtra
            // por id E por `organization_id` (este handler também roda com o
            // client de service role, que bypassa RLS). Um dublê que fixa a
            // quantidade de `eq` quebra quando a consulta ganha o filtro que
            // fecha o vazamento entre organizações — com um erro que não fala do
            // comportamento sob teste.
            const cadeia: Record<string, unknown> = {
              eq: () => cadeia,
              maybeSingle: async () =>
                opts.semColunaArquivada === true && (cols ?? '').includes('archived_at')
                  ? {
                      data: null,
                      error: {
                        code: '42703',
                        message: 'column channel_sessions_1.archived_at does not exist',
                      },
                    }
                  : { data: conversation, error: null },
            };
            return cadeia;
          },
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'meta_templates') {
        // O espelho local do template. `templateRow` é injetado por caso; null
        // simula template que não existe (ou WABA errada).
        //
        // A cadeia é ENCADEÁVEL SEM LIMITE de propósito. A versão anterior tinha
        // exatamente três `eq` aninhados, e isso fazia o dublê ditar quantos
        // filtros o código de produção podia usar: acrescentar um quarto (a
        // conexão dona da definição, da 0144) quebrava com `q.eq is not a
        // function` — um vermelho que não fala do comportamento sob teste e
        // manda quem lê procurar defeito onde não há.
        const cadeia: Record<string, unknown> = {
          eq: () => cadeia,
          is: () => cadeia,
          maybeSingle: async () => ({ data: templateRow, error: null }),
        };
        return { select: () => cadeia };
      }
      if (table === 'messages') {
        return {
          insert: (row: Row) => {
            state.message = {
              id: 'msg-1',
              external_id: null,
              ack: null,
              error_code: null,
              error_message: null,
              ...row,
            };
            return { select: () => ({ single: async () => ({ data: { ...state.message }, error: null }) }) };
          },
          update: (patch: Row) => {
            state.message = { ...state.message, ...patch };
            const query = {
              eq: () => query,
              select: () => query,
              maybeSingle: async () => ({ data: { ...state.message }, error: null }),
              single: async () => ({ data: { ...state.message }, error: null }),
            };
            return query;
          },
        };
      }
      if (table === "contacts") {
        // O envio carimba `contacts.last_activity_at` (migration 0162). O dublê
        // é encadeável SEM LIMITE de propósito: a consulta filtra por id E por
        // organização (este handler também roda com o client de service role,
        // que bypassa RLS), e um dublê que fixa a quantidade de `eq` quebra
        // quando a consulta ganha um filtro novo — com um erro que não fala do
        // comportamento sob teste.
        const cadeiaContacts: Record<string, unknown> = {
          eq: () => cadeiaContacts,
          then: (resolve: (v: { error: null }) => unknown) =>
            Promise.resolve({ error: null }).then(resolve),
        };
        return { update: () => cadeiaContacts };
      }
      throw new Error(`fake_supabase: tabela inesperada '${table}'`);
    },
    rpc: async () => ({ error: null }),
  };

  return client as unknown as SupabaseClient;
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-1' };

function textInput(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return { conversation_id: CONV, type: 'text', body: 'oi', ...over } as SendMessageInput;
}

function wahaConfigured(configured: boolean) {
  vi.stubEnv('WAHA_API_BASE_URL', configured ? WAHA_BASE : '');
  vi.stubEnv('WAHA_API_KEY', configured ? 'hash123' : '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  signedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/a.jpg' }, error: null });
});

describe('sendMessageHandler — os 6 desfechos do envio', () => {
  it("revalida a lista no sink, inclusive para automação, sem transformar teste em opt-out", async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const actor of [{ type: "ai_agent", id: USER, role: "agent" }, { type: "webhook_source", id: USER }] as const) {
      const message = await sendMessageHandler(makeSupabase(conversationRow(), null, {
        channelMetadata: { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [] },
      }), { ...ctx, actor }, textInput());
      expect(message).toMatchObject({ status: "failed", error_code: "pre_go_live" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("número autorizado passa pelo gate; resposta humana não depende da lista", async () => {
    wahaConfigured(false);
    const channelMetadata = { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: ["+5531999998888"] };
    const tester = await sendMessageHandler(makeSupabase(conversationRow(), null, { channelMetadata }),
      { ...ctx, actor: { type: "ai_agent", id: USER, role: "agent" } }, textInput());
    expect(tester.status).toBe("queued");
    const human = await sendMessageHandler(makeSupabase(conversationRow(), null, {
      channelMetadata: { ...channelMetadata, ai_test_phone_numbers: [] },
    }), ctx, textInput());
    expect(human.status).toBe("queued");
  });
  it('1. WAHA não configurado: fica queued com queued_reason, nada sai pela rede', async () => {
    wahaConfigured(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('waha_not_configured');
    expect(msg.error_code).toBeNull();
    expect(msg.external_id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2. sem destinatário resolvível: failed/missing_phone_number', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ phoneNumber: null, waIdentity: null })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('missing_phone_number');
    expect(msg.error_message).toBe('Contato sem telefone para envio WhatsApp.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3. sessão fora de WORKING: fica queued com channel_session_not_working', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ sessionStatus: 'SCAN_QR_CODE' })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('channel_session_not_working');
    expect(msg.error_code).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Os desfechos 4 e 5 gravam a MESMA linha final. O que os separa é o efeito
  // externo — por qual endpoint a mensagem saiu. Isso não é "sequência de
  // chamadas internas": é o que de fato deixa o processo, e o refactor das
  // Tasks 4b–4d tem que preservá-lo (o adapter WAHA fala com o mesmo WAHA).
  it('4. com media_storage_path: sent + external_id + ack 0, pelo endpoint de mídia', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ id: { _serialized: 'MEDIA1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow()),
      ctx,
      textInput({ type: 'image', body: undefined, media_storage_path: `${ORG}/${CONV}/a.jpg`, media_mime: 'image/jpeg' }),
    );

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('MEDIA1');
    expect(msg.ack).toBe(0);
    expect(msg.error_code).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `${WAHA_BASE}/api/sendImage`)).toBe(
      true,
    );
  });

  it('5. texto puro: sent + external_id + ack 0, pelo endpoint de texto', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ key: { id: 'TEXT1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('TEXT1');
    expect(msg.ack).toBe(0);
    expect(msg.error_code).toBeNull();
    const sendText = fetchMock.mock.calls.find(([url]) => String(url) === `${WAHA_BASE}/api/sendText`);
    expect(sendText, 'sendText não foi chamado').toBeTruthy();
    // Task 7: a sessão que chega ao fio sai de `resolveSessionRef` (que escolhe a
    // COLUNA conforme o provider), não mais de um acesso direto à coluna do
    // provider legado. Sem esta linha, um resolvedor que devolva a coluna errada
    // manda `session: undefined` e a rede inteira continua verde — medido.
    const body = JSON.parse(String((sendText![1] as RequestInit).body)) as {
      session: string;
    };
    expect(body.session).toBe('default');
  });

  it('6. envio lança: failed/waha_error com a mensagem do erro', async () => {
    wahaConfigured(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('waha_error');
    expect(msg.error_message).toBe('waha_500');
    expect(msg.external_id).toBeNull();
  });

  // Task 7: o fallback de `error_message` quando o throw NÃO é um `Error`. O
  // valor vai para o banco, então trocá-lo é mudança de comportamento — ele saiu
  // do literal no handler para `adapter.codes`, com o mesmo texto.
  it('6c. throw que não é Error: error_message vem de adapter.codes.unknownError', async () => {
    wahaConfigured(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'nao-sou-um-Error';
      }),
    );

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('waha_error');
    expect(msg.error_message).toBe('waha_unknown');
  });

  // Task 6: o canal sai do banco (`channel_sessions.provider`, migration 0087) e
  // não de um literal. Esta é a sabotagem que reprova o retorno do `getAdapter("waha")`
  // fixo: com o literal de volta, a sessão enviaria pelo canal errado e o teste ficaria
  // vermelho por não ter lançado.
  //
  // ⚠️ Este caso usava `meta_cloud` como "provider sem adapter". Na Fase 3b o adapter
  // da Meta nasceu, e ele deixou de servir — a rede pegou a mudança, que é o trabalho
  // dela. Trocado por um provider que NÃO existe: o que se testa aqui é o fail-closed,
  // não qual canal está pronto. Amarrar o caso a um canal específico o faria expirar de
  // novo na próxima fase.
  it('7. o canal vem da sessão: provider desconhecido falha fechado, não cai em nenhum canal', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendMessageHandler(
        makeSupabase(conversationRow({ provider: 'canal_inexistente' })),
        ctx,
        textInput(),
      ),
    ).rejects.toThrow(/unknown_channel_provider: canal_inexistente/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('7b. sessão meta_cloud agora RESOLVE adapter — a Fase 3b o criou', async () => {
    // O par com o caso 7 é o que dá sentido aos dois: um prova que provider
    // desconhecido não vaza para canal nenhum; este prova que o canal oficial
    // deixou de ser desconhecido.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.META' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' })),
      ctx,
      textInput(),
    );
    expect((msg as { status: string }).status).toBe('sent');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('graph.facebook.com');
  });

  it('6b. assinatura do Storage falha: failed/storage_sign_failed, não waha_error', async () => {
    wahaConfigured(true);
    signedUrl.mockResolvedValue({ data: null, error: { message: 'no_object' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow()),
      ctx,
      textInput({ type: 'image', body: undefined, media_storage_path: `${ORG}/${CONV}/a.jpg`, media_mime: 'image/jpeg' }),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('storage_sign_failed');
    expect(msg.error_message).toContain('no_object');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A ORDEM entre os desfechos é comportamento, não detalhe: se o pre-check de
  // configuração descer para depois da resolução do destinatário, uma instalação
  // sem WAHA passa a marcar a mensagem como `failed` em vez de deixá-la em fila.
  it('ordem: sem WAHA E sem telefone → waha_not_configured, nunca missing_phone_number', async () => {
    wahaConfigured(false);
    vi.stubGlobal('fetch', vi.fn());

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ phoneNumber: null, waIdentity: null })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('waha_not_configured');
    expect(msg.error_code).toBeNull();
  });

  it('8. type=template envia pelo caminho do template e grava nome e idioma', async () => {
    // O ramo NOVO. Grava `template_name`/`template_language` porque o tipo sozinho
    // não responde "qual template custou o quê" — e template é cobrado por entrega.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.TPL' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' }), {
        name: 'pedido_confirmado',
        language: 'pt_BR',
        status: 'APPROVED',
        contract_hash: 'h',
        components: [{ type: 'BODY', text: 'Ola {{1}}' }],
      }),
      ctx,
      {
        conversation_id: 'conv-1',
        type: 'template',
        template_name: 'pedido_confirmado',
        template_language: 'pt_BR',
        template_values: { '1': 'Rafael' },
      } as Parameters<typeof sendMessageHandler>[2],
    );

    const linha = msg as unknown as { status: string; external_id: string; template_name: string };
    expect(linha.status).toBe('sent');
    expect(linha.external_id).toBe('wamid.TPL');
    expect(linha.template_name).toBe('pedido_confirmado');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('graph.facebook.com');
  });

  it('8b. template ausente do espelho FALHA, não envia às cegas', async () => {
    // Sem esta guarda, um nome errado viraria 132000 na Meta — cobrado e tarde.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' }), null),
      ctx,
      {
        conversation_id: 'conv-1',
        type: 'template',
        template_name: 'nao_existe',
        template_language: 'pt_BR',
        template_values: {},
      } as Parameters<typeof sendMessageHandler>[2],
    );

    const linha = msg as unknown as { status: string; error_message: string };
    expect(linha.status).toBe('failed');
    expect(linha.error_message).toMatch(/template_missing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⭐ A promessa do `comment on column` de 0100 ("não é mais elegível para envio")
   * virando comportamento. `failed` e não `queued` porque fila implica "sai depois",
   * e por este canal não sai nunca: o número já foi deslogado no transporte, e o
   * ledger do agente lê `queued` como algo a reconciliar mais tarde.
   */
  it('8. canal ARQUIVADO: failed/channel_archived, nada sai pela rede', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ archivedAt: '2026-08-05T10:00:00.000Z' })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('channel_archived');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⭐ Este é O caminho de saída do sistema (UI, automação, MCP e agente passam
   * por aqui). Num clone que subiu o CÓDIGO sem aplicar a migration 0106 — cenário
   * medido neste projeto —, pedir `archived_at` direto derrubaria TODO envio com
   * 42703. Sem a coluna nada está arquivado, então repetir sem ela é o resultado
   * exato, não um paliativo.
   */
  it('9. banco sem a coluna archived_at (migration não aplicada): o envio segue normalmente', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ key: { id: 'TEXT9' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow(), null, { semColunaArquivada: true }),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('TEXT9');
  });
});

/**
 * TOKEN DE SERVIDOR NO PONTO DE USO (#848).
 *
 * `lib/mcp/auth-ator.test.ts` guarda a FUNÇÃO: `deriveActor` devolve
 * `api_token`. Não guarda o que o handler faz com isso. Medido na triagem: trocar
 * `=== "user"` por `!== "ai_agent"` nas duas linhas do handler deixa os 6 casos
 * daquele arquivo verdes — e a única falha que sobra na suíte relacionada vem do
 * `webhook_source` do caso de gate acima, por acidente. Uma regressão que reabra
 * só o token (`=== "user" || === "api_token"`) não derrubava nada.
 *
 * O ator vem de `deriveActor`, e não de um literal: é o que `resolveAuthDual` e
 * o servidor MCP entregam ao handler para um token sem escopo de agente. Assim a
 * função e o ponto de uso ficam presos no mesmo caso.
 *
 * `sent_via` do token PASSOU a ser asserido — e é a prova fail-first do fix: o
 * caso abaixo nasceu VERMELHO contra o código de antes (a linha gravava `"ai"`,
 * contra o próprio argumento deste arquivo) e é ele que a #866 faz passar.
 */
describe('sendMessageHandler — token de servidor (api_token) no ponto de uso', () => {
  const TOKEN_ID = '77777777-7777-4777-8777-777777777777';
  const tokenDeServidor = deriveActor(['mcp:write'], TOKEN_ID);

  it('grava sent_by_user_id = null: o id do TOKEN não vai para a coluna com FK para auth.users', async () => {
    wahaConfigured(false);
    vi.stubGlobal('fetch', vi.fn());

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow()),
      { ...ctx, actor: tokenDeServidor },
      textInput(),
    );

    expect(tokenDeServidor.type, 'o caso perdeu o alvo: o ator já não é api_token').toBe('api_token');
    expect(
      msg.sent_by_user_id,
      'o handler gravou o id do token em sent_by_user_id — em Postgres isso é violação de FK e o envio morre com 500',
    ).toBeNull();
  });

  it('consulta o modo de teste do canal: número fora da lista não recebe, e nada sai pela rede', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ key: { id: 'NAO-DEVIA-SAIR' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow(), null, {
        channelMetadata: { ai_gate: 'allowlist', ai_gate_mode: 'pre_go_live', ai_test_phone_numbers: [] },
      }),
      { ...ctx, actor: tokenDeServidor },
      textInput(),
    );

    expect(
      msg,
      'o token atravessou o modo de teste do canal — pular o gate é privilégio de pessoa, não de integração',
    ).toMatchObject({ status: 'failed', error_code: 'pre_go_live' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('grava sent_via = "system": a integração não é a IA', async () => {
    // A coluna tem CHECK de conjunto e `system` está nele desde sempre — e
    // nenhuma linha de app/, lib/ ou workers/ o gravava: o ternário do handler
    // dizia `ai` para tudo que não fosse pessoa. Com isso, o envio de uma
    // integração entrava na leitura de "quanto a IA falou" (`supabase/baseline.sql`:
    // `por_ia = count(*) filter (where m.sent_via = 'ai')`) e recebia o mesmo
    // álibi de eco que a ingestão só concede a envio NASCIDO aqui.
    //
    // O valor medido é o da LINHA, não o da decisão: quem grava errado é o
    // INSERT, e é ele que a tela do inbox lê depois.
    wahaConfigured(false);
    vi.stubGlobal('fetch', vi.fn());

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow()),
      { ...ctx, actor: tokenDeServidor },
      textInput(),
    );

    expect(
      msg.sent_via,
      'o envio da integração nasceu carimbado como `ai`: o balão mostra "IA" para o que a integração mandou e a contagem de mensagens da IA conta envio que nenhum algoritmo escreveu',
    ).toBe('system');
  });
});
