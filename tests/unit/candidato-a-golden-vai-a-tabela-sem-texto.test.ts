/**
 * O CANDIDATO AO GOLDEN SET VAI PARA A TABELA — E NÃO LEVA O TEXTO DO CLIENTE.
 *
 * Dois caminhos gravavam candidato para curadoria humana em
 * `GOLDEN_CANDIDATES_DIR` (`recordSkillMissCandidates`, o near-miss do matcher
 * de skills, e `recordStageDivergenceCandidate`, a divergência
 * classificador×modelo): um JSON no disco. Medido na issue #1695, contra uma
 * instalação fresca — no desenvolvimento a pasta fica DENTRO do repositório e o
 * arquivo sai como `??` no `git status`; em produção o JSON vai para o disco do
 * contêiner, onde nenhuma tela o lê, ele se perde a cada atualização da imagem e
 * a cascata de anonimização da LGPD alcança o banco, não o disco.
 *
 * O que este teste prova, depois da migration 0428:
 *
 *   1. a gravação é um INSERT em `public.golden_candidates` — a linha tem OS
 *      PONTEIROS (`organization_id`, `lead_id`, `job_id`) e rótulo, nunca o
 *      sinal do turno;
 *   2. nenhum dos DOIS caminhos manda texto de cliente ao banco (nem a log — o
 *      log leva só contagem/nomes, regra dura 8);
 *   3. `on conflict do nothing`: o retry de um job regrava o MESMO candidato,
 *      que era o que o "um arquivo por candidato" do tempo em disco garantia;
 *   4. o gravador NÃO lança: candidato é telemetria de curadoria e não pode
 *      derrubar o atendimento.
 *
 * O texto abaixo é INVENTADO — conversa de cliente não entra no repo.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { recordStageDivergenceCandidate } from '@/lib/agent-engine/agent/stage-classifier';
import { recordSkillMissCandidates } from '@/lib/agent-engine/agent/skills';
import type { Logger } from '@/lib/agent-engine/obs/logger';
import type { Queryable } from '@/lib/agent-engine/queue/queue';

/** Texto de cliente INVENTADO, com os três dados que o redator tira. */
const TEXTO_DO_CLIENTE =
  'Bom dia! Vocês fazem clareamento? Quanto custa? Me chama no (11) 98765-4321 ' +
  'ou no ana.souza@exemplo.com, meu cpf é 123.456.789-09.';

const CPF = '123.456.789-09';
const TELEFONE = '98765-4321';
const EMAIL = 'ana.souza@exemplo.com';
const CORPO = 'clareamento';

const ORG = '0b1f7a2e-0000-4000-8000-000000000002';
const LEAD = '0b1f7a2e-0000-4000-8000-000000000003';
const JOB = '9f1b0c2e-0000-4000-8000-000000000001';

const silencioso = (): Logger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;

/** Um "banco" que só anota o que recebeu — e pode ser mandado a falhar. */
function banco(opcoes: { falha?: Error } = {}): {
  db: Queryable;
  linhas: Array<{ sql: string; params: unknown[] }>;
} {
  const linhas: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, values?: unknown[]) {
      if (opcoes.falha) throw opcoes.falha;
      linhas.push({ sql, params: values ?? [] });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Queryable;
  return { db, linhas };
}

/** O que NENHUMA linha pode carregar: o texto do cliente, nem mesmo redigido. */
function semTextoDoCliente(...pedacos: unknown[]): void {
  const tudo = JSON.stringify(pedacos);
  expect(tudo).not.toContain(CPF);
  expect(tudo).not.toContain(TELEFONE);
  expect(tudo).not.toContain(EMAIL);
  expect(tudo).not.toContain(CORPO);
  expect(tudo).not.toContain(TEXTO_DO_CLIENTE);
}

