/**
 * Leituras de SKILLS POR AGENTE (migration 9107) para as telas.
 *
 * Duas perguntas, cada uma com uma tela que depende dela:
 *
 *  - `skillsDisponiveis` — o que a tela do agente oferece para marcar. É a MESMA
 *    resolução do runtime (`loadSkills`): ponteiros da organização e de plataforma,
 *    um por nome, com a da organização vencendo, em ordem de nome.
 *  - `agentesComListaPropria` — quem NÃO recebe uma skill instalada agora. Sem isto
 *    o aviso "já vale para os agentes desta organização" fica falso para o agente
 *    que escolheu as suas, e o dono só descobre no atendimento.
 *
 * Recebem o client do chamador; o filtro de organização é explícito nas duas.
 * Erro de leitura LANÇA: uma lista vazia por falha diria "nenhuma skill" ou
 * "nenhum agente restrito", que são afirmações falsas sobre a organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { temPonteiroCanonico } from "./ponteiro-canonico";

export interface SkillDisponivel {
  name: string;
  description: string;
}

export interface AgenteComListaPropria {
  id: string;
  name: string;
  skill_names: string[];
}

export async function skillsDisponiveis(
  db: SupabaseClient,
  organizationId: string,
): Promise<SkillDisponivel[]> {
  const { data: ponteiros, error: erroPonteiros } = await db
    .from("skill_pointers")
    .select("organization_id, name, version_id")
    .or(`organization_id.eq.${organizationId},organization_id.is.null`);
  if (erroPonteiros) throw new Error(`skills_disponiveis: ${erroPonteiros.message}`);
  const canonicos = (
    (ponteiros ?? []) as Array<{
      organization_id: string | null;
      name: string | null;
      version_id: string | null;
    }>
  ).filter(temPonteiroCanonico);
  if (canonicos.length === 0) return [];

  const { data: versoes, error: erroVersoes } = await db
    .from("skill_versions")
    .select("id, description")
    .in("id", [...new Set(canonicos.map((p) => p.version_id))]);
  if (erroVersoes) throw new Error(`skills_disponiveis: ${erroVersoes.message}`);
  const descricao = new Map(
    ((versoes ?? []) as Array<{ id: string; description: string }>).map((v) => [v.id, v.description]),
  );

  // A da organização vence a de plataforma no mesmo nome — a regra de `loadSkills`.
  const porNome = new Map<string, { daOrg: boolean; skill: SkillDisponivel }>();
  for (const p of canonicos) {
    const daOrg = p.organization_id !== null;
    if (porNome.get(p.name)?.daOrg === true && !daOrg) continue;
    porNome.set(p.name, {
      daOrg,
      skill: { name: p.name, description: descricao.get(p.version_id) ?? "" },
    });
  }
  return [...porNome.values()]
    .map((x) => x.skill)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Agentes vivos cuja versão PUBLICADA tem lista própria de skills (não `null`). */
export async function agentesComListaPropria(
  db: SupabaseClient,
  organizationId: string,
): Promise<AgenteComListaPropria[]> {
  const { data: agentes, error: erroAgentes } = await db
    .from("ai_agents")
    .select("id, name, published_version_id")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .not("published_version_id", "is", null);
  if (erroAgentes) throw new Error(`agentes_com_lista_propria: ${erroAgentes.message}`);
  const vivos = (agentes ?? []) as Array<{
    id: string;
    name: string;
    published_version_id: string;
  }>;
  if (vivos.length === 0) return [];

  const { data: versoes, error: erroVersoes } = await db
    .from("ai_agent_versions")
    .select("id, skill_names")
    .eq("organization_id", organizationId)
    .in(
      "id",
      vivos.map((a) => a.published_version_id),
    )
    .not("skill_names", "is", null);
  if (erroVersoes) throw new Error(`agentes_com_lista_propria: ${erroVersoes.message}`);
  const listaDaVersao = new Map(
    ((versoes ?? []) as Array<{ id: string; skill_names: string[] }>).map((v) => [v.id, v.skill_names]),
  );
  return vivos.flatMap((a) => {
    const lista = listaDaVersao.get(a.published_version_id);
    return lista === undefined ? [] : [{ id: a.id, name: a.name, skill_names: lista }];
  });
}
