/**
 * Task 3 do seam de canais. O adapter é BURRO de propósito: traduz formato e
 * delega. Não há caso aqui sobre janela, cap ou horário — se um aparecer, o
 * desenho vazou (a regra pertence à cadeia `before_send`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '@/lib/channels';
import { DETALHE_CREDENCIAL_RECUSADA } from '@/lib/channels/health';
import { statusHttpDoErroWaha } from '@/lib/channels/adapters/waha';

/** A organização atravessa o seam desde a issue #236. */
const ORG = "00000000-0000-4000-8000-000000000236";

const WAHA_BASE = 'http://localhost:3030';

/** Sobe o WAHA "configurado" e devolve o fetch espionado. */
function stubWaha(
  response: unknown,
  checkExists?: (phone: string) => { numberExists: boolean; pn?: string; chatId?: string },
) {
  vi.stubEnv('WAHA_API_BASE_URL', WAHA_BASE);
  vi.stubEnv('WAHA_API_KEY', 'hash123');
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const href = String(url);
    if (href.includes('/api/contacts/check-exists')) {
      const phone = new URL(href).searchParams.get('phone') ?? '';
      const body = checkExists?.(phone) ?? { numberExists: true, chatId: `${phone}@c.us` };
      return Promise.resolve(Response.json(body));
    }
    return Promise.resolve(Response.json(response));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sendTextBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/sendText'));
  expect(call, 'sendText não foi chamado').toBeTruthy();
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('adapter WAHA', () => {
  it('resolve destinatário 1:1 por telefone', () => {
    const a = getAdapter('waha');
    expect(
      a.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: '+5531999998888',
        waIdentity: null,
      }),
    ).toBe('5531999998888@c.us');
  });

  it('resolve destinatário por lid quando não há telefone', () => {
    const a = getAdapter('waha');
    expect(
      a.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: 'lid:12345',
      }),
    ).toBe('12345@lid');
  });

  it('resolução de adapter é fail-closed', () => {
    // @ts-expect-error provider inexistente é erro de tipo E de runtime
    expect(() => getAdapter('telegram')).toThrow(/unknown_channel_provider/);
  });

  // `isConfigured` existe porque `send` devolvendo `{externalId:null}` colapsa
  // dois desfechos que o handler trata diferente: "não tentei" (fica `queued`)
  // e "tentei e a resposta não tinha id" (vira `sent`). Sem este pre-check, a
  // primeira viraria `sent` sem ter saído — perda de mensagem, não refactor.
  it('isConfigured é false sem env do canal', () => {
    vi.stubEnv('WAHA_API_BASE_URL', '');
    vi.stubEnv('WAHA_API_KEY', '');
    expect(getAdapter('waha').isConfigured()).toBe(false);
  });

  it('isConfigured é true com env do canal', () => {
    vi.stubEnv('WAHA_API_BASE_URL', WAHA_BASE);
    vi.stubEnv('WAHA_API_KEY', 'hash123');
    expect(getAdapter('waha').isConfigured()).toBe(true);
  });

  // Os códigos vivem no adapter porque carregam nome de provider, e o lint da
  // Task 7 proíbe esse nome fora de `lib/channels/`. Os valores são os literais
  // que o handler grava hoje — mudá-los é mudança de comportamento.
  it('codes carrega os literais que o handler grava', () => {
    expect(getAdapter('waha').codes).toEqual({
      notConfigured: 'waha_not_configured',
      sendFailed: 'waha_error',
      // Task 7: era literal no handler; o VALOR não muda (é gravado em
      // `messages.error_message`), só a casa.
      unknownError: 'waha_unknown',
    });
  });

  it('canal não configurado é NOOP, não erro — e nada sai pela rede', async () => {
    vi.stubEnv('WAHA_API_BASE_URL', '');
    vi.stubEnv('WAHA_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getAdapter('waha').send({
        organizationId: ORG,
        sessionRef: 's',
        to: '5531999998888@c.us',
        kind: 'text',
        body: 'oi',
      }),
    ).resolves.toEqual({ externalId: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('texto vai por sendText e o id externo sai parseado', async () => {
    const fetchMock = stubWaha({ id: { _serialized: 'ABC123' } });

    const res = await getAdapter('waha').send({
      organizationId: ORG,
      sessionRef: 'default',
      to: '5531999998888@c.us',
      kind: 'text',
      body: 'oi',
    });

    expect(res).toEqual({ externalId: 'ABC123' });
    expect(sendTextBody(fetchMock)).toEqual({
      session: 'default',
      chatId: '5531999998888@c.us',
      text: 'oi',
    });
  });

  it('envia pelo chatId sem o nono quando o WhatsApp não reconhece o 13 dígitos', async () => {
    const fetchMock = stubWaha({ id: { _serialized: 'ABC123' } }, (phone) =>
      phone === '553198966398'
        ? { numberExists: true, pn: '553198966398@c.us' }
        : { numberExists: false },
    );

    await getAdapter('waha').send({
      organizationId: ORG,
      sessionRef: 'default',
      to: '5531998966398@c.us',
      kind: 'text',
      body: 'oi',
    });

    expect(sendTextBody(fetchMock).chatId).toBe('553198966398@c.us');
  });

  it('lead só com telefone: envia ao @lid que o check-exists devolveu', async () => {
    const fetchMock = stubWaha({ id: { _serialized: 'ABC123' } }, () => ({
      numberExists: true,
      chatId: '23423462304912@lid',
      pn: '5532984793302@c.us',
    }));

    await getAdapter('waha').send({
      organizationId: ORG,
      sessionRef: 'default',
      to: '5532984793302@c.us',
      kind: 'text',
      body: 'oi',
    });

    expect(sendTextBody(fetchMock).chatId).toBe('23423462304912@lid');
  });

  it('áudio vai pelo plano de mídia do WAHA (sendVoice), não por sendText', async () => {
    const fetchMock = stubWaha({ key: { id: 'VOICE1' } });

    const res = await getAdapter('waha').send({
      organizationId: ORG,
      sessionRef: 'default',
      to: '5531999998888@c.us',
      kind: 'audio',
      media: { url: 'https://x/a.ogg', mime: 'audio/ogg' },
    });

    expect(res).toEqual({ externalId: 'VOICE1' });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/sendVoice'));
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      session: 'default',
      chatId: '5531999998888@c.us',
      file: { url: 'https://x/a.ogg', mimetype: 'audio/ogg' },
      convert: true,
    });
  });

  /**
   * ─── O que estes casos custaram ────────────────────────────────────────────
   *
   * Numa VPS de produção, uma segunda cópia do repo recriou o contêiner do WAHA
   * com a chave do `.env` DELA. A partir dali toda chamada respondia 401. O
   * `checkHealth` jogava isso no ramo genérico, a Central dizia "não foi
   * possível verificar a conexão" — a frase de um soluço de rede — e ficou
   * assim por TRÊS DIAS, com o WhatsApp inteiro parado.
   */
  describe('checkHealth traduz o erro do transporte', () => {
    /** Sobe o WAHA e faz `fetch` responder um HTTP cru (o client lança daí). */
    function stubWahaHttp(status: number, body = '{}') {
      vi.stubEnv('WAHA_API_BASE_URL', WAHA_BASE);
      vi.stubEnv('WAHA_API_KEY', 'hash123');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
    }

    it('401 é credencial recusada, não "não deu para perguntar"', async () => {
      stubWahaHttp(401, '{"message":"Unauthorized","statusCode":401}');
      const h = await getAdapter('waha').checkHealth!({ organizationId: ORG, sessionRef: 'org_x' });
      expect(h.detail).toBe(DETALHE_CREDENCIAL_RECUSADA);
      // Segue sem afirmar o estado da SESSÃO: o que se sabe é que o acesso ao
      // transporte foi negado, não que este número caiu.
      expect(h.status).toBeNull();
    });

    it('403 idem — chave existe e não vale', async () => {
      stubWahaHttp(403);
      const h = await getAdapter('waha').checkHealth!({ organizationId: ORG, sessionRef: 'org_x' });
      expect(h.detail).toBe(DETALHE_CREDENCIAL_RECUSADA);
    });

    it('404 é sessão parada — o único estado que dá para afirmar por erro', async () => {
      stubWahaHttp(404);
      const h = await getAdapter('waha').checkHealth!({ organizationId: ORG, sessionRef: 'org_x' });
      expect(h).toEqual({ reachable: true, status: 'STOPPED', detail: null });
    });

    it('500 fica em "não sei" — inventar estado é o que ensina a ignorar o aviso', async () => {
      stubWahaHttp(500);
      const h = await getAdapter('waha').checkHealth!({ organizationId: ORG, sessionRef: 'org_x' });
      expect(h.reachable).toBe(false);
      expect(h.status).toBeNull();
      expect(h.detail).not.toBe(DETALHE_CREDENCIAL_RECUSADA);
    });

    it('lê o status do PREFIXO, nas duas formas que o client lança', () => {
      // Duas formas porque `lib/waha/client.ts` tem duas: `getSessionQr` lança
      // `waha_<status>` seco, e create/start/stop/logout/delete anexam o CORPO
      // da resposta. Só a primeira chega ao checkHealth hoje — mas a função é
      // compartilhada, e é o corpo que torna a leitura por `includes` ambígua.
      expect(statusHttpDoErroWaha('waha_401')).toBe(401);
      expect(statusHttpDoErroWaha('waha_create_401: {"message":"Unauthorized"}')).toBe(401);
      expect(statusHttpDoErroWaha('waha_404')).toBe(404);

      // O caso que `includes("404")` erra: o 404 está no CORPO de um 500. Ler o
      // prefixo devolve o status de verdade; varrer a string inteira daria 404
      // e transformaria um transporte quebrado em "essa sessão está parada".
      expect(statusHttpDoErroWaha('waha_stop_500: {"detail":"upstream 404 not found"}')).toBe(500);

      // Nada que não venha do client vira status — inclusive texto que CONTÉM
      // um número de três dígitos.
      expect(statusHttpDoErroWaha('fetch failed 401')).toBeNull();
      expect(statusHttpDoErroWaha('erro_desconhecido')).toBeNull();
    });
  });
});

