import type { EventHandler } from '@/lib/event-log/dispatcher';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { origemDoDreno } from '@/lib/event-log/origem-do-dreno';
import { criarPacingDoCanal } from '@/lib/agent-engine/pacing/ledger-supabase';
import { createSupabaseAvisoDb } from './aviso-ao-suporte';
import { criarTransporteDoAviso } from './aviso-ao-suporte.handler';
import {
  aplicaAvisoHandoff, criarPersistenciaAvisoHandoff, EVENTO_AVISO_HANDOFF,
  HANDLER_AVISO_HANDOFF,
} from './aviso-de-handoff';

export const avisoDeHandoffHandler: EventHandler = {
  key: HANDLER_AVISO_HANDOFF,
  events: [EVENTO_AVISO_HANDOFF],
  naOrgParada: 'pula',
  async handle(row) {
    try {
      const admin = createAdminClient();
      return await aplicaAvisoHandoff({
        ...criarPersistenciaAvisoHandoff(admin),
        db: createSupabaseAvisoDb(admin),
        transporte: await criarTransporteDoAviso(admin),
        pacing: await criarPacingDoCanal(admin),
        clock: () => new Date(), urlPublica: env.NEXT_PUBLIC_APP_URL, origemDoDreno,
      }, row);
    } catch {
      // Sem motivo livre, telefone ou detalhe de provedor nos logs do evento.
      return { consumer_key: HANDLER_AVISO_HANDOFF, status: 'error', detail: 'aviso_handoff_falha_persistencia' };
    }
  },
};