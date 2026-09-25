import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { TIPOS_DERIVAVEIS } from '@/lib/messaging/media/derivable';

import { drainTick } from './drain';

const knobs = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 60000 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const event = {
  id: 'e1', organization_id: 'org1', attempts: 1,
  payload: {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    channel_session_id: '33333333-3333-4333-8333-333333333333',
    inbound_message_id: '44444444-4444-4444-8444-444444444444',
  },
};

it('org em ai_dispatch_mode=external: evento vira done SEM enfileirar job', async () => {
  const calls: string[] = [];
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [event] };            // claim
    if (sql.includes("ai_dispatch_mode")) return { rows: [{ mode: 'external' }] }; // guard
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    return { rows: [] };                                                      // reaper / done
  });
  await drainTick({ query } as unknown as pg.Pool, knobs, log);
  // o guard TEM que consultar o modo (garante FAIL antes da implementação)...
  expect(calls.some((s) => s.includes('ai_dispatch_mode'))).toBe(true);
  // ...e nenhum job pode ser enfileirado (enqueueJob nunca roda).
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

/**
 * Áudio: o turno não pode ser despachado antes de a transcrição existir.
 *
 * Defeito de origem, medido em VPS: o dispatch saía no mesmo instante em que a
 * mensagem chegava (20:24:22) e a derivação da mídia só era pedida depois
 * (20:25:03). O cliente recebia "recebi seu áudio, mas não consigo ouvi-lo"
 * segundos ANTES de a transcrição ficar pronta.
 */
const eventoDeAudio = (criadoHaMs: number) => ({
  ...event,
  created_at: new Date(Date.now() - criadoHaMs).toISOString(),
});

function poolFalso(
  msgRow: { type: string; media_derived_status: string | null; quando?: string },
  calls: string[],
  capacidade: { tem_agente: boolean; tem_roteador: boolean } = { tem_agente: true, tem_roteador: false },
) {
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [eventoDeAudio(Number(process.env.__ESPERA__ ?? 0))] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [capacidade] };
    // A consulta real filtra por TIPOS_DERIVAVEIS — linha de texto não entra. O
    // falso banco precisa recusá-la também, senão devolveria um texto para uma
    // pergunta que o Postgres nunca responderia, e o teste passaria por engano.
    //
    // A idade da mídia acompanha a do evento nos testes: o caso medido é o do
    // LOTE (foto + texto chegando juntos), onde as duas têm a mesma idade.
    if (sql.includes('media_derived_status')) {
      if (!TIPOS_DERIVAVEIS.has(msgRow.type)) return { rows: [] };
      const quando =
        msgRow.quando ?? new Date(Date.now() - Number(process.env.__ESPERA__ ?? 0)).toISOString();
      return { rows: [{ ...msgRow, quando }] };
    }
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

it('áudio ainda sem transcrição: turno é ADIADO, sem enfileirar job', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '1000'; // chegou há 1s — dentro do teto
  await drainTick(poolFalso({ type: 'audio', media_derived_status: null }, calls), knobs, log);
  expect(calls.some((s) => s.includes('media_derived_status'))).toBe(true);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'pending'") && s.includes('next_attempt_at'))).toBe(true);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(false);
});

