import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';
import { criarDubleDoHandler } from '@/tests/helpers/duble-do-handler';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

/**
 * A MESMA FRASE NÃO PODE APARECER DUAS VEZES NA CONVERSA.
 *
 * O envio grava a linha ANTES de falar com o canal (`status: "queued"`,
 * `external_id` NULL) e só carimba o id num UPDATE depois que o adapter volta.
 * Todo envio volta pelo webhook como `fromMe=true`; o eco que chega DENTRO desse
 * intervalo não encontra nada para casar — nem pelo id completo, nem pelo bare —
 * e nasce uma segunda linha.
 *
 * No NOWEB (engine padrão do kit) isso é comportamento NOVO desde o PR #108:
 * antes, o eco era descartado junto com as mensagens legítimas do celular, e o
 * defeito maior escondia o menor. Medido na época: pré-PR/NOWEB dava 1 linha,
 * pós-PR/NOWEB dá 2.
 *
 * ⚠️ POR QUE A CORREÇÃO É AQUI E NÃO NO INGEST. A tentação é o webhook casar a
 * linha `queued` da conversa. Isso foi medido e REPROVADO: a linha `queued` não
 * carrega nada que a identifique como sendo daquela mensagem, então casar por
 * ela é casar por "existe um envio em voo nesta conversa" — o que vale para o
 * eco E para uma mensagem legítima que o atendente digitou no celular enquanto o
 * envio estava em voo. O falso positivo seria o próprio defeito do #108 de volta,
 * e permanente: nada no sistema tira uma linha de `queued` (o cron
 * `recover-stuck-messages` do CLAUDE.md:93 não existe no código).
 *
 * O lado do ENVIO não tem essa ambiguidade: ele sabe qual linha é dele e acabou
 * de receber do canal o id exato da mensagem que mandou. Casa por ID.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const OUTRA_CONV = '99999999-9999-4999-8999-999999999999';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';

/** O que o WAHA/NOWEB devolve no envio: o id BARE, sem o chat. */
const BARE = '3EB0ABCDEF0123456789';
/** O mesmo id como o webhook o entrega de volta: composto. */
const COMPOSTO = `true_5531999998888@c.us_${BARE}`;

type Row = Record<string, unknown>;

function conversationRow(): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    contacts: { phone_number: '+5531999998888', wa_identity: null, is_blocked: false },
    channel_sessions: { provider: 'waha', waha_session_name: 'default', status: 'WORKING' },
  };
}

/**
 * O dublê é o COMPARTILHADO (`tests/helpers/duble-do-handler.ts`): ele monta a
 * tabela `messages` de verdade — aqui com as linhas que já estavam antes do
 * envio — e a devolve viva. O desfecho deste caso é "quantas linhas sobraram",
 * então um dublê de linha única responderia sempre 1 e o teste passaria sem
 * tocar no defeito.
 */
function dubleCom(preexistentes: Row[] = []) {
  const { supabase, mensagens } = criarDubleDoHandler({
    conversation: conversationRow(),
    mensagensIniciais: preexistentes,
    // O índice único (organization_id, external_id) é a regra de banco da qual
    // este desfecho depende: sem ele, gravar o id numa linha quando outra já o
    // tem passaria batido.
    indiceUnicoMensagem: true,
  });
  return { supabase, messages: mensagens };
}

