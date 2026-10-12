/** Diagnóstico privado é opt-in; não altera o envio nem grava conteúdo em log. */
import { scrubMessage } from '@/lib/sentry/scrub';
import type { Queryable } from '@/lib/agent-engine/queue/queue';

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_REVIEWS = 100;
export const COLLECTION_MS = 2 * 60 * 60 * 1000;
export const ACCESS_MS = 72 * 60 * 60 * 1000;

/** Nunca receber cabeçalhos/credenciais/modelo instanciado. Só texto enviado ao revisor. */
export function sanitizarCaptura(value: unknown,coverage?:{omitted_fields:number}): unknown {
  if(typeof value==='string' && /^[\s]*[\[{]/.test(value)) {
    try { return JSON.stringify(sanitizarCaptura(JSON.parse(value),coverage)); } catch { /* texto não é JSON */ }
  }
  if(typeof value==='string'&&value.length>16000){if(coverage)coverage.omitted_fields++;return '[TEXTO EXCLUÍDO DO DIAGNÓSTICO: limite16000]';}
  if (typeof value === 'string') return scrubMessage(value)
    .replace(/\b(?:Bearer\s+\S+|(?:sk|sb_secret|dsk)[_-][A-Za-z0-9_-]{8,})/gi, '[SEGREDO]')
    .replace(/\b(?:api[_ -]?key|token|password|senha|secret)\s*[:=]\s*[^\s,;]+/gi, '[SEGREDO]')
    .replace(/data:[^\s"<>]+/gi,'[MÍDIA EXCLUÍDA]')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[URL]');
  if(value&&typeof value==='object'&&!Array.isArray(value)&&'type' in value&&['image','file','audio','video'].includes(String(value.type))){
    if(coverage)coverage.omitted_fields++;return {type:String(value.type),diagnostic_omission:'media_excluded'};
  }
  if (Array.isArray(value)) return value.map(v=>sanitizarCaptura(v,coverage));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => !/^(authorization|cookie|headers|api.?key|token|password|senha|secret|media|image|file|audio)$/i.test(k))
    .map(([k,v]) => [k, sanitizarCaptura(v,coverage)]));
  return value;
}

export async function capturarRevisao(
  db: Queryable, ids: { tenantId: string; jobId?: string | null },
  caminho: 'reserva' | 'confirmador' | 'jev', pacoteEnviado: unknown,
): Promise<void> {
  if (!ids.jobId) return;
  try {
    // Consulta barata default-off antes de serializar conteúdo; SQL repete toda a guarda.
    const { rows } = await db.query<{ enabled: boolean }>(
      'select public.fn_review_capture_enabled($1,$2) as enabled', [ids.tenantId,ids.jobId]);
    if (!rows[0]?.enabled) return;
    const raw=JSON.stringify(pacoteEnviado);
    if(Buffer.byteLength(raw,'utf8')>MAX_BYTES)return;
    const coverage={omitted_fields:0};
    const packet=sanitizarCaptura(pacoteEnviado,coverage);
    const payload = JSON.stringify({packet,diagnostic_coverage:{sanitized:true,complete:coverage.omitted_fields===0,...coverage,text_field_limit:16000}});
    if (Buffer.byteLength(payload,'utf8') > MAX_BYTES) return;
    await db.query('select public.fn_review_capture_append($1,$2,$3,$4::jsonb)',
      [ids.tenantId, ids.jobId, caminho, payload]);
  } catch {
    // Falha na coleta não veta atendimento; TTL/heartbeat no banco impedem coleta sem expurgo.
    // Nenhum texto, identificador de credencial ou mensagem de erro vai ao logger.
  }
}
