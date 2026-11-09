/**
 * OS CAMPOS DO CARD NO RESUMO DA PASSAGEM PARA HUMANO (issue #4303).
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * O resumo que a pessoa lê ao assumir a conversa ("Resumo da IA (confira)", no
 * cartão de passagem) só carregava o que um fluxo DETERMINÍSTICO perguntou no
 * turno. O dado mais importante da venda mora no CARD — consumo em kWh, valor
 * da conta — e quem assumia tinha de abrir o negócio para achá-lo, com o
 * cliente esperando.
 *
 * ─── As quatro réguas, e por que são estas ─────────────────────────────────
 *
 * 1. **LIGADO POR CAMPO, DESLIGADO POR PADRÃO.** A opção é um booleano na
 *    própria definição (`settings.fields[i].mostrar_no_resumo_da_passagem`,
 *    schema em `lib/schemas/settings.ts`). A chave AUSENTE — que é toda
 *    definição instalada antes desta entrega — não liga nada: nenhum funil
 *    antigo muda de comportamento, e o resumo de quem não marcar nada sai
 *    byte a byte como saía. Não há migration: a definição é jsonb.
 *
 * 2. **SÓ O CARD DA CONVERSA, UM CARD.** O valor lido é
 *    `crm_leads.custom_fields` de UM negócio. `conversations` não tem
 *    `lead_id` (medido em `supabase/baseline.sql`): o vínculo é o CONTATO da
 *    conversa (`conversations.contact_id`), e o card é o negócio ABERTO mais
 *    recente dele — o mesmo desempate de `negocioAbertoDoContato`
 *    (`created_at desc` lá; aqui `updated_at desc`, a atividade é o que diz
 *    qual card a conversa está tocando). O `limit 1` é a regra, não economia:
 *    contato com dois cards abertos NUNCA soma valores dos dois — somar
 *    inventaria um total que ninguém digitou.
 *
 * 3. **CAMPO SEM VALOR NÃO APARECE.** Marcado e vazio (ausente, `null`,
 *    branco, lista vazia) não vira "Consumo: —": o resumo é informação para
 *    agir, e uma linha de nada ocupa o teto do bloco sem dizer nada.
 *
 * 4. **RÓTULO, NÃO CHAVE, E O VALOR COMO O CARD MOSTRA.** Quem lê o cartão
 *    lê "Consumo (kWh)", não `consumo_kwh`; e um `select` mostra o rótulo da
 *    opção, não o `value` canônico — a mesma régua de `valorComRotulo`
 *    (`lib/automation/campos-do-render.ts`). Moeda usa a moeda da ORGANIZAÇÃO,
 *    como no card (`lib/leads/campo-de-moeda.ts`).
 *
 * ─── O que este arquivo NÃO faz ────────────────────────────────────────────
 *
 * Não aumenta os tetos do bloco: quem corta em `MAX_CAMPOS_COLETADOS` é
 * `lib/escalacao/briefing-da-passagem.ts`, e a ordem de declaração do funil é
 * a ordem em que os campos entram. Não lê campos de escopo `contato` (o valor
 * deles mora em `contacts.custom_fields`, outra tabela — oferecer a opção ali
 * prometeria o que não acontece) nem campo `file` (o anexo mora em
 * `crm_lead_attachments`, não no jsonb). Não lança: leitura de contexto que
 * falha vira resumo de hoje, nunca passagem a menos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { anexarCamposDoFunil, valorComRotulo } from "@/lib/automation/campos-do-render";
import { valorDoCampoDeMoeda } from "@/lib/leads/campo-de-moeda";
import { camposDoFunil, escopoDoCampo } from "@/lib/leads/campos-do-funil";
import type { CustomFieldDef } from "@/lib/schemas/settings";

/** O nome da opção no `settings.fields[i]`. Booleano, ausente = desligado. */
export const OPCAO_DO_RESUMO = "mostrar_no_resumo_da_passagem" as const;

/**
 * Os campos que o editor marcou para o resumo, na ordem em que o funil os
 * declara. Só do NEGÓCIO (é o card) e só tipos com valor no `custom_fields`.
 */
export function camposMarcadosNoResumo(settings: Record<string, unknown> | null | undefined): CustomFieldDef[] {
  return camposDoFunil(settings).filter(
    (campo) =>
      campo.mostrar_no_resumo_da_passagem === true &&
      escopoDoCampo(campo) === "negocio" &&
      campo.type !== "file",
  );
}

/** O mínimo de `pg.Pool` que a leitura do card usa. Tipado aqui para não arrastar `pg`. */
export interface LeitorDeLinhas {
  query<L extends Record<string, unknown>>(
    texto: string,
    valores?: readonly unknown[],
  ): Promise<{ rows: L[] }>;
}

/**
 * O TEXTO do valor como o card o mostra — ou `null` para "não aparece".
 *
 * `null` cobre ausente, `null`, branco e lista vazia; objeto (jsonb que não é
 * escalar nem lista) também sai: `String(objeto)` seria `[object Object]` no
 * resumo de quem está atendendo. Booleano vira palavra ("Sim"/"Não") pela
 * mesma régua de `RevisaoDoDocumento.valorParaExibir`.
 */
function textoDoValor(
  campo: CustomFieldDef,
  valor: unknown,
  contexto: Record<string, unknown>,
  moeda: string | null,
): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "boolean") return valor ? "Sim" : "Não";
  const comRotulo = valorComRotulo(contexto, campo.key, valor);
  if (Array.isArray(comRotulo)) return null;
  if (typeof comRotulo === "number") {
    if (campo.type === "currency" && moeda !== null) return valorDoCampoDeMoeda(comRotulo, moeda);
    return String(comRotulo);
  }
  if (typeof comRotulo !== "string") return null;
  const texto = comRotulo.trim();
  return texto === "" ? null : texto;
}