/** A linha que o webhook cria quando o eco chega antes do envio terminar. */
function ecoDoWebhook(over: Row = {}): Row {
  return {
    id: 'eco-1',
    organization_id: ORG,
    conversation_id: CONV,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    external_id: COMPOSTO,
    direction: 'outbound',
    status: 'sent',
    body: 'oi',
    sent_via: 'external_device',
    ...over,
  };
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-1' };
const input = { conversation_id: CONV, type: 'text', body: 'oi' } as SendMessageInput;

function wahaRespondendo(idBare: string) {
  vi.stubEnv('WAHA_API_BASE_URL', 'http://localhost:3030');
  vi.stubEnv('WAHA_API_KEY', 'hash123');
  // NOWEB devolve o id interno cru — é daí que sai o `external_id` do envio.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: { id: idBare } }), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('eco do próprio envio na janela em que a linha ainda não tem external_id', () => {
  it('o eco que chegou primeiro não deixa a frase duplicada', async () => {
    wahaRespondendo(BARE);
    const { supabase, messages } = dubleCom([ecoDoWebhook()]);

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.external_id === BARE || m.external_id === COMPOSTO);
    expect(daMensagem, 'a mesma frase ficou duas vezes na conversa').toHaveLength(1);
  });

  it('a linha que sobra é a do ENVIO, com autoria — não a do webhook', async () => {
    // Qual das duas sobrevive importa: a do envio carrega `sent_by_user_id` e
    // `sent_via`, que é o que a tela usa para dizer quem falou. Ficar com a do
    // webhook apagaria a autoria.
    wahaRespondendo(BARE);
    const { supabase, messages } = dubleCom([ecoDoWebhook()]);

    await sendMessageHandler(supabase, ctx, input);

    const sobrou = messages.find((m) => m.external_id === BARE || m.external_id === COMPOSTO)!;
    expect(sobrou.sent_by_user_id).toBe(USER);
    expect(sobrou.sent_via).toBe('user');
    expect(sobrou.status).toBe('sent');
  });

  it('sem eco nenhum, nada é removido e o envio segue normal', async () => {
    // Guarda de vacuidade: se a correção apagasse indiscriminadamente, este caso
    // ainda daria 1 linha — por isso ele também confere que a linha é a do envio
    // e que ela recebeu o id.
    wahaRespondendo(BARE);
    const { supabase, messages } = dubleCom();

    await sendMessageHandler(supabase, ctx, input);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
    expect(messages[0]!.status).toBe('sent');
  });
});

describe('eco com OUTRO formato de chat (@lid × @c.us) — medido em 06/10/2026', () => {
  it('o envio foi pelo número e o eco voltou pelo @lid: a duplicata sai mesmo assim', async () => {
    // O composto que o envio constrói usa o chat do ENVIO (`…@c.us`); o NOWEB
    // ecoou pelo outro formato do mesmo contato. Antes, este eco ficava.
    wahaRespondendo(BARE);
    const { supabase, messages } = dubleCom([
      ecoDoWebhook({ external_id: `true_65721790906556@lid_${BARE}` }),
    ]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages, 'o eco pelo @lid sobreviveu e a frase ficou duas vezes').toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
  });

  it('o sufixo é o id INTEIRO: outra mensagem que só termina parecido não é tocada', async () => {
    wahaRespondendo(BARE);
    const outra = ecoDoWebhook({ id: 'celular-1', external_id: `true_65721790906556@lid_XX${BARE}`, body: 'outra' });
    const { supabase, messages } = dubleCom([outra]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.map((m) => m.id)).toContain('celular-1');
  });
});

describe('o que a correção NÃO pode apagar', () => {
  it('mensagem que o dono digitou no celular na MESMA conversa continua lá', async () => {
    // ESTE é o caso que reprovou a correção pelo lado do webhook. Uma mensagem
    // legítima de dispositivo externo, na mesma conversa, durante o envio — ela
    // só não é o eco porque o id é OUTRO. Casar por id preserva; casar por
    // "envio em voo" apagaria.
    wahaRespondendo(BARE);
    const outraMensagem = ecoDoWebhook({
      id: 'celular-1',
      external_id: 'true_5531999998888@c.us_3EB0OUTRAMENSAGEM99',
      body: 'vou verificar e ja te falo',
    });
    const { supabase, messages } = dubleCom([outraMensagem]);

    await sendMessageHandler(supabase, ctx, input);

    expect(
      messages.find((m) => m.body === 'vou verificar e ja te falo'),
      'apagou uma mensagem legítima do celular',
    ).toBeDefined();
    expect(messages).toHaveLength(2);
  });

  it('eco com o mesmo id em OUTRA conversa não é tocado', async () => {
    // O bare pode colidir entre mensagens diferentes (não há garantia nossa, só
    // a do WhatsApp). Restringir à conversa do envio mantém o estrago de uma
    // colisão dentro do único lugar onde ela seria mesmo a nossa mensagem.
    wahaRespondendo(BARE);
    const deOutraConversa = ecoDoWebhook({ id: 'outro-1', conversation_id: OUTRA_CONV });
    const { supabase, messages } = dubleCom([deOutraConversa]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.find((m) => m.id === 'outro-1'), 'apagou linha de outra conversa').toBeDefined();
  });

  it('linha do CRM (não-webhook) com o mesmo id não é tocada', async () => {
    // Só o eco nasce com `sent_via: external_device`. Uma linha nossa com o
    // mesmo id seria outra coisa — e apagá-la seria perder envio de verdade.
    wahaRespondendo(BARE);
    const doCrm = ecoDoWebhook({ id: 'crm-1', sent_via: 'ai' });
    const { supabase, messages } = dubleCom([doCrm]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.find((m) => m.id === 'crm-1'), 'apagou uma linha que não era eco de dispositivo').toBeDefined();
  });
});

