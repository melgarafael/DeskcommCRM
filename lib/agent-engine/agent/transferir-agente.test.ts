import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { classifyIntent } from './intent-classifier';
import {
  MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE,
  TransferenciaDeAgenteRecusada,
  transferirAgenteDaConversa,
} from './transferir-agente';

// O dublê do classificador existe para provar que a passagem NÃO o chama: o
// módulo da ação não importa o classificador (asserção estrutural mais abaixo),
// e se alguém "só confirmar a intenção" aqui dentro, este espião acusa.
vi.mock('./intent-classifier', () => ({ classifyIntent: vi.fn() }));

/**
 * A passagem EXPLÍCITA de um agente de IA para outro, no mesmo número (#3770).
 *
 * O que este arquivo mede:
 *  - com destino válido, a conversa fica com o agente X e a decisão entra em
 *    `ai_router_decisions` com desfecho `transferred` e `origem = 'acao'` —
 *    NUNCA `reclassified`, que é o desfecho do classificador;
 *  - destino inexistente/arquivado/sem versão publicada, de outro número, ou
 *    fora do roteador do número: erro claro e NADA escrito;
 *  - a passagem não chama classificador (dublê intacto + o módulo não importa o
 *    classificador).
 *
 * O que ele NÃO mede: o efeito no banco real (o `update` + `insert` atômico do
 * statement). Este arquivo dubla o pool; o statement é provado pelo próprio SQL
 * (uma CTE: `update … returning` alimenta o `insert`).
 */

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONVERSA = 'aaaaaaaa-1111-4000-8000-000000000001';
const SESSAO = 'aaaaaaaa-8888-4000-8000-000000000001';
const OUTRA_SESSAO = 'aaaaaaaa-8888-4000-8000-000000000002';
const AGENTE_ANTERIOR = 'aaaaaaaa-2222-4000-8000-000000000001';
const AGENTE_DESTINO = 'aaaaaaaa-2222-4000-8000-000000000002';
const ROUTER = 'aaaaaaaa-4444-4000-8000-000000000001';
const USUARIO = 'aaaaaaaa-3333-4000-8000-000000000003';

interface Escrita {
  sql: string;
  params: unknown[];
}

interface Cenario {
  conversa: { channel_session_id: string | null; active_ai_agent_id: string | null } | null;
  /** `channel_session_id` da versão publicada do destino; `null` = destino inexistente. */
  sessaoDoDestino: string | null;
  /** Roteador ativo do número: `null` = sem roteador; `intent_name: null` = não é membro. */
  roteador: { router_id: string; intent_name: string | null } | null;
  /** O `update` da CTE não casa com linha (conversa sumiu entre a leitura e a escrita). */
  updateSemLinha?: boolean;
}

function poolFake(cenario: Cenario): { db: pg.Pool; escritas: Escrita[]; leituras: string[] } {
  const escritas: Escrita[] = [];
  const leituras: string[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/insert into ai_router_decisions/i.test(sql)) {
        escritas.push({ sql, params });
        return { rows: [], rowCount: cenario.updateSemLinha === true ? 0 : 1 };
      }
      if (/from conversations\s+where organization_id = \$1 and id = \$2/i.test(sql)) {
        leituras.push('conversa');
        return { rows: cenario.conversa === null ? [] : [cenario.conversa], rowCount: 0 };
      }
      if (/join ai_agent_versions v on v\.id = a\.published_version_id/i.test(sql)) {
        leituras.push('destino');
        return {
          rows:
            cenario.sessaoDoDestino === null
              ? []
              : [{ channel_session_id: cenario.sessaoDoDestino }],
          rowCount: 0,
        };
      }
      if (/from ai_routers r/i.test(sql)) {
        leituras.push('roteador');
        return { rows: cenario.roteador === null ? [] : [cenario.roteador], rowCount: 0 };
      }
      throw new Error(`pool dublê sem resposta para: ${sql.slice(0, 80)}`);
    },
  } as unknown as pg.Pool;
  return { db, escritas, leituras };
}

const CENARIO_OK: Cenario = {
  conversa: { channel_session_id: SESSAO, active_ai_agent_id: AGENTE_ANTERIOR },
  sessaoDoDestino: SESSAO,
  roteador: { router_id: ROUTER, intent_name: 'automacao' },
};

const ENTRADA = {
  organizationId: ORG,
  conversationId: CONVERSA,
  agenteDestinoId: AGENTE_DESTINO,
  motivo: 'pedido_do_agente' as const,
  solicitadoPor: USUARIO,
  jobId: 'job-1',
};

