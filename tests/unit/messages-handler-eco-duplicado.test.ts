import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';

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
 * Fake com uma TABELA (não uma linha só): o desfecho deste caso é "quantas
 * linhas sobraram", então um fake de linha única responderia sempre 1 e o teste
 * passaria sem tocar no defeito.
 */
function makeSupabase(preexistentes: Row[] = []) {
  const messages: Row[] = [...preexistentes];

  const filtrar = (filtros: Array<(r: Row) => boolean>) => messages.filter((r) => filtros.every((f) => f(r)));

  const from = (table: string) => {
    if (table === 'conversations') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conversationRow(), error: null }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table !== 'messages') throw new Error(`fake: tabela inesperada '${table}'`);

    return {
      insert: (row: Row) => {
        const nova: Row = { id: `msg-${messages.length + 1}`, external_id: null, ack: null, error_code: null, error_message: null, ...row };
        messages.push(nova);
        return { select: () => ({ single: async () => ({ data: { ...nova }, error: null }) }) };
      },
      update: (patch: Row) => {
        const filtros: Array<(r: Row) => boolean> = [];
        const q = {
          eq(col: string, val: unknown) {
            filtros.push((r) => r[col] === val);
            return q;
          },
          select: () => ({
            maybeSingle: async () => {
              const alvos = filtrar(filtros);
              // O unique (organization_id, external_id) é a regra de banco de que
              // este desfecho depende: sem ela, gravar o id numa linha quando
              // outra já o tem passaria batido.
              const externo = patch.external_id as string | undefined;
              if (externo) {
                const colide = messages.some(
                  (r) => r.organization_id === ORG && r.external_id === externo && !alvos.includes(r),
                );
                if (colide) {
                  return { data: null, error: { code: '23505', message: 'duplicate key value violates "messages_org_external_id_unique"' } };
                }
              }
              alvos.forEach((r) => Object.assign(r, patch));
              return { data: alvos[0] ? { ...alvos[0] } : null, error: null };
            },
          }),
        };
        return q;
      },
      delete: () => {
        const filtros: Array<(r: Row) => boolean> = [];
        const q = {
          eq(col: string, val: unknown) {
            filtros.push((r) => r[col] === val);
            return q;
          },
          neq(col: string, val: unknown) {
            filtros.push((r) => r[col] !== val);
            return q;
          },
          in(col: string, vals: unknown[]) {
            filtros.push((r) => vals.includes(r[col]));
            return q;
          },
          then(resolve: (v: { error: null }) => unknown) {
            for (const alvo of filtrar(filtros)) messages.splice(messages.indexOf(alvo), 1);
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return q;
      },
    };
  };

  const client = { from, rpc: async () => ({ error: null }) };
  return { supabase: client as unknown as SupabaseClient, messages };
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
    const { supabase, messages } = makeSupabase([ecoDoWebhook()]);

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.external_id === BARE || m.external_id === COMPOSTO);
    expect(daMensagem, 'a mesma frase ficou duas vezes na conversa').toHaveLength(1);
  });

  it('a linha que sobra é a do ENVIO, com autoria — não a do webhook', async () => {
    // Qual das duas sobrevive importa: a do envio carrega `sent_by_user_id` e
    // `sent_via`, que é o que a tela usa para dizer quem falou. Ficar com a do
    // webhook apagaria a autoria.
    wahaRespondendo(BARE);
    const { supabase, messages } = makeSupabase([ecoDoWebhook()]);

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
    const { supabase, messages } = makeSupabase();

    await sendMessageHandler(supabase, ctx, input);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
    expect(messages[0]!.status).toBe('sent');
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
    const { supabase, messages } = makeSupabase([outraMensagem]);

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
    const { supabase, messages } = makeSupabase([deOutraConversa]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.find((m) => m.id === 'outro-1'), 'apagou linha de outra conversa').toBeDefined();
  });

  it('linha do CRM (não-webhook) com o mesmo id não é tocada', async () => {
    // Só o eco nasce com `sent_via: external_device`. Uma linha nossa com o
    // mesmo id seria outra coisa — e apagá-la seria perder envio de verdade.
    wahaRespondendo(BARE);
    const doCrm = ecoDoWebhook({ id: 'crm-1', sent_via: 'ai' });
    const { supabase, messages } = makeSupabase([doCrm]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.find((m) => m.id === 'crm-1'), 'apagou uma linha que não era eco de dispositivo').toBeDefined();
  });
});
