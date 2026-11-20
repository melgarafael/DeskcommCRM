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
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS, type Idioma } from "@/lib/i18n/idiomas";
import { nomeLegivel } from "@/lib/kanban/nome-do-dono";
import { nomesDosAtendentesCom } from "@/lib/users/nome-do-atendente";

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

/**
 * Quem responde pelo negócio e em que funil ele está — só os IDS, lidos do
 * contexto que o motor já hidratou (`crm_leads.*`). Os nomes vêm do banco.
 */
export function donoEFunilDoContexto(bruto: unknown): {
  ownerKind: string | null;
  ownerUserId: string | null;
  pipelineId: string | null;
} {
  const l = typeof bruto === "object" && bruto !== null ? (bruto as Record<string, unknown>) : {};
  const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    ownerKind: texto(l.owner_kind),
    ownerUserId: texto(l.owner_user_id),
    pipelineId: texto(l.pipeline_id),
  };
}

/**
 * O nome do responsável: o do membro da equipe (a MESMA porta do card do funil,
 * `fn_nomes_dos_membros`, com o e-mail recusado por `nomeLegivel`), ou o rótulo
 * do agente de IA. Nunca lança: sem nome, a linha some.
 */
async function nomeDoResponsavel(
  admin: Admin,
  organizationId: string,
  dono: { ownerKind: string | null; ownerUserId: string | null },
  idioma: Idioma,
): Promise<string | null> {
  if (dono.ownerKind === "ai") return traduzir("Agente de IA", idioma);
  if (!dono.ownerUserId) return null;
  try {
    const nomes = await nomesDosAtendentesCom(admin, organizationId, [dono.ownerUserId]);
    return nomeLegivel(nomes.get(dono.ownerUserId));
  } catch {
    return null;
  }
}

/** `crm_pipelines.name`, filtrado pela organização à mão (o admin bypassa a RLS). */
async function nomeDoFunil(admin: Admin, organizationId: string, pipelineId: string | null): Promise<string | null> {
  if (!pipelineId) return null;
  try {
    const { data } = await admin
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", organizationId)
      .eq("id", pipelineId)
      .maybeSingle();
    const nome = (data as { name?: string | null } | null)?.name;
    return typeof nome === "string" ? nome : null;
  } catch {
    return null;
  }
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
  const idioma = await idiomaDaOrganizacao(admin, organizationId);
  const dono = donoEFunilDoContexto(contexto.lead);
  const [pontuacao, responsavel, funil] = await Promise.all([
    pontuacaoDoLead(admin, organizationId, lead.id),
    nomeDoResponsavel(admin, organizationId, dono, idioma),
    nomeDoFunil(admin, organizationId, dono.pipelineId),
  ]);
  return montarResumoParaAEquipe({
    idioma,
    regra: entrada.regra,
    lead,
    contato: contatoDoContexto(contexto.contact),
    pontuacao,
    link: urlPublicaUsavel(base) ? linkDoNegocio(base, lead.id) : null,
    responsavel,
    funil,
  });
}
