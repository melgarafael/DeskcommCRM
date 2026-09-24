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

export const graphPartnerTemplateOps: ChannelTemplateOps = {
  async list({ organizationId, sessionRef }): Promise<ChannelTemplate[]> {
    const c = await creds({ organizationId, sessionRef });
    const fields =
      "name,language,status,category,parameter_format,rejected_reason,quality_score,components";
    let url: string | null = `${graphPartnerGraphBase()}/${encodeURIComponent(c.wabaId)}/message_templates?limit=100&fields=${fields}`;
    const todos: ChannelTemplate[] = [];

    // Paginação por `paging.next` (URL completa). O teto de páginas evita laço
    // infinito se a plataforma devolver sempre o mesmo cursor.
    for (let pagina = 0; pagina < 50 && url; pagina += 1) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${c.token}` } });
      const json = (await res.json().catch(() => null)) as
        | (RawTemplate & { data?: RawTemplate[]; paging?: { next?: string } })
        | null;
      if (!res.ok || json?.error) throw erroDaGraph(res, json, "failed");
      for (const t of json?.data ?? []) todos.push(toNeutral(t));
      const proxima = json?.paging?.next;
      // Só segue a página seguinte no MESMO host: o token vai no header, e um
      // `next` apontando para fora o entregaria a quem a resposta mandasse.
      url = proxima && proxima !== url && mesmaOrigem(proxima) ? proxima : null;
    }
    return todos;
  },

  async create({ organizationId, sessionRef, draft }): Promise<ChannelTemplate> {
    const c = await creds({ organizationId, sessionRef });
    return postMessageTemplate(c, {
      name: draft.name,
      language: draft.language,
      category: draft.category,
      components: draft.components,
      ...(draft.parameterFormat ? { parameter_format: draft.parameterFormat } : {}),
    });
  },

  async update({ organizationId, sessionRef, name, patch }): Promise<ChannelTemplate> {
    const c = await creds({ organizationId, sessionRef });
    // A Graph edita pela MESMA coleção (POST por nome), não por id.
    return postMessageTemplate(c, {
      name,
      ...(patch.category ? { category: patch.category } : {}),
      ...(patch.components ? { components: patch.components } : {}),
    });
  },

  async remove({ organizationId, sessionRef, name }): Promise<void> {
    const c = await creds({ organizationId, sessionRef });
    const url = `${graphPartnerGraphBase()}/${encodeURIComponent(c.wabaId)}/message_templates?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${c.token}` },
    });
    if (!res.ok) throw erroDaGraph(res, await lerJson(res), "failed");
  },
};

/** POST na coleção de modelos; devolve o que a Graph devolver (pode vir vazio). */
async function postMessageTemplate(
  c: { wabaId: string; token: string },
  body: Record<string, unknown>,
): Promise<ChannelTemplate> {
  const url = `${graphPartnerGraphBase()}/${encodeURIComponent(c.wabaId)}/message_templates`;
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
