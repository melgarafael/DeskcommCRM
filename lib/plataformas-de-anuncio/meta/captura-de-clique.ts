/**
 * O par ref↔UTM: criado quando alguém clica no botão da landing page (a rota
 * `app/api/v1/anuncios/meta/[org]/route.ts`), consumido quando a mensagem do
 * WhatsApp chega com o ref no texto.
 *
 * Mora aqui, e não em `lib/leads/`, pela mesma razão do irmão do Google: o
 * DADO é o da captura de anúncio, e esta pasta é a segunda fronteira que
 * `lib/plataformas-de-anuncio/types.ts` declara. O MECANISMO do ref (alfabeto,
 * tamanho, retentativa, padrão no texto) é compartilhado em
 * `../captura-de-clique.ts`.
 *
 * Só a metade de CONSUMO vive aqui — a de criação é a genérica, chamada
 * direto pela rota com a tabela como parâmetro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { desfazerOrigemDeduzida } from "@/lib/leads/origem-por-horario";
import { logger } from "@/lib/logger";

export interface ClickRefDaPaginaCasado {
  /** Só chaves de `CHAVES_DE_UTM`, como a rota as normalizou antes de gravar. */
  utm: Record<string, string>;
}

/**
 * Casa um ref com um contato — a UPDATE condicional que garante que um clique
 * só é consumido UMA vez. `matched_at is null` no WHERE é a trava: o mesmo
 * texto encaminhado adiante não vira atribuição de quem o recebeu, porque a
 * segunda tentativa não encontra o que atualizar.
 *
 * `organization_id` no WHERE é a lição da #236: ref de uma organização nunca
 * pode casar na outra.
 *
 * O clique pode estar RESERVADO por dedução para outro contato
 * (`contact_id` preenchido, `matched_at` nulo — ver
 * `lib/leads/origem-por-horario.ts`). O código é a prova e vence: o clique
 * passa a ser de quem o trouxe, e a origem deduzida do outro é desfeita. Sem
 * isso, um clique virava origem de dois contatos.
 */
export async function casarClickRef(
  admin: SupabaseClient,
  organizationId: string,
  token: string,
  contactId: string,
): Promise<ClickRefDaPaginaCasado | null> {
  // Quem a dedução tinha posto no clique, lido ANTES do consumo (o UPDATE
  // troca o `contact_id`). O token é único por organização, então o
  // `matched_at` é conferido aqui, não no filtro.
  // ponytail: dedução que reserve ENTRE esta leitura e o UPDATE escapa; a
  // janela é de milissegundos, e fechá-la pediria uma função no banco.
  const { data: antes, error: erroDaReserva } = await admin
    .from("meta_ads_click_refs")
    .select("contact_id, matched_at")
    .eq("organization_id", organizationId)
    .eq("token", token)
    .maybeSingle();
  // O consumo segue: a prova vale mesmo sem saber quem a dedução tinha posto.
  if (erroDaReserva) {
    logger.warn("[meta.captura-de-clique] leitura da reserva por dedução falhou", {
      organizationId,
      detalhe: erroDaReserva.message,
    });
  }
  const reserva = antes as { contact_id?: string | null; matched_at?: string | null } | null;
  const deduzidoPara =
    reserva && reserva.matched_at == null && reserva.contact_id && reserva.contact_id !== contactId
      ? reserva.contact_id
      : null;

  const { data, error } = await admin
    .from("meta_ads_click_refs")
    .update({ matched_at: new Date().toISOString(), contact_id: contactId })
    .eq("organization_id", organizationId)
    .eq("token", token)
    .is("matched_at", null)
    .select("utm")
    .maybeSingle();

  if (error) {
    logger.error("[meta.captura-de-clique] update de match falhou", {
      organizationId,
      codigo: error.code,
      detalhe: error.message,
    });
    return null;
  }
  if (!data) return null;

  const utm = (data as { utm: Record<string, string> | null }).utm;
  // A coluna é `not null` com `check (utm <> '{}')`, então isto é defesa de
  // borda, não caso esperado: linha sem UTM não teria o que estampar.
  if (!utm || Object.keys(utm).length === 0) return null;
  if (deduzidoPara) await desfazerOrigemDeduzida(admin, organizationId, deduzidoPara);
  return { utm };
}
