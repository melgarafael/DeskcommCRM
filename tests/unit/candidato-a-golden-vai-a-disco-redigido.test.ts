/**
 * O CANDIDATO AO GOLDEN SET NÃO GUARDA O TEXTO DO CLIENTE COMO ELE CHEGOU.
 *
 * Dois caminhos gravam candidato para curadoria humana em `GOLDEN_CANDIDATES_DIR`
 * (fs em runtime, não a tool Write): o near-miss do matcher de skills
 * (`recordSkillMissCandidates`) e a divergência classificador×modelo
 * (`recordStageDivergenceCandidate`). O que sai é registro de dado do titular no
 * disco do contêiner — fora do banco, e a cascata de anonimização da LGPD alcança
 * o banco, não o disco.
 *
 * A régua é o `scrubMessage` (`lib/sentry/scrub.ts`), o MESMO redator da
 * telemetria e do Jev: apaga CPF, telefone, e-mail e chave de API, e preserva o
 * resto — o corpo da mensagem é o que a curadoria humana lê. O que este teste
 * NÃO prova é anonimização: o corpo continua no arquivo, e o `lead_id` ao lado
 * dele liga o registro ao contato. Tirar o texto daqui (tabela + retenção ou
 * cascata) é o conserto inteiro, e não cabe neste caminho.
 *
 * O texto abaixo é INVENTADO — conversa de cliente não entra no repo.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { recordStageDivergenceCandidate } from '@/lib/agent-engine/agent/stage-classifier';
import { recordSkillMissCandidates } from '@/lib/agent-engine/agent/skills';
import type { Logger } from '@/lib/agent-engine/obs/logger';
import { scrubMessage } from '@/lib/sentry/scrub';

/** Texto de cliente INVENTADO, com os três dados que o redator tira. */
const TEXTO_DO_CLIENTE =
  'Bom dia! Vocês fazem clareamento? Quanto custa? Me chama no (11) 98765-4321 ' +
  'ou no ana.souza@exemplo.com, meu cpf é 123.456.789-09.';

const CPF = '123.456.789-09';
const TELEFONE = '98765-4321';
const EMAIL = 'ana.souza@exemplo.com';

const jobId = '9f1b0c2e-0000-4000-8000-000000000001';

const silencioso = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

/** Um diretório novo por caso: nada é escrito no golden-candidates do repo (freeze do tree). */
function dirTemporario(): string {
  return mkdtempSync(path.join(tmpdir(), 'candidato-golden-'));
}

/** Lê o ÚNICO candidato gravado — o nome do arquivo diz de qual dos dois caminhos ele veio. */
function lerCandidato(dir: string): { arquivo: string; signal: string } {
  const arquivos = readdirSync(dir);
  expect(arquivos).toHaveLength(1);
  const arquivo = arquivos[0]!;
  const registro = JSON.parse(readFileSync(path.join(dir, arquivo), 'utf8')) as { signal: string };
  return { arquivo, signal: registro.signal };
}

/** O que o candidato NÃO pode carregar, em qualquer dos dois caminhos. */
function semDadoDireto(signal: string): void {
  expect(signal).not.toContain(CPF);
  expect(signal).not.toContain(TELEFONE);
  expect(signal).not.toContain(EMAIL);
  // e o sinal que a curadoria lê segue legível — o redator não é um truncador
  expect(signal).toContain('clareamento');
  expect(signal).toContain('Quanto custa');
}

describe('candidato ao golden set vai a disco redigido', () => {
  it('near-miss de skill: o sinal gravado é o scrubMessage do repo', async () => {
    const dir = dirTemporario();
    await recordSkillMissCandidates(
      dir,
      {
        tenantId: '0b1f7a2e-0000-4000-8000-000000000002',
        leadId: '0b1f7a2e-0000-4000-8000-000000000003',
        jobId,
        signal: TEXTO_DO_CLIENTE,
        candidates: [{ skill: 'objecao-preco', reason: 'probe_matched_without_hard_match' }],
      },
      silencioso,
    );

    const { arquivo, signal } = lerCandidato(dir);
    expect(arquivo.startsWith('skill-miss_objecao-preco_')).toBe(true);
    // valor exato: o mesmo que o redator da telemetria devolve para este texto
    expect(signal).toBe(scrubMessage(TEXTO_DO_CLIENTE));
    semDadoDireto(signal);
  });

  it('divergência de estágio: o sinal gravado é o scrubMessage do repo', async () => {
    const dir = dirTemporario();
    await recordStageDivergenceCandidate(
      dir,
      {
        tenantId: '0b1f7a2e-0000-4000-8000-000000000002',
        leadId: '0b1f7a2e-0000-4000-8000-000000000003',
        jobId,
        signal: TEXTO_DO_CLIENTE,
        divergence: { suggested: 'qualifying', confirmed: 'contacted' },
      },
      silencioso,
    );

    const { arquivo, signal } = lerCandidato(dir);
    expect(arquivo).toBe(`stage-divergence_${jobId}.json`);
    expect(signal).toBe(scrubMessage(TEXTO_DO_CLIENTE));
    semDadoDireto(signal);
  });
});