describe('transferirAgenteDaConversa — a passagem que não depende do classificador', () => {
  beforeEach(() => {
    vi.mocked(classifyIntent).mockClear();
  });

  it('destino válido: a conversa fica com o agente X e a decisão é registrada com origem ação', async () => {
    const p = poolFake(CENARIO_OK);
    const resultado = await transferirAgenteDaConversa(p.db, ENTRADA);

    expect(resultado).toEqual({
      agenteAnteriorId: AGENTE_ANTERIOR,
      agenteDestinoId: AGENTE_DESTINO,
      intentName: 'automacao',
      routerId: ROUTER,
    });

    // UMA escrita: o sticky e a linha de trilha na mesma CTE.
    expect(p.escritas).toHaveLength(1);
    const { sql, params } = p.escritas[0]!;
    expect(sql).toMatch(/update conversations/i);
    expect(sql).toMatch(/set active_ai_agent_id = \$3/i);
    expect(sql).toMatch(/insert into ai_router_decisions/i);
    // A decisão é AÇÃO, não reclassificação.
    expect(sql).toContain("'transferred'");
    expect(sql).toContain("'acao'");
    expect(sql).not.toContain("'reclassified'");
    expect(params).toEqual([
      ORG,
      CONVERSA,
      AGENTE_DESTINO,
      'automacao',
      ROUTER,
      'job-1',
      AGENTE_ANTERIOR,
      'pedido_do_agente',
      USUARIO,
    ]);
  });

  it('a trilha registra de quem para quem, quando, quem pediu e o motivo (sem texto livre)', async () => {
    const p = poolFake(CENARIO_OK);
    await transferirAgenteDaConversa(p.db, { ...ENTRADA, solicitadoPor: null });

    const { sql, params } = p.escritas[0]!;
    // de qual agente → para qual agente
    expect(params[6]).toBe(AGENTE_ANTERIOR);
    expect(params[2]).toBe(AGENTE_DESTINO);
    // quando → created_at do próprio registro
    expect(sql).not.toMatch(/created_at/i);
    // quem pediu / motivo
    expect(sql).toMatch(/solicitado_por/);
    expect(sql).toMatch(/motivo/);
    expect(params[8]).toBeNull();
    expect(MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE).toContain(params[7]);
  });

  it('sem roteador no número: transfere e as colunas do roteador ficam nulas', async () => {
    const p = poolFake({ ...CENARIO_OK, roteador: null });
    const resultado = await transferirAgenteDaConversa(p.db, ENTRADA);

    expect(resultado.routerId).toBeNull();
    expect(resultado.intentName).toBeNull();
    expect(p.escritas[0]!.params[4]).toBeNull();
    expect(p.escritas[0]!.params[3]).toBeNull();
  });

  it('agente inexistente (ou de outra organização): erro claro e NADA muda', async () => {
    const p = poolFake({ ...CENARIO_OK, sessaoDoDestino: null });

    await expect(transferirAgenteDaConversa(p.db, ENTRADA)).rejects.toMatchObject({
      name: 'TransferenciaDeAgenteRecusada',
      codigo: 'agente_inexistente',
    });
    await expect(transferirAgenteDaConversa(p.db, ENTRADA)).rejects.toBeInstanceOf(
      TransferenciaDeAgenteRecusada,
    );
    expect(p.escritas).toHaveLength(0);
  });

  it('agente de outro número: recusa com erro próprio e NADA muda', async () => {
    const p = poolFake({ ...CENARIO_OK, sessaoDoDestino: OUTRA_SESSAO });

    await expect(transferirAgenteDaConversa(p.db, ENTRADA)).rejects.toMatchObject({
      codigo: 'agente_de_outro_numero',
    });
    expect(p.escritas).toHaveLength(0);
  });

  it('número com roteador e destino fora dos membros: recusa e NADA muda', async () => {
    const p = poolFake({ ...CENARIO_OK, roteador: { router_id: ROUTER, intent_name: null } });

    await expect(transferirAgenteDaConversa(p.db, ENTRADA)).rejects.toMatchObject({
      codigo: 'agente_fora_do_roteador',
    });
    expect(p.escritas).toHaveLength(0);
  });

  it('conversa inexistente na organização: recusa e NADA muda', async () => {
    const p = poolFake({ ...CENARIO_OK, conversa: null });

    await expect(transferirAgenteDaConversa(p.db, ENTRADA)).rejects.toMatchObject({
      codigo: 'conversa_nao_encontrada',
    });
    expect(p.escritas).toHaveLength(0);
  });

  it('a conversa já está com o agente: recusa sem reescrever o sticky', async () => {
    const p = poolFake({
      ...CENARIO_OK,
      conversa: { channel_session_id: SESSAO, active_ai_agent_id: AGENTE_DESTINO },
    });

    await expect(transferirAgenteDaConversa(p.db, ENTRADA)).rejects.toMatchObject({
      codigo: 'ja_esta_no_agente',
    });
    expect(p.escritas).toHaveLength(0);
  });

  it('conversa que sumiu entre a leitura e a escrita: erro claro, sem trilha órfã', async () => {
    const p = poolFake({ ...CENARIO_OK, updateSemLinha: true });

    await expect(transferirAgenteDaConversa(p.db, ENTRADA)).rejects.toMatchObject({
      codigo: 'conversa_nao_encontrada',
    });
  });

  it('NÃO chama o classificador — a passagem não custa modelo nenhum', async () => {
    const p = poolFake(CENARIO_OK);
    await transferirAgenteDaConversa(p.db, ENTRADA);

    expect(classifyIntent).not.toHaveBeenCalled();
    // E não pode voltar a chamar por dentro: o módulo não usa o classificador nem
    // o resolvedor do turno (que classificaria). A asserção é sobre o
    // arquivo-fonte de propósito — é o que impede a regressão silenciosa de
    // alguém "só confirmar a intenção" aqui dentro. Casa USO (import/chamada),
    // não a menção em comentário, que é como os dois aparecem hoje.
    const fonte = readFileSync(
      path.join(process.cwd(), 'lib/agent-engine/agent/transferir-agente.ts'),
      'utf8',
    );
    expect(fonte).not.toMatch(/from '[^']*intent-classifier'/);
    expect(fonte).not.toMatch(/\bclassifyIntent\b/);
    expect(fonte).not.toMatch(/\bresolveTurnAgent\b/);
    expect(fonte).not.toMatch(/\bconsultarJevNoRoteador\b/);
  });
});
