/**
 * Gestão das definições aprovadas pelo parceiro Graph-compatível — listar,
 * criar, editar e apagar.
 *
 * O parceiro expõe a MESMA Cloud API da Meta, então os endpoints de modelo são
 * os dela (`/{waba_id}/message_templates`), com o host e o token do parceiro.
 * Os `components` chegam prontos em MAIÚSCULA (`BODY`, `HEADER`…) — que é como a
 * Graph espera — e viajam crus, porque são a entrada de quem deriva o contrato.
 *
 * ─── Aqui só fica a PONTA ──────────────────────────────────────────────────
 *
 * As chamadas (navegar páginas, resolver o id da variante, mandar o `hsm_id` no
 * DELETE) moraram neste arquivo até a #3635. Quando o canal oficial direto
 * passou a gerenciar modelo pela tela, a escolha era copiar as ~200 linhas com
 * outro token — e a cópia envelhece: a primeira correção de variante/idioma
 * (#1734) valeria de um lado só. O cliente virou
 * `lib/channels/templates-graph.ts`, parametrizado por host/token; o que resta
 * aqui é o que é DESTE canal: de onde vêm a credencial e a base.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { operacoesDeModelos, type CredencialDosModelos } from "../templates-graph";
import type { ChannelTemplate, ChannelTemplateDraft, ChannelTenantScope } from "../types";
import { graphPartnerGraphBase, resolveGraphPartnerCreds } from "./credentials";

type Escopo = ChannelTenantScope & { sessionRef: string };

/** Organização + número: as duas pontas que identificam a sessão (issue #236). */
async function credencial(escopo: Escopo): Promise<CredencialDosModelos> {
  const c = await resolveGraphPartnerCreds(createAdminClient(), {
    organizationId: escopo.organizationId,
    phoneNumberId: escopo.sessionRef,
  });
  if (!c) throw new Error("graph_partner_not_configured: sem token para esta conexão.");
  if (!c.wabaId) throw new Error("graph_partner_sem_waba: a conexão não tem conta (WABA).");
  return { wabaId: c.wabaId, token: c.token };
}

export const graphPartnerTemplateOps = operacoesDeModelos({
  base: graphPartnerGraphBase,
  credencial,
  rotulo: "graph_partner_template",
});

export type { ChannelTemplate, ChannelTemplateDraft };
