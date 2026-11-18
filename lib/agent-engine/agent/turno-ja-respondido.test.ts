import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { respostaFicouObsoleta } from './turno-ja-respondido';

/**
 * #2797 — a REAÇÃO não descarta a resposta pronta.
 *
 * `respostaFicouObsoleta` descarta a resposta de um turno quando o cliente
 * escreveu de novo enquanto o modelo pensava, contando que a mensagem nova tem
 * turno próprio (#1940: resposta descartada tem quem responda). A reação (👍) é
 * linha `inbound` em `messages` (`type = 'reaction'`, gravada por
 * `lib/channels/reacao.ts`), mas não emite `ai_agent.dispatch_requested`: não
 * tem turno. Contada pela régua, ela descartava a resposta e ninguém respondia.
 *
 * As duas CTEs que olham as mensagens do cliente precisam excluí-la:
 *
 * - `mais_nova` — a mensagem que torna a resposta obsoleta. Reação ali
 *   descarta a resposta sem ninguém para responder depois.
 * - `pendente` — o começo do teto. Reação ali faz o teto contar de um gesto que
 *   não espera resposta, e a resposta desatualizada sai junto com a do turno da
 *   mensagem nova (a resposta dupla que a régua existe para evitar).
 *
 * Sem Postgres neste projeto, o pool falso reproduz a régua em JS e lê o corpo
 * de CADA CTE para saber se ela exclui a reação: é por isso que cada caso abaixo
 * cai sozinho quando o filtro sai de uma CTE só. A régua contra o banco real é
 * vigiada em `tests/invariants/turno-nao-responde-duas-vezes.test.ts` e
 * `tests/invariants/resposta-descartada-tem-quem-responda.test.ts`.
 */

const CTES = ['vista', 'ultima_out', 'pendente', 'mais_nova'] as const;
const EXCLUI_REACAO = /\btype\s*(?:<>|!=)\s*'reaction'/;

/** O corpo de uma CTE: do `nome as (` até a CTE seguinte ou o `select` final. */
function corpoDaCte(sql: string, nome: (typeof CTES)[number]): string {
  const inicio = sql.search(new RegExp(`\\b${nome}\\s+as\\s*\\(`));
  if (inicio < 0) throw new Error(`a régua não tem mais a CTE "${nome}" — atualize este pool falso`);
  const fins = [
    ...CTES.map((outra) => sql.slice(inicio + 1).search(new RegExp(`\\b${outra}\\s+as\\s*\\(`))),
    sql.slice(inicio + 1).search(/\)\s*select\s+coalesce\(/),
  ].filter((i) => i >= 0);
  return sql.slice(inicio, inicio + 1 + Math.min(...fins));
}

type Linha = { direction: 'inbound' | 'outbound'; type: string; created_at: number; sent_at?: number };

const JOB = '55555555-5555-4555-8555-555555555555';
const alvo = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  jobId: JOB,
};
const TETO_MS = 120_000;

function poolDaRegua(linhas: Linha[], vistaEm: number) {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    const tetoMs = Number(params[3]);
    const agora = Date.now();
    const daCte = (nome: (typeof CTES)[number]) => {
      const exclui = EXCLUI_REACAO.test(corpoDaCte(sql, nome));
      return linhas.filter((l) => l.direction === 'inbound' && !(exclui && l.type === 'reaction'));
    };

    const outs = linhas.filter((l) => l.direction === 'outbound').map((l) => l.created_at);
    const ultimaOut = outs.length > 0 ? Math.max(...outs) : null;

    const semResposta = daCte('pendente')
      .filter((l) => ultimaOut === null || l.created_at > ultimaOut)
      .map((l) => l.created_at);
    const pendente = semResposta.length > 0 ? Math.min(...semResposta) : null;

    const maisNova = [...daCte('mais_nova')].sort(
      (a, b) => (b.sent_at ?? b.created_at) - (a.sent_at ?? a.created_at) || b.created_at - a.created_at,
    )[0];

    const obsoleta =
      maisNova !== undefined && maisNova.created_at > vistaEm && pendente !== null && pendente > agora - tetoMs;
    return { rows: [{ obsoleta }] };
  });
  return { query } as unknown as Pick<pg.Pool, 'query'>;
}

const haMs = (ms: number) => Date.now() - ms;
const linha = (direction: Linha['direction'], type: string, ms: number): Linha => ({
  direction,
  type,
  created_at: haMs(ms),
  sent_at: haMs(ms),
});

describe('respostaFicouObsoleta (#2797): a reação não conta como mensagem do cliente', () => {
  it('mais_nova: texto lido e reação depois da leitura — a resposta NÃO é descartada', async () => {
    const texto = linha('inbound', 'text', 30_000);
    const linhas = [
      linha('outbound', 'text', 600_000),
      texto,
      linha('inbound', 'reaction', 5_000),
    ];
    const obsoleta = await respostaFicouObsoleta(poolDaRegua(linhas, texto.created_at), alvo, TETO_MS);
    expect(obsoleta, 'a reação descartou a resposta, e ela não tem turno que responda depois').toBe(false);
  });

  it('pendente: reação antes da pergunta — o teto conta da primeira MENSAGEM sem resposta', async () => {
    const lida = linha('inbound', 'text', 60_000);
    const linhas = [
      linha('outbound', 'text', 600_000),
      // reação à última resposta, de 5 min atrás: fora do teto de 2 min
      linha('inbound', 'reaction', 300_000),
      lida,
      // a mensagem nova, com turno próprio, chegou depois da leitura
      linha('inbound', 'text', 10_000),
    ];
    const obsoleta = await respostaFicouObsoleta(poolDaRegua(linhas, lida.created_at), alvo, TETO_MS);
    expect(obsoleta, 'o teto contou da reação e a resposta desatualizada saiu junto com a nova').toBe(true);
  });

  it('controle: uma MENSAGEM nova depois da leitura continua descartando a resposta', async () => {
    const lida = linha('inbound', 'text', 30_000);
    const linhas = [linha('outbound', 'text', 600_000), lida, linha('inbound', 'text', 5_000)];
    expect(await respostaFicouObsoleta(poolDaRegua(linhas, lida.created_at), alvo, TETO_MS)).toBe(true);
  });
});
