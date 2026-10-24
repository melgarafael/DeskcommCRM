import type { ContextoDoAtendimento, FonteDoAtendimento } from '../../agent/contexto-do-atendimento';
import { projetarLeiturasDeEstadoDaAgenda } from '@/lib/agenda/recibo-do-turno';
import { scrubMessage } from '@/lib/sentry/scrub';

/** Allowlist externa: aliases locais, sem IDs correlacionáveis ou referências internas. */
export function projetarContextoDoAtendimento(ctx: ContextoDoAtendimento): Record<string, unknown> {
  const fonte = (item: FonteDoAtendimento, i: number) => ({ referencia: `fonte_${i + 1}`, origem: item.origem, sujeito: item.sujeito, em: item.em, estado: item.estado, dados: item.dados });
  const result = { versao: 1, leituras_de_estado_da_agenda: { origem:'releitura_scoped_do_servidor', significado:'estado_atual_nao_autoria_nem_execucao_neste_turno', recibos:projetarLeiturasDeEstadoDaAgenda(ctx) }, perfil: ctx.perfil.map(fonte), decisoes: ctx.decisoes.map(fonte), operacoes: ctx.operacoes.map(fonte), continuidade: ctx.continuidade.map(fonte), cobertura: ctx.cobertura,
    ...(ctx.pedido ? { pedido_canonico: { estado:ctx.pedido.estado,tipo_turno:ctx.pedido.tipoTurno,gatilho_em:ctx.pedido.gatilhoEm,
      significado:ctx.pedido.tipoTurno==='case_reply_turn'?'evento_humano_sobre_pedido_original_nao_nova_mensagem_cliente':'gatilho_real_do_job',
      mensagem:ctx.pedido.mensagem?{texto:ctx.pedido.mensagem.text,em:ctx.pedido.mensagem.at,origem:ctx.pedido.mensagem.origem}:null } } : {}) };
  // UUIDs em texto livre também são internos; scrubMessage preserva UUIDs por desenho.
  return JSON.parse(scrubMessage(JSON.stringify(result)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[referencia_interna]')) as Record<string, unknown>;
}