describe('o eco que entra ENTRE a limpeza e o carimbo do id (#1855)', () => {
  /**
   * Com o eco gravando o id curto (bare) — o mesmo que o envio grava —, a
   * colisão no unique `(organization_id, external_id)` passou a poder cair do
   * lado do ENVIO: a limpeza do eco e o UPDATE que carimba o id são duas
   * chamadas, e o eco que o webhook insere entre elas ocupa o id primeiro. O
   * UPDATE volta `23505`, e ignorar esse erro deixava a linha do envio em
   * `queued`, sem id — sem ack e à mercê de um reenvio.
   *
   * O dublê não tem relógio: o eco é injetado logo depois do DELETE, que é
   * exatamente a ordem que a corrida produz.
   */
  function ecoEntraDepoisDaLimpeza(
    supabase: ReturnType<typeof dubleCom>['supabase'],
    messages: Row[],
    eco: Row,
  ) {
    const from = supabase.from.bind(supabase);
    let injetado = false;
    (supabase as unknown as { from: (t: string) => unknown }).from = (tabela: string) => {
      const q = from(tabela) as unknown as { delete?: () => { then: PromiseLike<unknown>['then'] } };
      if (tabela !== 'messages' || !q.delete) return q;
      const del = q.delete.bind(q);
      q.delete = () => {
        const cadeia = del();
        const then = cadeia.then.bind(cadeia);
        cadeia.then = (ok, falha) =>
          then((v) => {
            if (!injetado) {
              injetado = true;
              messages.push(eco);
            }
            return ok ? ok(v) : v;
          }, falha) as never;
        return cadeia;
      };
      return q;
    };
  }

  it('o envio fica `sent` com o id, e a frase aparece uma vez só', async () => {
    wahaRespondendo(BARE);
    const { supabase, messages } = dubleCom();
    ecoEntraDepoisDaLimpeza(supabase, messages, ecoDoWebhook({ external_id: BARE }));

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.external_id === BARE);
    expect(daMensagem, 'a mesma frase ficou duas vezes, ou nenhuma linha ficou com o id').toHaveLength(1);
    expect(daMensagem[0]!.sent_via, 'sobrou o eco do webhook, não a linha do envio').toBe('user');
    expect(daMensagem[0]!.status).toBe('sent');
  });

  it('se o id segue ocupado por linha que não é eco, o envio fica `sent` sem id — nunca preso em `queued`', async () => {
    // Uma linha de OUTRA conversa com o mesmo id não é apagada (o escopo da
    // limpeza é a conversa). O unique recusa de novo; a mensagem já saiu, então
    // o desfecho é o do watchdog: `sent`, sem o id.
    wahaRespondendo(BARE);
    const { supabase, messages } = dubleCom([
      ecoDoWebhook({ id: 'outro-1', conversation_id: OUTRA_CONV, external_id: BARE }),
    ]);

    await sendMessageHandler(supabase, ctx, input);

    const doEnvio = messages.find((m) => m.sent_via === 'user')!;
    expect(doEnvio.status, 'a mensagem que saiu ficou presa em queued').toBe('sent');
    expect(doEnvio.external_id).toBeNull();
    expect(messages.find((m) => m.id === 'outro-1')).toBeDefined();
  });
});