/**
 * Os pares `rótulo → valor` dos campos marcados que TÊM valor no card.
 *
 * PURA: recebe a definição do funil e o `custom_fields` do negócio, devolve o
 * que entra em `camposColetados`. Sem campo marcado — ou com todos vazios — o
 * resultado é `{}`, e o resumo sai como o de hoje.
 */
export function camposDoCardParaResumo(
  settings: Record<string, unknown> | null | undefined,
  customFields: unknown,
  opcoes: { moeda?: string | null } = {},
): Record<string, string> {
  const saida: Record<string, string> = {};
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields)) return saida;
  const marcados = camposMarcadosNoResumo(settings);
  if (marcados.length === 0) return saida;

  const valores = customFields as Record<string, unknown>;
  // O contexto só carrega os campos marcados: `valorComRotulo` precisa das
  // opções das listas, e nada além disso.
  const contexto: Record<string, unknown> = {};
  anexarCamposDoFunil(contexto, marcados);
  const moeda = opcoes.moeda ?? null;

  for (const campo of marcados) {
    const texto = textoDoValor(campo, valores[campo.key], contexto, moeda);
    if (texto === null) continue;
    saida[campo.label] = texto;
  }
  return saida;
}

/** A linha do negócio que a leitura precisa — e a definição do funil dele. */
interface CardDoNegocio {
  pipeline_id: string | null;
  custom_fields: unknown;
}

/**
 * Compõe o resumo a partir do card já lido. Silencioso por desenho: sem
 * `pipeline_id`, sem definição ou com a leitura da moeda falhando, devolve o
 * que der — contexto a menos nunca pode virar passagem a menos.
 */
async function resumoDoCard(
  admin: SupabaseClient,
  organizationId: string,
  card: CardDoNegocio,
): Promise<Record<string, string>> {
  if (typeof card.pipeline_id !== "string") return {};
  try {
    const { data: funil } = await admin
      .from("crm_pipelines")
      .select("settings")
      .eq("organization_id", organizationId)
      .eq("id", card.pipeline_id)
      .maybeSingle();
    const settings = (funil as { settings?: Record<string, unknown> | null } | null)?.settings ?? null;
    if (camposMarcadosNoResumo(settings).length === 0) return {};

    // A moeda só é lida quando há campo marcado: é a formatação de `currency`.
    const { data: org } = await admin
      .from("organizations")
      .select("currency")
      .eq("id", organizationId)
      .maybeSingle();
    const moeda = (org as { currency?: string | null } | null)?.currency ?? null;

    return camposDoCardParaResumo(settings, card.custom_fields, { moeda });
  } catch {
    return {};
  }
}

/**
 * O resumo dos campos do CARD DA CONVERSA do contato — o negócio ABERTO mais
 * recente. UM card, nunca a soma de dois; ver a régua 2 no cabeçalho.
 *
 * Nunca lança: leitura que falha vira `{}` (o resumo de hoje).
 */
export async function camposDoCardDoContato(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!contactId) return {};
  try {
    const { data } = await admin
      .from("crm_leads")
      .select("pipeline_id, custom_fields")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .eq("status", "open")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    const card = data as CardDoNegocio | null;
    if (!card) return {};
    return await resumoDoCard(admin, organizationId, card);
  } catch {
    return {};
  }
}

/**
 * O resumo dos campos de UM negócio declarado pela passagem (`leadId`).
 *
 * É o caminho do orquestrador do CRM, que às vezes sabe exatamente qual card a
 * conversa está tocando: com o id, o card é esse e não o "mais recente". O
 * filtro de organização não é decoração — sem ele, um id de outro tenant
 * atravessaria a fronteira (a leitura aqui é service-role).
 *
 * `leadId` ausente = `{}`: a passagem sem card declarado não inventa card.
 */
export async function camposDoCardDoLead(
  admin: SupabaseClient,
  organizationId: string,
  leadId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!leadId) return {};
  try {
    const { data } = await admin
      .from("crm_leads")
      .select("pipeline_id, custom_fields")
      .eq("organization_id", organizationId)
      .eq("id", leadId)
      .maybeSingle();
    const card = data as CardDoNegocio | null;
    if (!card) return {};
    return await resumoDoCard(admin, organizationId, card);
  } catch {
    return {};
  }
}

/**
 * O resumo dos campos do card do CONTATO, pela porta do `pg.Pool` — o motor de
 * conversa não fala supabase-js.
 *
 * Uma consulta só, com os JOINs da definição e da moeda, `limit 1` explícito:
 * o card é o negócio aberto mais recente do contato, e a organização entra nas
 * DUAS pontas (negócio e funil) para nenhum jsonb de outro tenant ser lido.
 * Nunca lança.
 */
export async function camposDoCardDoContatoNoBanco(
  leitor: LeitorDeLinhas,
  organizationId: string,
  contactId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!contactId) return {};
  try {
    const { rows } = await leitor.query<{
      settings: Record<string, unknown> | null;
      custom_fields: unknown;
      moeda: string | null;
    }>(
      `select p.settings as settings, l.custom_fields as custom_fields, o.currency as moeda
         from crm_leads l
         join crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
         join organizations o on o.id = l.organization_id
        where l.organization_id = $1 and l.contact_id = $2 and l.status = 'open'
        order by l.updated_at desc, l.id desc
        limit 1`,
      [organizationId, contactId],
    );
    const card = rows[0];
    if (!card) return {};
    return camposDoCardParaResumo(card.settings, card.custom_fields, { moeda: card.moeda });
  } catch {
    return {};
  }
}
