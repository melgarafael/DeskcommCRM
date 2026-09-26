/**
 * Gestão das definições aprovadas pelo parceiro Graph-compatível — listar,
 * criar, editar e apagar.
 *
 * O parceiro expõe a MESMA Cloud API da Meta, então os endpoints de modelo são
 * os dela (`/{waba_id}/message_templates`), com o host e o token do parceiro.
 * Os `components` chegam prontos em MAIÚSCULA (`BODY`, `HEADER`…) — que é como a
 * Graph espera — e viajam crus, porque são a entrada de quem deriva o contrato.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ChannelTemplate,
  ChannelTemplateDraft,
  ChannelTemplateOps,
  ChannelTenantScope,
} from "../types";
import { graphPartnerGraphBase, resolveGraphPartnerCreds } from "./credentials";

/** A forma que a Graph devolve. */
interface RawTemplate {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string | null;
  components?: unknown[];
  rejected_reason?: string | null;
  parameter_format?: string | null;
  error?: { message?: string };
}

type Escopo = ChannelTenantScope & { sessionRef: string };

/** Organização + número: as duas pontas que identificam a sessão (issue #236). */
async function creds(escopo: Escopo) {
  const c = await resolveGraphPartnerCreds(createAdminClient(), {
    organizationId: escopo.organizationId,
    phoneNumberId: escopo.sessionRef,
  });
  if (!c) throw new Error("graph_partner_not_configured: sem token para esta conexão.");
  if (!c.wabaId) throw new Error("graph_partner_sem_waba: a conexão não tem conta (WABA).");
  return c;
}

function toNeutral(t: RawTemplate | null): ChannelTemplate {
  const componentes = t?.components;
  return {
    name: t?.name ?? "",
    language: t?.language ?? "",
    // Vocabulário ABERTO: a plataforma cria estado novo sem avisar.
    status: t?.status ?? "UNKNOWN",
    category: t?.category ?? null,
    components: Array.isArray(componentes) ? componentes : [],
    rejectedReason: t?.rejected_reason ?? null,
    parameterFormat: t?.parameter_format ?? null,
  };
}

async function lerJson(res: Response): Promise<RawTemplate | null> {
  return (await res.json().catch(() => null)) as RawTemplate | null;
}

function erroDaGraph(res: Response, json: RawTemplate | null, acao: string): Error {
  return new Error(
    `graph_partner_template_${acao}: ${res.status} ${json?.error?.message ?? ""}`.trim(),
  );
}

function mesmaOrigem(url: string): boolean {
  try {
    return new URL(url).origin === new URL(graphPartnerGraphBase()).origin;
  } catch {
    return false;
  }
}

const CAMPOS_DA_LISTA =
  "name,language,status,category,parameter_format,rejected_reason,quality_score,components";

/**
 * Varre a coleção de modelos, UMA página por vez, até o fim ou até `emCada`
 * pedir para parar.
 *
 * É a MESMA navegação que a lista da tela faz: `paging.next` só é seguido no
 * mesmo host (o token vai no header, e um `next` apontando para fora o
 * entregaria a quem a resposta mandasse) e o teto de páginas fecha o laço se a
 * plataforma devolver sempre o mesmo cursor.
 */
