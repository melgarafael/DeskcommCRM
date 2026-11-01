/**
 * O WHATSAPP DE CADA MEMBRO DA EQUIPE — de onde o aviso tira o telefone do
 * responsável (#3803).
 *
 * ─── Onde o número mora, e por que aqui ────────────────────────────────────
 *
 * Medido antes de escrever esta entrega: o produto NÃO tinha telefone de membro
 * em lugar nenhum. `contacts` é o telefone do CLIENTE, `channel_sessions` é a
 * linha de WhatsApp que a empresa conecta, `people` é a ficha de CRM B2B (sem
 * telefone) e o perfil do usuário (`auth.users.user_metadata`) guarda nome,
 * avatar, fuso e idioma — e o módulo de nomes até declara que telefone não sai
 * de lá.
 *
 * O número que o aviso precisa é outro: é o celular PESSOAL de quem atende,
 * por organização (a mesma pessoa pode atender em duas). Esse lugar é
 * `user_organizations.whatsapp_e164` — a linha do vínculo, que é a que a RLS já
 * protege e a que a instalação já usa para saber quem é membro.
 *
 * ─── Uma consulta para os três elos ───────────────────────────────────────
 *
 * `carregaMundoDoAviso` lê a conversa, o negócio aberto do contato, a carteira
 * do contato e os telefones dos três responsáveis — quatro leituras, nenhuma
 * por candidato. A regra de QUEM recebe fica em `destino-do-aviso` (pura); aqui
 * só se entrega o mundo que ela precisa, com o `organization_id` filtrado à mão
 * (o client é o de service role, que BYPASSA a RLS).
 *
 * ─── E.164, com `+`, do jeito que o transporte recebe ─────────────────────
 *
 * A normalização é a mesma do número da empresa (`normalizarTelefoneDeAviso`):
 * dígitos e um `+` na frente. Não há máscara por país — inventá-la reformataria
 * errado o número de quem está fora do Brasil, e este produto é distribuído.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { idsDaCadeiaDoAviso, modoDoDestinoDoAviso, resolverDestinoDoAviso } from "./destino-do-aviso";
import { normalizarTelefoneDeAviso, telefoneDeAvisoValido } from "./estado-do-aviso";

/** A linha da conversa, reduzida ao que a cadeia lê. */
export type ConversaDoMundoDoAviso = {
  assigned_to_user_id: string | null;
  assignee_kind: string | null;
};
/** A linha do negócio aberto do contato. */
export type NegocioDoMundoDoAviso = { owner_user_id: string | null; owner_kind: string | null };
/** A linha do contato. */
export type ContatoDoMundoDoAviso = { carteira_user_id: string | null };

/** O mundo que a resolução precisa, já lido. */
export interface MundoDoAviso {
  conversa: ConversaDoMundoDoAviso | null;
  negocio: NegocioDoMundoDoAviso | null;
  contato: ContatoDoMundoDoAviso | null;
  /** `user_id` → WhatsApp do perfil do membro (ou `null` quando não cadastrou). */
  whatsapps: Map<string, string | null>;
}

/** O que o membro digitou, na forma que o banco aceita. */
export function normalizarWhatsappDoMembro(bruto: string): string {
  return normalizarTelefoneDeAviso(bruto);
}

/**
 * O WhatsApp de um membro é usável?
 *
 * Número vazio é `false` (o elo cai para o próximo, e é o caso comum: ninguém
 * preencheu); número preenchido e torto também — mas esse NÃO é o mesmo caso, e
 * por isso a tela avisa em vez de deixar a pessoa descobrir pelo aviso que não
 * chegou.
 */
export function whatsappDoMembroValido(bruto: string | null | undefined): boolean {
  return telefoneDeAvisoValido(bruto);
}

/**
 * Os telefones dos membros pedidos, em UMA consulta.
 *
 * Só membro ativo conta (`revoked_at is null`): quem saiu da equipe não recebe
 * aviso de atendimento, mesmo que o número tenha ficado na linha.
 */
export async function carregaWhatsappsDosMembros(
  admin: SupabaseClient,
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const mapa = new Map<string, string | null>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return mapa;
  // ⚠️ `organization_id` filtrado À MÃO: service role bypassa a RLS.
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id, whatsapp_e164")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .in("user_id", ids);
  if (error) throw new Error(error.message);
  for (const linha of (data ?? []) as Array<{ user_id: string; whatsapp_e164: string | null }>) {
    mapa.set(linha.user_id, whatsappDoMembroValido(linha.whatsapp_e164) ? linha.whatsapp_e164 : null);
  }
  return mapa;
}

/**
 * Lê o mundo do aviso: conversa, negócio ABERTO do contato, carteira dele e o
 * WhatsApp dos três elos.
 *
 * `status = 'open'` é o vocabulário de `crm_leads` para o card que ainda está
 * esperando alguém — ganho e perdido não são "o negócio aberto" de ninguém. A
 * ordem é por `updated_at` porque, com mais de um card aberto, o que interessa é
 * o que está sendo trabalhado AGORA.
 */
