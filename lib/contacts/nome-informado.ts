/** Nome selecionado pela tool; o servidor comprova a origem e limita a escrita. */
import type { Queryable, JobRow } from '@/lib/agent-engine/queue/queue';
import type { ServiceBoundary } from '@/lib/atendimento/fronteira';
import type { McpContext } from '@/lib/mcp/types';

const PARTICULAS = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
function normalizar(texto: string): string {
  return texto.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/**
 * Confere correspondência, NÃO classifica linguagem como nome. Essa seleção é
 * da chamada crm_propose_contact_field, que pode errar. Nunca extrai substring,
 * trecho do modelo, nome de terceiro dentro de frase ou texto de outra mensagem.
 */
export function nomeCorrespondeAMensagem(valor: string, textoOriginal: string): string | null {
  if (valor.length > 100 || textoOriginal.length > 160 ||
      /[\r\n\p{Cc}\p{Cf}]/u.test(valor + textoOriginal)) return null;
  const nome = normalizar(valor);
  if (nome.length < 4 || !/^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*(?: [\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*)+$/u.test(nome)) return null;
  const partes = nome.split(' ');
  if (partes.length > 8 || partes.filter((p) => !PARTICULAS.has(p.toLocaleLowerCase('pt-BR')) && p.length > 1).length < 2) return null;
  const original = normalizar(textoOriginal);
  const apresentacao = /^(?:meu nome(?: completo)? [ée]|(?:eu )?me chamo|pode me chamar de)\s+(.+?)[.!]?$/iu.exec(original);
  const informado = apresentacao?.[1]?.trim() ?? original.replace(/[.!]$/u, '');
  return informado.toLocaleLowerCase('pt-BR') === nome.toLocaleLowerCase('pt-BR') ? nome : null;
}

export interface NomeDoTurnoIds {
  organizationId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  serviceRevision: number;
}

/** Só o contexto do runtime autoriza a exceção. MCP externo e outros jobs não. */
export function origemConfiavelDoNome(
  ctx: Pick<McpContext, 'organizationId' | 'contatoDoTurno' | 'sourceJobId'>,
  contactIdDaTool: string,
  job: JobRow | null,
  boundary: ServiceBoundary | null,
): NomeDoTurnoIds | null {
  if (!job || job.kind !== 'inbound_turn' || job.id !== ctx.sourceJobId || !boundary ||
      !ctx.contatoDoTurno || contactIdDaTool !== ctx.contatoDoTurno ||
      job.organization_id !== ctx.organizationId || job.contact_id !== ctx.contatoDoTurno ||
      boundary.organization_id !== ctx.organizationId || boundary.contact_id !== ctx.contatoDoTurno ||
      !Number.isSafeInteger(boundary.service_revision) || boundary.service_revision < 1 ||
      job.payload.conversation_id !== boundary.conversation_id ||
      typeof job.payload.inbound_message_id !== 'string' || !job.payload.inbound_message_id) return null;
  const capturada = job.payload.service_boundary as Partial<ServiceBoundary> | null | undefined;
  if (!capturada || typeof capturada !== 'object' ||
      capturada.organization_id !== boundary.organization_id ||
      capturada.contact_id !== boundary.contact_id ||
      capturada.conversation_id !== boundary.conversation_id ||
      capturada.service_revision !== boundary.service_revision ||
      capturada.demanda_id !== boundary.demanda_id ||
      capturada.demanda_revision !== boundary.demanda_revision) return null;
  return { organizationId: ctx.organizationId, contactId: ctx.contatoDoTurno,
    conversationId: boundary.conversation_id, messageId: job.payload.inbound_message_id,
    serviceRevision: boundary.service_revision };
}

export type ResultadoNomeInformado =
  | { aplicado: true; nome: string }
  | { aplicado: false; textoOriginal?: string };

// Não recebe trecho do modelo. Escopo e opção valem na leitura E na escrita.
const LER = `select m.body, c.name
 from messages m
 join conversations cv on cv.id=m.conversation_id and cv.organization_id=m.organization_id
 join contacts c on c.id=cv.contact_id and c.organization_id=cv.organization_id
 join organizations o on o.id=c.organization_id
 where m.organization_id=$1 and c.id=$2 and cv.id=$3 and m.id=$4
   and m.direction='inbound' and m.type='text' and m.service_revision=$5 and cv.service_revision=$5
   and not cv.is_group and cv.assigned_to_user_id is null
   and (cv.bot_silenced_until is null or cv.bot_silenced_until<=now())
   and cv.status not in ('closed','archived','resolved')
   and not c.is_anonymized and not c.is_personal and not c.is_blocked and not c.force_human
   and c.is_merged_into is null
   and o.settings->'crm'->'nome_informado_no_atendimento'='true'::jsonb`;

// Nome vazio + mensagem/revisão iguais protegem edição humana e replay.
// Auditoria no mesmo statement: falha de auditoria também reverte o UPDATE.
const GRAVAR = `with aplicado as (
 update contacts c set name=$6, updated_at=now()
 from conversations cv, messages m, organizations o
 where c.organization_id=$1 and c.id=$2 and cv.id=$3 and m.id=$4
   and cv.organization_id=c.organization_id and cv.contact_id=c.id
   and m.organization_id=c.organization_id and m.conversation_id=cv.id and o.id=c.organization_id
   and m.direction='inbound' and m.type='text' and m.body=$7
   and m.service_revision=$5 and cv.service_revision=$5 and not cv.is_group
   and cv.assigned_to_user_id is null and (cv.bot_silenced_until is null or cv.bot_silenced_until<=now())
   and cv.status not in ('closed','archived','resolved')
   and not c.is_anonymized and not c.is_personal and not c.is_blocked and not c.force_human
   and c.is_merged_into is null and nullif(btrim(c.name),'') is null
   and o.settings->'crm'->'nome_informado_no_atendimento'='true'::jsonb
 returning c.id, c.name
), registro as (
 insert into api_audit_log (organization_id, action, resource_type, resource_id, bypassed_rls, metadata)
 select $1, 'contact.field_auto_applied', 'contact', id, true,
   jsonb_build_object('campo','name','origem','mensagem_do_titular','message_id',$4::text,'conversation_id',$3::text)
 from aplicado returning id
) select id, name from aplicado`;

export async function registrarNomeInformado(
  db: Queryable,
  ids: NomeDoTurnoIds,
  valorSelecionadoPelaTool: string,
  antesDeGravar: () => Promise<void>,
): Promise<ResultadoNomeInformado> {
  const parametros = [ids.organizationId, ids.contactId, ids.conversationId, ids.messageId, ids.serviceRevision];
  const { rows } = await db.query<{ body: string; name: string | null }>(LER, parametros);
  const origem = rows[0];
  if (!origem || typeof origem.body !== 'string') return { aplicado: false };
  const proposta = { aplicado: false as const, textoOriginal: origem.body };
  const nome = nomeCorrespondeAMensagem(valorSelecionadoPelaTool, origem.body);
  if (!nome || origem.name?.trim()) return proposta;
  await antesDeGravar();
  const gravado = await db.query<{ id: string; name: string }>(GRAVAR, [...parametros, nome, origem.body]);
  return gravado.rows[0] ? { aplicado: true, nome: gravado.rows[0].name } : proposta;
}