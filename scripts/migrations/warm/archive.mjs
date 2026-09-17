/** Extração privada de ensaio. Não é snapshot SQL e nunca habilita importação por si só. */
import { createHash } from 'node:crypto';
import { SOURCE_HOST, SOURCE_WORKSPACE } from './core.mjs';

const secretField = /(?:password|secret|ciphertext|auth_tag|(?:^|_)iv$|(?:^|_)api_key$|(?:^|_)access_token$|(?:^|_)refresh_token$|(?:^|_)token$|token_hash|authorization|cookie|credentials|session_data)/i;
export function redactCredentials(value, omitted = {}, path = '') {
  if (Array.isArray(value)) return value.map(v => redactCredentials(v, omitted, path + '[]'));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const next = path ? `${path}.${key}` : key;
    if (secretField.test(key)) { omitted[next] = (omitted[next] ?? 0) + 1; return []; }
    return [[key, redactCredentials(item, omitted, next)]];
  }));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) { url.username = ''; url.password = ''; omitted[path + '.url_credentials'] = (omitted[path + '.url_credentials'] ?? 0) + 1; }
      for (const key of [...url.searchParams.keys()]) if (secretField.test(key) || /signature|x-amz-|sig$/i.test(key)) {
        url.searchParams.delete(key); omitted[path + '.url_query'] = (omitted[path + '.url_query'] ?? 0) + 1;
      }
      return url.toString();
    } catch { return value; }
  }
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function digestRows(rows) {
  return createHash('sha256').update(rows.map(canonical).sort().join('\n')).digest('hex');
}

export function sourceReader({ url, key, fetcher = fetch }) {
  if (new URL(url).origin !== `https://${SOURCE_HOST}` || !key) throw new Error('Origem inválida');
  const base = `https://${SOURCE_HOST}/rest/v1/`;
  async function get(table, params) {
    const response = await fetcher(base + table + '?' + new URLSearchParams(params), {
      method: 'GET', headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
      signal: AbortSignal.timeout(60000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Extração ${table || 'catálogo'}: HTTP ${response.status}`);
    return response;
  }
  return {
    schema: async () => (await get('', {})).json(),
    async rows({ table, columns, filter, allowed, keyColumn = 'id', cutoff }) {
      if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(keyColumn) || !/^[a-z_]+$/.test(filter) || !columns.includes(keyColumn) || !columns.includes(filter)) throw new Error('Contrato inválido');
      if (!allowed.length) return [];
      if (allowed.some(id => !/^[a-f0-9-]{36}$/i.test(id))) throw new Error('Escopo inválido');
      const output = [], seen = new Set();
      for (let i = 0; i < allowed.length; i += 75) {
        const batch = allowed.slice(i, i + 75), scope = new Set(batch);
        let cursor, total;
        do {
          const params = { select: columns.join(','), [filter]: `in.(${batch.join(',')})`, order: `${keyColumn}.asc`, limit: '500' };
          if (cutoff && columns.includes('created_at')) params.created_at = `lte.${cutoff}`;
          if (cursor) params[keyColumn] = `gt.${cursor}`;
          // Quando o filtro é a própria PK, paginação por offset mantém o filtro de escopo.
          if (filter === keyColumn) { params[filter] = `in.(${batch.join(',')})`; params.offset = String(cursor ? total : 0); }
          const response = await get(table, params);
          const count = response.headers.get('content-range')?.split('/')[1];
          if (!/^\d+$/.test(count ?? '')) throw new Error('Contagem ausente');
          const rows = await response.json();
          if (!Array.isArray(rows) || rows.some(row => !scope.has(row[filter]) || (row.workspace_id && row.workspace_id !== SOURCE_WORKSPACE))) throw new Error('Registro fora do escopo');
          for (const row of rows) {
            if (!row[keyColumn] || seen.has(row[keyColumn])) throw new Error('Identidade duplicada ou ausente');
            seen.add(row[keyColumn]); output.push(row);
          }
          if (!rows.length && Number(count) > 0) throw new Error('Página incompleta');
          total = (total ?? 0) + rows.length;
          if (rows.length === Number(count) || (filter === keyColumn && total === Number(count))) break;
          if (!rows.length) break;
          cursor = rows.at(-1)[keyColumn];
        } while (true);
      }
      return output;
    },
  };
}

// Escopos derivados apenas de registros já selecionados pela empresa autorizada.
export const dependentTables = [
  ['workspaces','id', null, null],
  ['profiles','id','workspace_members','user_id'],
  ['crm_conversation_tags','conversation_id','crm_conversations','id'],
  ['crm_deal_conversations','deal_id','deals','id'],
  ['crm_deal_products','deal_id','deals','id'],
  ['crm_product_images','product_id','crm_products','id'],
  ['crm_contact_import_rows','import_job_id','crm_contact_import_jobs','id'],
  ['appointment_reminders','appointment_id','appointments','id'],
  ['internal_conversation_participants','conversation_id','internal_conversations','id'],
  ['internal_conversation_pins','conversation_id','internal_conversations','id'],
  ['internal_message_attachments','message_id','internal_messages','id'],
  ['internal_message_mentions','message_id','internal_messages','id'],
  ['internal_message_reactions','message_id','internal_messages','id'],
  ['internal_message_edit_log','message_id','internal_messages','id'],
  ['internal_message_delete_log','message_id','internal_messages','id'],
  ['admin_audit_log','target_workspace_id',null,null],
  ['plans','id','workspace_subscriptions','plan_id'],
];
