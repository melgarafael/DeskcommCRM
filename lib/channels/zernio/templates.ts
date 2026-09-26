/**
 * Gestão das definições aprovadas pelo canal intermediado — criar, editar,
 * apagar, listar.
 *
 * ─── Por que isto existe, e por que não é "portar o que a Meta já faz" ──────
 *
 * O repo hoje só ESPELHA templates (`../meta/template-sync.ts` diz, em letra
 * grande, "não cria, não edita e não é dono de nada"). Para criar um, o
 * operador tem que sair do CRM e entrar no painel da plataforma. Este módulo é
 * a metade que faltava — e a `ChannelTemplateOps` é neutra de propósito, para
 * que o canal oficial possa ganhar a mesma coisa sem uma segunda interface.
 *
 * ─── A confusão que vale evitar ─────────────────────────────────────────────
 *
 * As definições NÃO vivem no intermediário: vivem na MESMA WABA da Meta. O
 * intermediário é outra porta para o mesmo armário — medido na conta real, cuja
 * `wabaId` é a mesma que a do canal oficial. Consequência prática: um template
 * criado por aqui aparece no painel da Meta, entra na fila de revisão DELA, e o
 * espelho local (`meta_templates`) continua sendo o espelho certo. Tratar isto
 * como um segundo catálogo criaria duas fontes da verdade para a mesma linha.
 *
 * ─── Formato ────────────────────────────────────────────────────────────────
 *
 * `components` viaja CRU na LEITURA — é a entrada de `deriveTemplateContract`, e
 * normalizá-lo criaria o "derivado guardado" que a fase do contract_hash existe
 * para eliminar. Na ESCRITA há uma única exceção, medida contra a API e
 * documentada em `paraEscrita`: a chave `type`.
 */
import type {
  ChannelTemplate,
  ChannelTemplateDraft,
  ChannelTemplateOps,
  ChannelTenantScope,
} from "../types";

import { resolveZernioCreds } from "./credentials";
import { createAdminClient } from "@/lib/supabase/admin";

/** A forma que a API devolve, traduzida para o vocabulário neutro. */
interface RawTemplate {
  name?: string;
  language?: string;
  status?: string;
  category?: string | null;
  components?: unknown[];
  rejected_reason?: string | null;
  rejectedReason?: string | null;
  parameter_format?: string | null;
  parameterFormat?: string | null;
}

function toNeutral(t: RawTemplate): ChannelTemplate {
  return {
    name: t.name ?? "",
    language: t.language ?? "",
    // Vocabulário ABERTO: a plataforma cria estado novo sem avisar, e um
    // `as const` aqui viraria erro de runtime no dia em que ela inventar um.
    status: t.status ?? "UNKNOWN",
    category: t.category ?? null,
    components: Array.isArray(t.components) ? t.components : [],
    rejectedReason: t.rejected_reason ?? t.rejectedReason ?? null,
    parameterFormat: t.parameter_format ?? t.parameterFormat ?? null,
  };
}

/**
 * A assimetria medida na API: ela DEVOLVE `type` em maiúscula (`"BODY"`) e só
 * ACEITA em minúscula na escrita —
 *
 *   400 Invalid discriminator value. Expected 'header' | 'body' | 'footer' | …
 *
 * Sem normalizar, o ciclo natural (ler um template, editar o texto, gravar de
 * volta) falha SEMPRE, porque o que saiu da leitura não entra na escrita. É o
 * tipo de defeito que teste com mock nunca encontra: o mock devolve o que quem
 * o escreveu imaginou.
 *
 * Normaliza só a chave `type` e só no nível que a API discrimina — o resto de
 * `components` continua viajando cru, porque é a entrada de quem deriva o
 * contrato e mexer nele criaria o "derivado guardado" que a fase do
 * contract_hash existe para eliminar.
 */
function paraEscrita(components: unknown[]): unknown[] {
  return components.map((c) => {
    if (!c || typeof c !== "object") return c;
    const obj = c as Record<string, unknown>;
    return typeof obj.type === "string" ? { ...obj, type: obj.type.toLowerCase() } : obj;
  });
}

/** Organização + conta: as DUAS pontas que identificam uma sessão (issue #236). */
type EscopoDaConta = ChannelTenantScope & { sessionRef: string };

/**
 * A conta é buscada DENTRO da organização: `zernio_account_id` é identificador
 * do provider e não é único por si só — ver o cabeçalho de `./credentials`
 * (issue #236).
 */