describe('candidato ao golden set vira linha de rótulo', () => {
  it('near-miss de skill: uma linha por candidato, com ponteiros e rótulo', async () => {
    const { db, linhas } = banco();
    const log = silencioso();

    await recordSkillMissCandidates(
      db,
      {
        tenantId: ORG,
        leadId: LEAD,
        jobId: JOB,
        candidates: [
          { skill: 'objecao-preco', reason: 'probe_matched_without_hard_match' },
          { skill: 'reativacao-d30', reason: 'probe_matched_without_hard_match' },
        ],
      },
      log,
    );

    expect(linhas).toHaveLength(2);
    for (const linha of linhas) {
      expect(linha.sql).toMatch(/insert into public\.golden_candidates/);
      expect(linha.sql).toContain("'skill_match_miss'");
      expect(linha.sql).toContain('on conflict do nothing');
      expect(linha.params.slice(0, 3)).toEqual([ORG, LEAD, JOB]);
    }
    expect(linhas[0]!.params.slice(3)).toEqual([
      'objecao-preco',
      'probe_matched_without_hard_match',
    ]);
    expect(linhas[1]!.params.slice(3)).toEqual([
      'reativacao-d30',
      'probe_matched_without_hard_match',
    ]);
    // o texto do turno nem entra na chamada — o sinal saiu da assinatura
    semTextoDoCliente(linhas);
    // e o log segue sem ele (regra dura 8): só contagem e nomes de skill
    expect(log.info).toHaveBeenCalledWith(
      'candidatos ao golden set registrados (skill match miss)',
      expect.objectContaining({ count: 2 }),
    );
    for (const [, args] of (log.info as ReturnType<typeof vi.fn>).mock.calls) {
      semTextoDoCliente(args);
    }
  });

  it('divergência de estágio: uma linha com os dois rótulos e os ponteiros', async () => {
    const { db, linhas } = banco();
    const log = silencioso();

    await recordStageDivergenceCandidate(
      db,
      {
        tenantId: ORG,
        leadId: LEAD,
        jobId: JOB,
        divergence: { suggested: 'qualifying', confirmed: 'contacted' },
      },
      log,
    );

    expect(linhas).toHaveLength(1);
    const [linha] = linhas;
    expect(linha!.sql).toMatch(/insert into public\.golden_candidates/);
    expect(linha!.sql).toContain("'stage_classifier_divergence'");
    expect(linha!.sql).toContain('on conflict do nothing');
    expect(linha!.params).toEqual([
      ORG,
      LEAD,
      JOB,
      'qualifying',
      'contacted',
    ]);
    semTextoDoCliente(linha!.sql, linha!.params);
    expect(log.info).toHaveBeenCalledWith(
      'candidato ao golden set registrado (divergência de estágio classificador×modelo)',
      { suggested: 'qualifying', confirmed: 'contacted' },
    );
  });

  it('sem candidato não há linha nenhuma (nenhuma ida ao banco)', async () => {
    const { db, linhas } = banco();
    await recordSkillMissCandidates(
      db,
      { tenantId: ORG, leadId: LEAD, jobId: JOB, candidates: [] },
      silencioso(),
    );
    expect(linhas).toHaveLength(0);
  });

  it('banco fora do ar: o candidato se perde, o turno não', async () => {
    const { db } = banco({ falha: new Error('connection refused') });
    const log = silencioso();

    await expect(
      recordSkillMissCandidates(
        db,
        {
          tenantId: ORG,
          leadId: LEAD,
          jobId: JOB,
          candidates: [{ skill: 'objecao-preco', reason: 'probe_matched_without_hard_match' }],
        },
        log,
      ),
    ).resolves.toBeUndefined();
    await expect(
      recordStageDivergenceCandidate(
        db,
        {
          tenantId: ORG,
          leadId: LEAD,
          jobId: JOB,
          divergence: { suggested: 'qualifying', confirmed: 'contacted' },
        },
        log,
      ),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
    for (const [, args] of (log.warn as ReturnType<typeof vi.fn>).mock.calls) {
      semTextoDoCliente(args);
    }
  });

  it('o sinal do turno saiu da assinatura dos DOIS gravadores', () => {
    // Varredura de fonte: re-adicionar `signal`/`scrubMessage` aqui seria voltar
    // a copiar texto de cliente para fora da cascata — o defeito da #1695.
    const raiz = process.cwd();
    const fontes = [
      path.join(raiz, 'lib/agent-engine/agent/skills.ts'),
      path.join(raiz, 'lib/agent-engine/agent/stage-classifier.ts'),
    ];
    for (const arquivo of fontes) {
      const codigo = readFileSync(arquivo, 'utf8');
      const inicio = codigo.indexOf('export async function record');
      expect(inicio, `gravador não encontrado em ${arquivo}`).toBeGreaterThan(0);
      const corpo = codigo.slice(inicio);
      expect(corpo).not.toMatch(/\bsignal\b/);
      expect(corpo).not.toMatch(/scrubMessage\(/);
      expect(corpo).not.toMatch(/writeFile|mkdir\(/);
      expect(corpo).toContain('golden_candidates');
    }
  });
});