describe('adapter WAHA — alterar mensagem enviada', () => {
  it('edita pelo id completo reconstruído a partir da cauda gravada no envio', async () => {
    const fetchMock = stubWaha({});
    await getAdapter('waha').editMessage!({
      organizationId: ORG, sessionRef: 'numero-1', recipient: '5511999999999@c.us',
      externalId: 'ABC', text: 'depois',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${WAHA_BASE}/api/numero-1/chats/5511999999999%40c.us/messages/true_5511999999999%40c.us_ABC`);
    expect(init.method).toBe('PUT');
  });

  it('id completo gravado pelo webhook vence o endereço do contato', async () => {
    const fetchMock = stubWaha({});
    await getAdapter('waha').revokeMessage!({
      organizationId: ORG, sessionRef: 's', recipient: '5511999999999@c.us',
      externalId: 'true_123@lid_ABC',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${WAHA_BASE}/api/s/chats/123%40lid/messages/true_123%40lid_ABC`);
    expect(init.method).toBe('DELETE');
  });

  it('sem endereço possível, recusa antes de ir à rede', async () => {
    const fetchMock = stubWaha({});
    await expect(getAdapter('waha').revokeMessage!({
      organizationId: ORG, sessionRef: 's', recipient: null, externalId: 'ABC',
    })).rejects.toThrow('recipient_unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
