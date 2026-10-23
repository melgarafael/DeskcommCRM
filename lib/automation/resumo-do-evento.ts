/**
 * O resumo da equipe LIDO DO MUNDO, no momento do disparo (#2642).
 *
 * ─── Por que este arquivo existe, separado do texto ────────────────────────
 *
 * `resumo-para-a-equipe.ts` é a função PURA que monta o texto; este módulo é
 * quem LÊ o banco (pontuação, idioma) e entrega os fatos para ela.
 * A separação é a mesma de `texto-do-aviso` × `aviso-ao-suporte`: o texto é
 * testável sem rede, e a leitura é testável com o dublê de PostgREST.
 *
 * ─── Por que as DUAS ações usam o MESMO carregador ─────────────────────────
 *
 * O recorte do mantenedor no PR #2834 deixou uma coisa só em cada lugar: o
 * WhatsApp da equipe (`notify_team`, sem destinatário escolhido) e o e-mail
 * (`send_email`, com o destinatário "membro da equipe" e a variável
 * `{{resumo}}`). Se cada ação montasse o resumo por conta própria, a mesma
 * frase teria duas réguas de limpeza e dois jeitos de ler a pontuação — que é
 * exatamente o defeito que o recorte veio matar.
 *
 * ─── O resumo é LIDO AGORA, nunca gravado ─────────────────────────────────
 *
 * Nada de texto fixo na regra: `lead`, `contact` e a pontuação NUMÉRICA são
 * lidos no disparo. O que a IA escreveu a partir da conversa (motivo da
 * pontuação, checkpoint, descrição, motivo do ganho, título) NÃO é lido aqui —
 * decisão do dono, doc 176 (A): esse texto fica no registro do lead e não vai
 * na mensagem. Ver o cabeçalho de `resumo-para-a-equipe.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { linkDoNegocio, urlPublicaUsavel } from "@/lib/escalacao/url-publica";
import { IDIOMAS, type Idioma } from "@/lib/i18n/idiomas";

import {
  montarResumoParaAEquipe,
  type ContatoDoResumo,
  type LeadDoResumo,
} from "./resumo-para-a-equipe";

type Admin = SupabaseClient;

/**
 * Contexto de um evento: o motor monta `lead` e `contact` (`buildContext`),
 * mas o tipo é `Record<string, unknown>` — então quem lê tem de estreitar com
 * as MESMAS colunas que o banco devolve, e só as de forma fixa.
 */
export function leadDoContexto(bruto: unknown): (LeadDoResumo & { id: string }) | null {
  if (typeof bruto !== "object" || bruto === null) return null;
  const l = bruto as Record<string, unknown>;
  if (typeof l.id !== "string" || l.id === "") return null;
  return {
    id: l.id,
    value_cents: typeof l.value_cents === "number" ? l.value_cents : null,
    currency: typeof l.currency === "string" ? l.currency : null,
  };
}

export function contatoDoContexto(bruto: unknown): ContatoDoResumo | null {
  if (typeof bruto !== "object" || bruto === null) return null;
  const c = bruto as Record<string, unknown>;
  return {
    name: typeof c.name === "string" ? c.name : null,
    display_name: typeof c.display_name === "string" ? c.display_name : null,
    phone_number: typeof c.phone_number === "string" ? c.phone_number : null,
  };
}

/** `organizations.locale` pode trazer o que for; o catálogo decide o que é idioma. */
async function idiomaDaOrganizacao(admin: Admin, organizationId: string): Promise<Idioma> {
  const { data } = await admin.from("organizations").select("locale").eq("id", organizationId).maybeSingle();
  const bruto = (data as { locale?: string | null } | null)?.locale;
  return typeof bruto === "string" && (IDIOMAS as readonly string[]).includes(bruto)
    ? (bruto as Idioma)
    : "pt-BR";
}

/** `crm_lead_scores.ai_probability` — só o número (`integer`, 0 a 100). */
async function pontuacaoDoLead(admin: Admin, organizationId: string, leadId: string): Promise<number | null> {
  const { data } = await admin
    .from("crm_lead_scores")
    .select("ai_probability")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .maybeSingle();
  const numero = (data as { ai_probability?: number | null } | null)?.ai_probability;
  return typeof numero === "number" ? numero : null;
}

/**
 * O resumo pronto, ou `null` quando o evento não traz negócio.
 *
 * `null` e não string vazia porque as duas coisas querem dizer coisas
 * diferentes na tela: sem lead é "este evento não tem negócio", e resumo vazio
 * seria "o negócio não tem nada a dizer" — quem opera conserta um cadastro, não
 * o outro.
 */
export async function carregarResumoParaAEquipe(entrada: {
  admin: Admin;
  organizationId: string;
  /** `rule.name` — o nome que o operador deu à regra que disparou. */
  regra: string;
  /** O contexto cru do evento (`ctx.context`). */
  contexto: Record<string, unknown>;
}): Promise<string | null> {
  const { admin, organizationId, contexto } = entrada;
  const lead = leadDoContexto(contexto.lead);
  if (lead === null) return null;

  // Sem endereço público (o padrão `localhost`, o placeholder do build) não há
  // atalho: um link que não abre no celular é pior que nenhum.
  const base = env.NEXT_PUBLIC_APP_URL;
  return montarResumoParaAEquipe({
    idioma: await idiomaDaOrganizacao(admin, organizationId),
    regra: entrada.regra,
    lead,
    contato: contatoDoContexto(contexto.contact),
    pontuacao: await pontuacaoDoLead(admin, organizationId, lead.id),
    link: urlPublicaUsavel(base) ? linkDoNegocio(base, lead.id) : null,
  });
}