it('áudio JÁ transcrito: turno segue normalmente', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '1000';
  await drainTick(poolFalso({ type: 'audio', media_derived_status: 'ready' }, calls), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it('derivação travada além do teto: segue SEM o texto em vez de deixar o cliente esperando', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '150000'; // 150s — muito além do teto de 120s
  await drainTick(poolFalso({ type: 'audio', media_derived_status: null }, calls), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

/**
 * O caso que a espera antiga perdia: FOTO + TEXTO em mensagens separadas.
 *
 * O cliente manda o comprovante e escreve "já paguei, e vocês estão me
 * cobrando". A evidência e a alegação chegam em DUAS mensagens, e o turno
 * dispara pela segunda (texto, não derivável). Enquanto a espera olhava só a
 * mensagem que disparou o evento, o turno seguia sem a visão da foto e o agente
 * respondia "me conta o que você mandou" sobre um comprovante que o próprio
 * sistema tinha acabado de ler.
 *
 * Medido em VPS, 24/09/2026: foto 13:28:16 · texto 13:28:19 · turno enfileirado
 * 13:28:28 · derivação concluída 13:28:35.
 */
it('foto + pergunta em texto: a espera da mídia olha a CONVERSA, não o id do evento', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '1000';
  // A mídia pendente é a FOTO; o evento veio do TEXTO que chegou depois dela.
  await drainTick(poolFalso({ type: 'image', media_derived_status: null }, calls), knobs, log);

  const consultaDeMidia = calls.find(
    (s) => s.includes('media_derived_status') && s.includes('conversation_id'),
  );
  expect(consultaDeMidia, 'a espera precisa consultar a conversa').toBeDefined();
  // O recorte por id de mensagem era o defeito: ele ignora a foto que chegou
  // antes do texto que disparou o evento.
  expect(consultaDeMidia).not.toMatch(/and\s+id\s*=\s*\$/);
  // E o turno é ADIADO — a foto ainda está virando texto.
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'pending'"))).toBe(true);
});

/**
 * A idade da mídia é contada de quando ela CHEGOU A NÓS (`created_at`), não do
 * relógio do aparelho (`sent_at` = timestamp do WhatsApp no inbound). Foto
 * entregue com atraso — aparelho offline, canal reconectando — tem `sent_at`
 * antigo e nasceria "além do teto": o turno seguiria sem esperar a leitura.
 *
 * E mídia sem `media_url` nunca entra na esteira (sem ela o
 * `media.persist_requested` não é emitido): esperar por ela só atrasa o texto.
 */
it('espera da mídia: âncora é created_at (não sent_at) e só conta mídia com media_url', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '1000';
  await drainTick(poolFalso({ type: 'image', media_derived_status: null }, calls), knobs, log);
  const consultaDeMidia = calls.find((s) => s.includes('media_derived_status')) ?? '';
  expect(consultaDeMidia).toMatch(/created_at\s+as\s+quando/);
  expect(consultaDeMidia).not.toMatch(/sent_at/);
  expect(consultaDeMidia).toMatch(/media_url\s+is\s+not\s+null/);
});

/**
 * Mídia que o worker PULA de propósito (vídeo com leitura desligada — o padrão)
 * é gravada como `skipped` e não segura o turno. Antes ficava null para sempre,
 * e "vídeo + texto" atrasava a resposta do texto até o teto de 120s.
 */
it('mídia skipped (vídeo com leitura desligada): turno segue sem esperar', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '1000';
  await drainTick(poolFalso({ type: 'video', media_derived_status: 'skipped' }, calls), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

/**
 * Catraca do teto (issue #543): 90s é o valor que o #530 teve de abandonar.
 *
 * O PR #530 subiu o teto de 45s para 120s, mas os dois casos que exercitam o
 * teto usavam 1s (adia) e 150s (segue) — NENHUM caía entre 45s e 120s, a única
 * janela onde o comportamento mudou. Medido na triagem do #530: reverter o teto
 * para 45_000 mantendo todo o resto dava 0 vermelhos, a suíte inteira verde.
 *
 * 90s cai dentro da janela: com o teto em 120s o turno é adiado; revertido para
 * 45s, ele segue — e este caso fica vermelho. Junto com o caso de 150s, o teto
 * fica preso em (90s, 150s]: abaixo dele o cliente volta a receber "não consegui
 * ouvir seu áudio" com a transcrição chegando segundos depois (o defeito do
 * Alfran), acima dele o cliente espera minutos.
 */
it('áudio esperando 90s (janela 45s–120s do #530): turno segue ADIADO, não despachado sem o texto', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '90000'; // 90s — dentro do teto de 120s e fora do antigo de 45s
  await drainTick(poolFalso({ type: 'audio', media_derived_status: null }, calls), knobs, log);
  expect(calls.some((s) => s.includes('media_derived_status'))).toBe(true);
  // Nada de job: a resposta não sai antes de o texto derivado existir.
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  // Adiar não é falha: volta a 'pending' com espera curta, sem gastar tentativa.
  expect(calls.some((s) => s.includes("status = 'pending'") && s.includes('next_attempt_at'))).toBe(true);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(false);
});

it('mensagem de texto não espera nada', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '0';
  await drainTick(poolFalso({ type: 'text', media_derived_status: null }, calls), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

/**
 * Coalescência não pode considerar job em HOLD (`held_run_after` no payload).
 *
 * `run_after > now()` sozinho casa com um job em hold — `enforceHolds`
 * (session-watchdog.ts) usa `run_after = 'infinity'` como marcador, e
 * 'infinity' É maior que `now()`. Um hold por sessão MORTA (WhatsApp
 * reconectado, sessão antiga arquivada) nunca libera — a condição de release
 * exige a MESMA sessão antiga voltar a 'WORKING'. Sem esta exclusão, toda
 * mensagem nova do mesmo contato — inclusive numa sessão NOVA — coalescia
 * nesse job morto para sempre: o evento saía "done", sem erro, e nenhum
 * turno rodava. Medido em produção (2026-09-14): 6 mensagens em 7h, zero
 * resposta.
 */
it('coalescência exclui job em hold (held_run_after) — sessão morta não sequestra mensagem nova', async () => {
  process.env.__ESPERA__ = '0';
  const debounceKnobs = { ...knobs, debounceMs: 500 };
  const calls: string[] = [];
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [eventoDeAudio(0)] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes('media_derived_status')) return { rows: [{ type: 'text', media_derived_status: null }] };
    // A coalescência real (com o predicado corrigido) não encontra nada — o
    // único job pendente do contato está em hold e a query já o exclui.
    if (sql.includes('select id from job_queue')) return { rows: [] };
    if (sql.includes('insert into job_queue')) return { rows: [{ id: 'job-novo' }] };
    return { rows: [] };
  });
  await drainTick({ query } as unknown as pg.Pool, debounceKnobs, log);

  const coalescencia = calls.find((s) => s.includes('select id from job_queue'));
  expect(coalescencia, 'a query de coalescência deveria ter rodado').toBeTruthy();
  expect(coalescencia).toContain('held_run_after');
  // Sem o job em hold como falso-positivo, o turno segue e enfileira um job novo.
  expect(calls.some((s) => s.includes('insert into job_queue'))).toBe(true);
});


/**
 * Agente pausado não pode custar dinheiro.
 *
 * Medido em VPS com o agente despublicado pela tela: UMA mensagem rodou o
 * pipeline inteiro — 6 chamadas ao LLM, ~2 centavos — e ainda produziu
 * resposta. "Pausei o agente" tem que significar "parou de gastar".
 */
const textoSimples = { type: 'text', media_derived_status: null };

it('sem agente publicado e sem roteador: turno pulado ANTES de qualquer gasto', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '0';
  await drainTick(
    poolFalso(textoSimples, calls, { tem_agente: false, tem_roteador: false }),
    knobs, log,
  );
  expect(calls.some((s) => s.includes('tem_agente'))).toBe(true);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

it('com agente publicado: turno segue', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '0';
  await drainTick(
    poolFalso(textoSimples, calls, { tem_agente: true, tem_roteador: false }),
    knobs, log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it('sem agente MAS com roteador que resolve alguém: turno segue (caminho genérico preservado)', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '0';
  await drainTick(
    poolFalso(textoSimples, calls, { tem_agente: false, tem_roteador: true }),
    knobs, log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

/**
 * Anti-backlog + gate de elegibilidade (migration 0203).
 *
 * `poolElegibilidade` estende o pool falso com as duas consultas novas: a de
 * supersessão (última inbound da conversa) e a de elegibilidade (gate do canal
 * + travas do contato).
 */
function poolElegibilidade(
  calls: string[],
  opts: {
    ultimaInboundId?: string;
    aiGate?: string | null;
    aiGateMode?: string | null;
    aiTestPhoneNumbers?: string[];
    phoneNumber?: string | null;
    aiAuthorizedAt?: string | null;
    forceHuman?: boolean;
    assigneeKind?: string | null;
  } = {},
) {
  const inboundId = '44444444-4444-4444-8444-444444444444';
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [{ ...event, created_at: new Date().toISOString() }] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes("direction = 'inbound'")) {
      return { rows: [{ id: opts.ultimaInboundId ?? inboundId }] };
    }
    if (sql.includes('channel_metadata')) {
      return {
        rows: [
          {
            channel_metadata: {
              ai_gate: opts.aiGate ?? null,
              ai_gate_mode: opts.aiGateMode ?? null,
              ai_test_phone_numbers: opts.aiTestPhoneNumbers ?? [],
            },
            force_human: opts.forceHuman ?? false,
            assignee_kind: opts.assigneeKind ?? 'ai',
            bot_silenced_until: null,
            ai_authorized_at: opts.aiAuthorizedAt ?? null,
            phone_number: opts.phoneNumber ?? null,
          },
        ],
      };
    }
    if (sql.includes('media_derived_status')) return { rows: [{ type: 'text', media_derived_status: null }] };
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

it('evento superado por inbound mais recente: turno pulado, sem job, sem gasto', async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls, { ultimaInboundId: 'outra-mensagem-mais-nova' }), knobs, log);
  expect(calls.some((s) => s.includes("direction = 'inbound'"))).toBe(true);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

it("gate 'allowlist' + contato NÃO autorizado: turno pulado, sem job, sem gasto", async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls, { aiGate: 'allowlist', aiAuthorizedAt: null }), knobs, log);
  expect(calls.some((s) => s.includes('channel_metadata'))).toBe(true);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

it("pré-go-live: número de teste segue e contato autorizado fora da lista para", async () => {
  const callsPermitido: string[] = [];
  await drainTick(
    poolElegibilidade(callsPermitido, {
      aiGate: 'allowlist',
      aiGateMode: 'pre_go_live',
      aiTestPhoneNumbers: ['+5585987654321'],
      phoneNumber: '+5585987654321',
    }),
    knobs,
    log,
  );
  expect(callsPermitido.some((s) => s.includes('job_queue'))).toBe(true);

  const callsBloqueado: string[] = [];
  await drainTick(
    poolElegibilidade(callsBloqueado, {
      aiGate: 'allowlist',
      aiGateMode: 'pre_go_live',
      aiTestPhoneNumbers: ['+5585987654321'],
      phoneNumber: '+5585987654000',
      aiAuthorizedAt: new Date().toISOString(),
    }),
    knobs,
    log,
  );
  expect(callsBloqueado.some((s) => s.includes('job_queue'))).toBe(false);
});

it("gate 'allowlist' + contato autorizado agora: turno segue", async () => {
  const calls: string[] = [];
  await drainTick(
    poolElegibilidade(calls, { aiGate: 'allowlist', aiAuthorizedAt: new Date().toISOString() }),
    { ...knobs, allowlistTtlMs: 21 * 24 * 60 * 60 * 1000 },
    log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it("gate 'allowlist' + autorização EXPIRADA (fora do TTL): turno pulado", async () => {
  const calls: string[] = [];
  const antiga = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  await drainTick(
    poolElegibilidade(calls, { aiGate: 'allowlist', aiAuthorizedAt: antiga }),
    { ...knobs, allowlistTtlMs: 21 * 24 * 60 * 60 * 1000 },
    log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

it("gate 'open' (default): contato sem autorização NÃO é barrado — comportamento de hoje", async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls, { aiGate: null, aiAuthorizedAt: null }), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it("gate 'allowlist' + force_human: turno pulado mesmo com autorização", async () => {
  const calls: string[] = [];
  await drainTick(
    poolElegibilidade(calls, {
      aiGate: 'allowlist',
      aiAuthorizedAt: new Date().toISOString(),
      forceHuman: true,
    }),
    knobs,
    log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
});

/**
 * R7 — a consulta da "última inbound" (anti-backlog) desempata por recência
 * REAL, nunca por `id` (uuid aleatório). `order by sent_at desc nulls last, id
 * desc` elegia a mensagem ANTIGA por sorteio quando dois inbound tinham o mesmo
 * `sent_at`. A cerca guarda a cláusula seguindo o padrão do repo (migration
 * 0027): `coalesce(sent_at, created_at)`.
 */
it("anti-backlog: ordena a última inbound por coalesce(sent_at, created_at), não por id sozinho", async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls), knobs, log);
  const consultaUltima = calls.find((s) => s.includes("direction = 'inbound'"));
  expect(consultaUltima).toBeDefined();
  expect(consultaUltima).toContain('coalesce(sent_at, created_at) desc');
  expect(consultaUltima).not.toContain('nulls last');
});
