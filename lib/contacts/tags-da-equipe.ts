/**
 * TAGS DE CONTATO DA EQUIPE (#3534) — a régua de "quem é da equipe, mas
 * continua sendo atendido".
 *
 * ═══ Por que esta régua é separada da interna ═══
 *
 * `lib/contacts/tags-internas.ts` (#2353) responde "este contato não é
 * negócio": com uma etiqueta da lista interna o contato NÃO vira card e a IA
 * NÃO responde. Isso serve para fornecedor e família — e NÃO serve para o
 * sócio que testa o agente pelo próprio número e cobra a resposta. Marcá-lo
 * como interno faz o agente parar de falar com ele, que é o oposto do pedido.
 *
 * A régua da equipe significa só uma coisa: **o atendimento continua, o repasse
 * automático não acontece**. Concretamente, contato com uma etiqueta de
 * `organizations.settings.crm.team_contact_tags`:
 *
 *   1. é atendido pela IA como qualquer contato: segue a régua do canal (em
 *      `allowlist`/pré-go-live, só a lista de teste autoriza — a etiqueta da
 *      equipe não abre o canal), e a etiqueta não é veto;
 *   2. é medido e registrado pelo medidor de clima, como qualquer conversa;
 *   3. NÃO é passado a humano por clima (`low_sentiment`) — e, por não ser
 *      passado, não é silenciado (`bot_silenced_until = 'infinity'`).
 *
 * ═══ Uma forma, dois significados, zero migration ═══
 *
 * A comparação é a MESMA das etiquetas internas — `normalizarTags`
 * (`./tag-normalizada`): minúscula, aparada, sem repetição, teto de 40. O que
 * muda é a lista lida e o que o chamador faz com a resposta. As duas listas
 * moram em `settings.crm` porque `settings` é jsonb e a linha já existe: não há
 * coluna nem tabela nova a criar.
 *
 * ═══ Fail-open, e por quê ═══
 *
 * Leitura que falha devolve lista vazia ("ninguém é da equipe"). O desfecho é o
 * comportamento de antes desta chave existir — o medidor volta a poder passar o
 * contato por clima —, que é conservador do ponto de vista de quem opera (um
 * humano é chamado a mais, nunca a menos) e nunca bloqueia a ingestão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { tagsDaEquipeDaOrg } from "@/lib/schemas/settings";

import { normalizarTags } from "./tag-normalizada";

/**
 * O contato tem alguma etiqueta da lista da equipe?
 *
 * Normaliza os DOIS lados pela mesma régua do banco, como `ehContatoInterno`:
 * `Socio`/`socio` e ` sócio ` casam; lista vazia (ou nenhuma tag) não marca
 * ninguém.
 */
export function ehContatoDaEquipe(
  tagsDoContato: readonly string[] | null | undefined,
  tagsDaEquipe: readonly string[] | null | undefined,
): boolean {
  const daEquipe = new Set(normalizarTags(tagsDaEquipe ?? []));
  if (daEquipe.size === 0) return false;
  return normalizarTags(tagsDoContato ?? []).some((tag) => daEquipe.has(tag));
}

/**
 * Lê a lista da equipe da organização (servidor, service role).
 *
 * `organizationId` vem sempre de fonte confiável (o chamador já filtrou por
 * ela). Falha devolve lista vazia — o contato segue o caminho de antes.
 */
export async function lerTagsDaEquipe(
  db: SupabaseClient,
  organizationId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    logger.warn("[tags-da-equipe] leitura da lista falhou", {
      organization_id: organizationId,
      error: error.message,
    });
    return [];
  }
  if (!data) return [];
  return tagsDaEquipeDaOrg((data as { settings?: unknown }).settings);
}
