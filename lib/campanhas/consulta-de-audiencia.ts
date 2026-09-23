/**
 * O recorte virando linhas — a única peça do módulo de audiência que fala com o
 * banco.
 *
 * Fica separada de `audiencia.ts` (que é o filtro, puro) porque a prévia e o
 * snapshot chamam AS DUAS, e é o par que garante que os dois caminhos vejam o
 * mesmo recorte. Se um dia a prévia e o envio divergirem, a divergência estará
 * aqui, num arquivo só.
 *
 * `organization_id` entra em TODA consulta, explicitamente: o client admin
 * ignora RLS, e é ele que este módulo recebe (a prévia roda numa rota com papel
 * conferido; o snapshot roda no worker, que não tem usuário).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CAMPANHAS_VIVAS, limiteDeSilencio, usaNegocio, type FiltroDeAudiencia } from "./audiencia";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { recusouMarketing, type CandidatoDaAudiencia } from "./elegibilidade";

/** Teto de ids que um filtro de negócio devolve antes de virar `in (...)`. */
const TETO_DE_IDS_DE_NEGOCIO = 20_000;

interface LinhaDeContato {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_blocked: boolean;
  is_anonymized: boolean;
  consent: unknown;
}

export async function buscarCandidatos(
  admin: SupabaseClient,
  entrada: { organizationId: string; filtro: FiltroDeAudiencia; agora: Date },
): Promise<CandidatoDaAudiencia[]> {
  const { organizationId, filtro, agora } = entrada;

  // ─── Os contatos que têm negócio no recorte ───
  // Consulta separada, e não `join` embutido do PostgREST: o mesmo contato tem N
  // negócios, e o embed devolveria o contato N vezes — contagem de prévia
  // inflada, que é exatamente o número que o operador confere antes de apertar.
  let idsPorNegocio: string[] | null = null;
  if (usaNegocio(filtro)) {
    let negocios = admin
      .from("crm_leads")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .not("contact_id", "is", null)
      .limit(TETO_DE_IDS_DE_NEGOCIO);
    if (filtro.funis.length > 0) negocios = negocios.in("pipeline_id", filtro.funis);
    if (filtro.etapas.length > 0) negocios = negocios.in("stage_id", filtro.etapas);
    if (filtro.responsaveis.length > 0) negocios = negocios.in("owner_user_id", filtro.responsaveis);
    if (filtro.situacoes_do_negocio.length > 0) {
      negocios = negocios.in("status", filtro.situacoes_do_negocio);
    }
    const { data, error } = await negocios;
    if (error) throw new Error(`audiência: negócios — ${error.message}`);
    idsPorNegocio = [...new Set((data ?? []).map((l) => (l as { contact_id: string }).contact_id))];
    // Recorte de negócio que não achou ninguém é recorte vazio, não recorte
    // ausente: seguir sem o `in` devolveria a organização inteira.
    if (idsPorNegocio.length === 0) return [];
  }

  let consulta = admin
    .from("contacts")
    .select("id, name, display_name, phone_number, is_blocked, is_anonymized, consent")
    .eq("organization_id", organizationId)
    // Cadastro mesclado é fantasma: quem responde é o sobrevivente.
    .is("is_merged_into", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(filtro.limite);

  if (idsPorNegocio) consulta = consulta.in("id", idsPorNegocio);
  if (filtro.com_todas_tags.length > 0) consulta = consulta.contains("tags", filtro.com_todas_tags);
  if (filtro.com_alguma_tag.length > 0) consulta = consulta.overlaps("tags", filtro.com_alguma_tag);
  if (filtro.sem_tags.length > 0) {
    consulta = consulta.not("tags", "ov", `{${filtro.sem_tags.map(citar).join(",")}}`);
  }
  if (filtro.origens.length > 0) consulta = consulta.in("source", filtro.origens);
  if (filtro.sem_interacao_ha_dias !== null) {
    const limite = limiteDeSilencio(filtro.sem_interacao_ha_dias, agora).toISOString();
    // Quem nunca interagiu ENTRA no recorte de silêncio: `last_activity_at` nulo
    // é o silêncio mais longo que existe, e deixá-lo de fora tiraria justamente
    // a lista fria — que é o caso de uso principal da campanha.
    consulta = consulta.or(`last_activity_at.is.null,last_activity_at.lt.${limite}`);
  }
  if (filtro.com_interacao_ha_dias !== null) {
    consulta = consulta.gte(
      "last_activity_at",
      limiteDeSilencio(filtro.com_interacao_ha_dias, agora).toISOString(),
    );
  }
  if (filtro.cadastrado_de) consulta = consulta.gte("created_at", filtro.cadastrado_de);
  if (filtro.cadastrado_ate) consulta = consulta.lte("created_at", filtro.cadastrado_ate);
  if (filtro.excluir_contatos.length > 0) {
    consulta = consulta.not("id", "in", `(${filtro.excluir_contatos.join(",")})`);
  }

  const { data, error } = await consulta;
  if (error) throw new Error(`audiência: contatos — ${error.message}`);
  const linhas = (data ?? []) as LinhaDeContato[];

  // ─── Os incluídos à mão ───
  // Entram mesmo fora do recorte, e por isso vêm em consulta própria; os vetos
  // por pessoa continuam valendo para eles (incluir à mão não fura opt-out).
  const jaTem = new Set(linhas.map((l) => l.id));
  const faltam = filtro.incluir_contatos.filter((id) => !jaTem.has(id));
  if (faltam.length > 0) {
    const { data: extras, error: erroExtras } = await admin
      .from("contacts")
      .select("id, name, display_name, phone_number, is_blocked, is_anonymized, consent")
      .eq("organization_id", organizationId)
      .in("id", faltam);
    if (erroExtras) throw new Error(`audiência: incluídos — ${erroExtras.message}`);
    linhas.push(...((extras ?? []) as LinhaDeContato[]));
  }

  return linhas.map((l) => ({
    contactId: l.id,
    nome: nomeDoContato(l),
    telefone: l.phone_number,
    bloqueado: l.is_blocked,
    anonimizado: l.is_anonymized,
    recusouMarketing: recusouMarketing(l.consent),
  }));
}


/**
 * Quem já está em campanha VIVA desta organização.
 *
 * Opcionalmente ignora uma campanha (a que está sendo preparada): sem isso, uma
 * preparação repetida excluiria como "já em campanha" os destinatários que ela
 * mesma gravou na tentativa anterior.
 */
export async function contatosJaEmCampanha(
  admin: SupabaseClient,
  organizationId: string,
  exceto?: string,
): Promise<Set<string>> {
  let vivas = admin
    .from("campaigns")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", CAMPANHAS_VIVAS);
  if (exceto) vivas = vivas.neq("id", exceto);
  const { data: campanhas, error } = await vivas;
  if (error) throw new Error(`audiência: campanhas vivas — ${error.message}`);
  const ids = (campanhas ?? []).map((c) => (c as { id: string }).id);
  if (ids.length === 0) return new Set();

  const { data, error: erroDest } = await admin
    .from("campaign_recipients")
    .select("contact_id")
    .eq("organization_id", organizationId)
    .in("campaign_id", ids);
  if (erroDest) throw new Error(`audiência: comprometidos — ${erroDest.message}`);
  return new Set((data ?? []).map((r) => (r as { contact_id: string }).contact_id));
}

/** Aspas para o literal de array do Postgres — etiqueta com vírgula quebraria o `{a,b}`. */
function citar(valor: string): string {
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
