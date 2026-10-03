import { describe, expect, it, vi } from 'vitest';

import { MIRROR_WARN_ONLY, mirrorLeadStageToCrm } from './move-lead-stage';

const cfg = { supabase: {} as never };
const db = {} as never;

describe('mirrorLeadStageToCrm', () => {
  it('move o card quando o pipeline declara destino para o passo', async () => {
    const sync = vi.fn().mockResolvedValue({
      moveu: true, motivo: 'movido', leadId: 'lead-1', stageName: 'Negociação',
    });

    const r = await mirrorLeadStageToCrm(
      db, cfg as never,
      { tenantId: 'org-1', leadId: 'contato-1', toStage: 'negotiating' },
      { sync },
    );

    expect(r).toEqual({ ok: true });
    // O `leadId` do engine É o contact_id do CRM — trocar isso move o card errado.
    expect(sync).toHaveBeenCalledWith(cfg.supabase, {
      organizationId: 'org-1', contactId: 'contato-1', passo: 'negotiating',
    });
  });

  it('respeita os funis da versão publicada — sem funil autorizado o card não se move', async () => {
    const sync = vi.fn().mockResolvedValue({
      moveu: false, motivo: 'fora_do_escopo', detalhe: 'nenhum funil liberado para este assistente',
    });

    const r = await mirrorLeadStageToCrm(
      db, cfg as never,
      { tenantId: 'org-1', leadId: 'contato-1', toStage: 'qualified', pipelineIds: [] },
      { sync },
    );

    expect(sync).toHaveBeenCalledWith(cfg.supabase, {
      organizationId: 'org-1', contactId: 'contato-1', passo: 'qualified', escopoDeFunis: [],
    });
    expect(r).toMatchObject({ ok: false, reason: 'fora_do_escopo' });
  });

  it('leva ao sincronizador somente os funis que o agente publicado pode alterar', async () => {
    const sync = vi.fn().mockResolvedValue({ moveu: true, motivo: 'movido' });

    const r = await mirrorLeadStageToCrm(
      db, cfg as never,
      { tenantId: 'org-1', leadId: 'contato-1', toStage: 'qualified', pipelineIds: ['funil-comercial'] },
      { sync },
    );

    expect(r).toEqual({ ok: true });
    expect(sync).toHaveBeenCalledWith(cfg.supabase, {
      organizationId: 'org-1', contactId: 'contato-1', passo: 'qualified',
      escopoDeFunis: ['funil-comercial'],
    });
  });

  it('estágio já ocupado é sucesso, não falha', async () => {
    const sync = vi.fn().mockResolvedValue({ moveu: false, motivo: 'ja_esta_la' });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toEqual({ ok: true });
  });

  it.each(['sem_mapeamento', 'sem_negocio', 'ambiguo'])(
    'motivo %s vira not_configured (warn-only, sem item de inbox)',
    async (motivo) => {
      const sync = vi.fn().mockResolvedValue({ moveu: false, motivo });
      const r = await mirrorLeadStageToCrm(
        db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'qualified' }, { sync },
      );
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ reason: 'not_configured' });
    },
  );

  it('banco fora vira crm_unavailable — indisponibilidade NÃO pode virar estado normal', async () => {
    // O defeito que este teste fixa: o supabase-js não lança em falha de rede,
    // então o motor devolvia "sem_negocio" e o card parado parecia rotina.
    const sync = vi.fn().mockResolvedValue({
      moveu: false, motivo: 'indisponivel', detalhe: 'TypeError: fetch failed',
    });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_unavailable' });
    expect(MIRROR_WARN_ONLY.has('crm_unavailable')).toBe(false); // abre inbox
  });

  it('falha de escrita vira crm_error, nunca sucesso', async () => {
    const sync = vi.fn().mockResolvedValue({
      moveu: false, motivo: 'falha_de_escrita', detalhe: 'deadlock detected',
    });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_error' });
    expect(MIRROR_WARN_ONLY.has('crm_error')).toBe(false); // abre inbox
  });

  it('humano moveu o card antes: rótulo próprio, warn-only (sem inbox) e não é not_configured', async () => {
    const sync = vi.fn().mockResolvedValue({ moveu: false, motivo: 'conflito_humano' });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'human_conflict' });
    expect(MIRROR_WARN_ONLY.has('human_conflict')).toBe(true); // sem ruído de inbox
  });

  it('motivo desconhecido não vira warn-only silencioso', async () => {
    const sync = vi.fn().mockResolvedValue({ moveu: false, motivo: 'inventado' });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_error' });
  });

  it('erro da sincronização vira crm_error e NUNCA lança', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('supabase fora'));
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_error' });
  });
});