async function creds(escopo: EscopoDaConta) {
  const c = await resolveZernioCreds(createAdminClient(), {
    organizationId: escopo.organizationId,
    accountId: escopo.sessionRef,
  });
  if (!c) throw new Error("zernio_not_configured: sem credencial para esta conta.");
  return c;
}

/**
 * Chamada autenticada, com o erro da plataforma preservado.
 *
 * O `code` entra na mensagem quando existe: é ele que distingue "nome já
 * usado" de "categoria inválida" de "WABA não elegível". Sem propagá-lo, a
 * tela mostra "falhou ao criar" e o operador não tem o que corrigir.
 */
async function call<T>(
  escopo: EscopoDaConta,
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const c = await creds(escopo);
  const qs = new URLSearchParams({ accountId: c.accountId, ...(init.query ?? {}) });
  const res = await fetch(`${c.baseUrl}${path}?${qs}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify({ accountId: c.accountId, ...init.body }) } : {}),
  });

  const json = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; code?: string; success?: boolean })
    | null;

  if (!res.ok || json?.success === false) {
    const detalhe = json?.code ? `${json.code}: ${json.error ?? ""}` : (json?.error ?? res.statusText);
    throw new Error(`zernio_template_failed: ${res.status} ${detalhe}`.trim());
  }
  return json as T;
}

export const zernioTemplateOps: ChannelTemplateOps = {
  async list({ organizationId, sessionRef }): Promise<ChannelTemplate[]> {
    const j = await call<{ templates?: RawTemplate[] }>(
      { organizationId, sessionRef },
      "/v1/whatsapp/templates",
      { method: "GET" },
    );
    return (j.templates ?? []).map(toNeutral);
  },

  async create({ organizationId, sessionRef, draft }): Promise<ChannelTemplate> {
    // O nome é validado pela plataforma (`^[a-z][a-z0-9_]*$`) e a recusa vem
    // com código. Não duplicamos a regra aqui: regra copiada é regra que
    // envelhece separado da fonte, e o custo de descobrir tarde é um erro
    // claro em vez de um erro nosso, inventado.
    const j = await call<{ template?: RawTemplate; data?: RawTemplate }>(
      { organizationId, sessionRef },
      "/v1/whatsapp/templates",
      {
        method: "POST",
        body: {
          name: draft.name,
          category: draft.category,
          language: draft.language,
          components: paraEscrita(draft.components),
          ...(draft.parameterFormat ? { parameterFormat: draft.parameterFormat } : {}),
        },
      },
    );
    return toNeutral(j.template ?? j.data ?? (j as RawTemplate));
  },

  /**
   * Medido na plataforma: um template recém-criado está `PENDING` e **não pode
   * ser editado** —
   *
   *   400 Message templates can only be edited if they have been rejected.
   *
   * A regra é da Meta, não do intermediário, e por isso NÃO é replicada aqui:
   * checar `status` antes de chamar significaria adivinhar uma regra que muda
   * sem avisar, e negar uma edição que a plataforma teria aceito. O erro sobe
   * com o texto dela, que é o que diz ao operador o que fazer.
   */
  async update({ organizationId, sessionRef, name, language, patch }): Promise<ChannelTemplate> {
    const j = await call<{ template?: RawTemplate; data?: RawTemplate }>(
      { organizationId, sessionRef },
      `/v1/whatsapp/templates/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        body: {
          // Sempre, não só quando há variantes: o provedor exige com variantes e
          // aceita sem — mandar sempre é o único caminho que nunca edita a
          // variante errada (changelog 28/08).
          language,
          ...(patch.components ? { components: paraEscrita(patch.components) } : {}),
          ...(patch.category ? { category: patch.category } : {}),
        },
      },
    );
    return toNeutral(j.template ?? j.data ?? (j as RawTemplate));
  },

  async remove({ organizationId, sessionRef, name, language }): Promise<void> {
    await call<unknown>(
      { organizationId, sessionRef },
      `/v1/whatsapp/templates/${encodeURIComponent(name)}`,
      // `language` SEMPRE vai: desde 28/08, DELETE por nome sem idioma apaga
      // TODAS as variantes — e a assinatura agora obriga o chamador a escolher.
      { method: "DELETE", query: { language } },
    );
  },
};

export type { ChannelTemplate, ChannelTemplateDraft };
