/** Diagnóstico privado é opt-in; não altera o envio nem grava conteúdo em log. */
import { scrubMessage } from '@/lib/sentry/scrub';
import type { Queryable } from '@/lib/agent-engine/queue/queue';
import { createHash } from 'node:crypto';

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_REVIEWS = 100;
export const COLLECTION_MS = 2 * 60 * 60 * 1000;
export const ACCESS_MS = 72 * 60 * 60 * 1000;
export const TEXT_FIELD_LIMIT = 16000;
/** Só o seam do modelo opta por esta representação; os demais campos mantêm o corte. */
export const MAX_TEXT_SEGMENTS = 8;
type OpcoesDaCaptura = { textosLongos?: 'segmentados' };
type EscopoDaCaptura = { tenantId: string; jobId?: string | null };

function redigirTexto(value: string): string {
  return scrubMessage(value
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, '[SEGREDO]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk|sb_secret|dsk)[_-][A-Za-z0-9_-]{8,})/gi, '[SEGREDO]'))
    .replace(/\b(?:api[_ -]?key|token|password|senha|secret)\s*[:=]\s*[^\s,;]+/gi, '[SEGREDO]')
    .replace(/data:[^\s"<>]+/gi,'[MÍDIA EXCLUÍDA]')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[URL]');
}

export async function capturaRevisaoHabilitada(db: Queryable, ids: EscopoDaCaptura): Promise<boolean> {
  if (!ids.jobId) return false;
  try {
    const { rows } = await db.query<{ enabled: boolean }>(
      'select public.fn_review_capture_enabled($1,$2) as enabled', [ids.tenantId,ids.jobId]);
    return rows[0]?.enabled === true;
  } catch { return false; }
}

/** Nunca receber request/response inteiros nem modelo instanciado. */
export function sanitizarCaptura(value: unknown,coverage?:{omitted_fields:number},opcoes:OpcoesDaCaptura={}): unknown {
  if(typeof value==='string' && /^[\s]*[\[{]/.test(value)) {
    try {
      const json=sanitizarCaptura(JSON.parse(value),coverage,opcoes);
      // Corpo JSON do provedor mantém a estrutura: não volta a virar um campo gigante.
      return opcoes.textosLongos === 'segmentados' ? {diagnostic_representation:'json_string_v1',value:json} : JSON.stringify(json);
    } catch { /* texto não é JSON */ }
  }
  if(typeof value==='string'&&value.length>TEXT_FIELD_LIMIT){
    if(opcoes.textosLongos!=='segmentados') {
      if(coverage)coverage.omitted_fields++;return '[TEXTO EXCLUÍDO DO DIAGNÓSTICO: limite16000]';
    }
    // Não submeter texto desmedido/opaco aos redatores de PII: além de não ser
    // contexto legível, uma cadeia enorme sem espaços custa caro nos regex.
    if(value.length>TEXT_FIELD_LIMIT*MAX_TEXT_SEGMENTS||/\S{16001,}/u.test(value)) {
      if(coverage)coverage.omitted_fields++;
      return {diagnostic_representation:'text_segments_v1',complete:false,source_chars:value.length,
        omitted_chars:value.length,segments:[],diagnostic_omission:value.length>TEXT_FIELD_LIMIT*MAX_TEXT_SEGMENTS?'text_segments_limit':'opaque_text_limit'};
    }
    // Redigir ANTES de dividir: segredo/PII na fronteira não pode sobreviver em metades.
    const text=redigirTexto(value);
    const kept=text.slice(0,TEXT_FIELD_LIMIT*MAX_TEXT_SEGMENTS);
    const omitted=text.length-kept.length;
    if(omitted&&coverage)coverage.omitted_fields++;
    return {diagnostic_representation:'text_segments_v1',sanitized:true,
      source_chars:value.length,sanitized_chars:text.length,omitted_chars:omitted,
      complete:omitted===0,sha256_sanitized:createHash('sha256').update(text).digest('hex'),
      segments:Array.from({length:Math.ceil(kept.length/TEXT_FIELD_LIMIT)},(_,i)=>kept.slice(i*TEXT_FIELD_LIMIT,(i+1)*TEXT_FIELD_LIMIT))};
  }
  if (typeof value === 'string') return redigirTexto(value);
  if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)) {
    if(coverage)coverage.omitted_fields++;return {diagnostic_omission:'binary_excluded'};
  }
  if(value&&typeof value==='object'&&!Array.isArray(value)&&'type' in value&&['image','file','audio','video','input_image','input_file','input_audio','image_url'].includes(String(value.type))){
    if(coverage)coverage.omitted_fields++;return {type:String(value.type),diagnostic_omission:'media_excluded'};
  }
  if (Array.isArray(value)) return value.map(v=>sanitizarCaptura(v,coverage,opcoes));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => {
      const excluded=/^(authorization|cookies?|headers|api.?key|token|password|senha|secret|media|image|file|audio|image_url|input_audio|inline_?data|file_?data)$/i.test(k);
      if(excluded&&coverage)coverage.omitted_fields++;
      return !excluded;
    })
    .map(([k,v]) => [k, sanitizarCaptura(v,coverage,opcoes)]));
  return value;
}

export async function capturarRevisao(
  db: Queryable, ids: EscopoDaCaptura,
  caminho: 'reserva' | 'confirmador' | 'jev', pacoteEnviado: unknown,
  opcoes: OpcoesDaCaptura = {},
): Promise<void> {
  if (!ids.jobId) return;
  try {
    // Consulta barata default-off antes de serializar conteúdo; SQL repete toda a guarda.
    if (!await capturaRevisaoHabilitada(db,ids)) return;
    const raw=JSON.stringify(pacoteEnviado);
    if(Buffer.byteLength(raw,'utf8')>MAX_BYTES)return;
    const coverage={omitted_fields:0};
    const packet=sanitizarCaptura(pacoteEnviado,coverage,opcoes);
    const payload = JSON.stringify({packet,diagnostic_coverage:{sanitized:true,complete:coverage.omitted_fields===0,...coverage,text_field_limit:TEXT_FIELD_LIMIT,
      ...(opcoes.textosLongos==='segmentados'?{text_representation:'segments_v1',max_text_segments:MAX_TEXT_SEGMENTS}:{})}});
    if (Buffer.byteLength(payload,'utf8') > MAX_BYTES) return;
    await db.query('select public.fn_review_capture_append($1,$2,$3,$4::jsonb)',
      [ids.tenantId, ids.jobId, caminho, payload]);
  } catch {
    // Falha na coleta não veta atendimento; TTL/heartbeat no banco impedem coleta sem expurgo.
    // Nenhum texto, identificador de credencial ou mensagem de erro vai ao logger.
  }
}