export async function carregaMundoDoAviso(
  admin: SupabaseClient,
  entrada: { organizationId: string; conversationId: string | null; contactId: string | null },
): Promise<MundoDoAviso> {
  const { organizationId, conversationId, contactId } = entrada;

  const [conversa, contato, negocio] = await Promise.all([
    conversationId
      ? admin
          .from("conversations")
          .select("assigned_to_user_id, assignee_kind")
          .eq("organization_id", organizationId)
          .eq("id", conversationId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    contactId
      ? admin
          .from("contacts")
          .select("carteira_user_id")
          .eq("organization_id", organizationId)
          .eq("id", contactId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    contactId
      ? admin
          .from("crm_leads")
          .select("owner_user_id, owner_kind")
          .eq("organization_id", organizationId)
          .eq("contact_id", contactId)
          .eq("status", "open")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  // Falha de leitura NÃO derruba o aviso: quem chama trata cada linha ausente
  // como "este elo não existe", e a cadeia cai no número da empresa. Lançar
  // aqui transformaria um `42P01` num aviso que nunca sai.
  if (conversa.error || contato.error || negocio.error) {
    const linhaConversa = conversa.error ? null : (conversa.data as ConversaDoMundoDoAviso | null);
    const linhaContato = contato.error ? null : (contato.data as ContatoDoMundoDoAviso | null);
    const linhaNegocio = negocio.error ? null : (negocio.data as NegocioDoMundoDoAviso | null);
    return {
      conversa: linhaConversa,
      negocio: linhaNegocio,
      contato: linhaContato,
      whatsapps: new Map(),
    };
  }

  const mundo: MundoDoAviso = {
    conversa: (conversa.data as ConversaDoMundoDoAviso | null) ?? null,
    negocio: (negocio.data as NegocioDoMundoDoAviso | null) ?? null,
    contato: (contato.data as ContatoDoMundoDoAviso | null) ?? null,
    whatsapps: new Map(),
  };
  const ids = idsDaCadeiaDoAviso(mundo);
  mundo.whatsapps = await carregaWhatsappsDosMembros(admin, organizationId, ids);
  return mundo;
}

/**
 * A resolução com o mundo já lido — o atalho que os dois adapters usam.
 *
 * Existe para que o aviso de caso e o de proposta chamem a MESMA regra com o
 * mesmo mundo: são quatro leituras e uma decisão, e não dois caminhos que um
 * dia divergem.
 */
export function destinoDoAvisoComMundo(
  config: Record<string, unknown> | null | undefined,
  mundo: MundoDoAviso,
) {
  return resolverDestinoDoAviso({
    config,
    conversa: mundo.conversa,
    negocio: mundo.negocio,
    contato: mundo.contato,
    whatsapps: mundo.whatsapps,
  });
}

/**
 * A DECISÃO de quem recebe, com o mundo lido só quando ele é necessário — o
 * ponto único dos DOIS avisos (caso e proposta).
 *
 * No modo `fixo` isto é o número da empresa e ZERO consulta: o caminho de quem
 * nunca abriu a opção não muda de custo. No modo `responsavel` são as quatro
 * leituras de `carregaMundoDoAviso` e a regra pura.
 *
 * Falha de leitura cai no número da empresa — o desfecho de SEMPRE — e nomeia
 * no log: um aviso que não sai por causa de uma leitura acessória é pior do que
 * um aviso que sai para o número errado por cinco minutos.
 *
 * `carregaMundo` é opcional porque os dublês anteriores a esta entrega não o
 * têm; sem ele o aviso continua no número fixo, que é o modo deles.
 */
export async function resolveDestinoDoEnvio(entrada: {
  config: Record<string, unknown> | null | undefined;
  organizationId: string;
  conversationId: string | null;
  contactId: string | null;
  carregaMundo?: (pedido: {
    organizationId: string;
    conversationId: string | null;
    contactId: string | null;
  }) => Promise<MundoDoAviso>;
  /** Rótulo do log. `"caso"` ou `"proposta"`. */
  aviso: "caso" | "proposta";
}): Promise<ReturnType<typeof resolverDestinoDoAviso>> {
  const { config, organizationId, conversationId, contactId, carregaMundo, aviso } = entrada;
  if (modoDoDestinoDoAviso(config) === "responsavel" && carregaMundo) {
    try {
      const mundo = await carregaMundo({ organizationId, conversationId, contactId });
      return destinoDoAvisoComMundo(config, mundo);
    } catch (err) {
      logger.warn(`[aviso-de-${aviso}] destino do responsável não pôde ser lido; usando o número da empresa`, {
        organizationId,
        causa: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return destinoDoAvisoComMundo(config, {
    conversa: null,
    negocio: null,
    contato: null,
    whatsapps: new Map(),
  });
}