async function varrerModelos(
  c: { wabaId: string; token: string },
  fields: string,
  emCada: (t: RawTemplate) => boolean,
  nome?: string,
): Promise<void> {
  // `name` é filtro DOCUMENTADO da plataforma e devolve o nome em TODOS os
  // idiomas — daí o idioma casar aqui dentro e não no servidor.
  const filtro = nome ? `&name=${encodeURIComponent(nome)}` : "";
  let url: string | null = `${graphPartnerGraphBase()}/${encodeURIComponent(c.wabaId)}/message_templates?limit=100&fields=${fields}${filtro}`;

  for (let pagina = 0; pagina < 50 && url; pagina += 1) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${c.token}` } });
    const json = (await res.json().catch(() => null)) as
      | (RawTemplate & { data?: RawTemplate[]; paging?: { next?: string } })
      | null;
    if (!res.ok || json?.error) throw erroDaGraph(res, json, "failed");
    for (const t of json?.data ?? []) {
      if (!emCada(t)) return;
    }
    const proxima = json?.paging?.next;
    url = proxima && proxima !== url && mesmaOrigem(proxima) ? proxima : null;
  }
}

/**
 * O id da UMA variante — nome e idioma JUNTOS.
 *
 * A plataforma numera cada variante de idioma por conta própria: o mesmo
 * `name` em `pt_BR` e `en_US` são DOIS ids, e é por eles que se fala com uma
 * só (`POST /{template_id}` para editar, `DELETE …&hsm_id=` para
 * apagar). Sem o id a
 * única chave que sobra é o nome — e por nome o DELETE leva TODAS as variantes
 * (#1734), que é o defeito que este helper existe para fechar.
 *
 * Sem a variante não há id, e SEM ID A OPERAÇÃO NÃO SAI DO LUGAR: o adapter
 * lança com o motivo, em vez de chamar a plataforma no escuro.
 */
async function idDaVariante(
  c: { wabaId: string; token: string },
  name: string,
  language: string,
): Promise<string> {
  const achados: string[] = [];
  await varrerModelos(
    c,
    "id,name,language",
    (t) => {
      if (t.id && t.name === name && t.language === language) {
        achados.push(t.id);
        return false;
      }
      return true;
    },
    name,
  );
  const id = achados[0];
  if (!id) {
    throw new Error(
      `graph_partner_template_variante_ausente: ${name} (${language}) não está nesta conta.`,
    );
  }
  return id;
}

export const graphPartnerTemplateOps: ChannelTemplateOps = {
  async list({ organizationId, sessionRef }): Promise<ChannelTemplate[]> {
    const c = await creds({ organizationId, sessionRef });
    const todos: ChannelTemplate[] = [];
    await varrerModelos(c, CAMPOS_DA_LISTA, (t) => {
      todos.push(toNeutral(t));
      return true;
    });
    return todos;
  },

  async create({ organizationId, sessionRef, draft }): Promise<ChannelTemplate> {
    const c = await creds({ organizationId, sessionRef });
    return postar(c, `/${encodeURIComponent(c.wabaId)}/message_templates`, {
      name: draft.name,
      language: draft.language,
      category: draft.category,
      components: draft.components,
      ...(draft.parameterFormat ? { parameter_format: draft.parameterFormat } : {}),
    });
  },

  /**
   * Edita a VARIANTE, endereçada pelo id: `POST /{template_id}` — o caminho da
   * edição é SÓ o id, sem o waba_id (OpenAPI `editar-template`), e não a
   * coleção.
   *
   * Antes era um POST na coleção só com o nome — com duas variantes de idioma
   * dava para errar a tradução sem nenhum aviso, e não se sabia se a chamada
   * falhava ou mirava a variante errada (#1734). Nome e idioma entram aqui só
   * para ACHAR o id: a plataforma não os deixa mudar, porque são eles que
   * identificam a linha.
   */
  async update({ organizationId, sessionRef, name, language, patch }): Promise<ChannelTemplate> {
    const c = await creds({ organizationId, sessionRef });
    const id = await idDaVariante(c, name, language);
    const editado = await postar(c, `/${encodeURIComponent(id)}`, {
      ...(patch.category ? { category: patch.category } : {}),
      ...(patch.components ? { components: patch.components } : {}),
    });
    // O nó devolve `id/name/category` sem o idioma — ele identifica a variante
    // e não muda —, então ele vem de quem chamou e o escolheu na tela.
    return { ...editado, language };
  },

  /**
   * Apaga UMA variante: o id dela em `hsm_id`, o nome em `name`.
   *
   * Medido na documentação da própria plataforma (Datafy,
   * `api-reference/whatsapp/templates/deletar-template`): sem `hsm_id` o
   * DELETE remove TODOS os idiomas daquele nome; com `hsm_id` "apenas aquela
   * versão é removida, e o `name` continua obrigatório" — por isso os dois
   * viajam juntos. O id é resolvido ANTES: se a variante não está na conta,
   * isto lança e nada é apagado, em vez de cair no nome só (#1734).
   */
  async remove({ organizationId, sessionRef, name, language }): Promise<void> {
    const c = await creds({ organizationId, sessionRef });
    const id = await idDaVariante(c, name, language);
    const url = `${graphPartnerGraphBase()}/${encodeURIComponent(c.wabaId)}/message_templates?name=${encodeURIComponent(name)}&hsm_id=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${c.token}` },
    });
    if (!res.ok) throw erroDaGraph(res, await lerJson(res), "failed");
  },
};

/**
 * POST num caminho da API do parceiro, relativo à base: `/{waba}/message_templates`
 * para criar e `/{template_id}` para editar — este SEM o waba_id, que a
 * plataforma não quer no caminho da edição. Devolve o que ela devolver
 * (pode vir vazio).
 */
async function postar(
  c: { token: string },
  caminho: string,
  body: Record<string, unknown>,
): Promise<ChannelTemplate> {
  const url = `${graphPartnerGraphBase()}${caminho}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await lerJson(res);
  if (!res.ok || json?.error) throw erroDaGraph(res, json, "failed");
  return toNeutral(json);
}

export type { ChannelTemplate, ChannelTemplateDraft };
