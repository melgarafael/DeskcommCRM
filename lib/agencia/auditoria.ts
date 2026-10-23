import { headers } from "next/headers";

import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

import { AcessoDaAgenciaNegado } from "./acesso";

/**
 * Auditoria das ações da agência: `organization_id` nulo (é da instalação),
 * request, IP e agente do navegador da requisição corrente. Nunca lança — a
 * auditoria não bloqueia a mutação principal (CLAUDE.md › Audit log).
 */
export async function auditarAgencia(
  action: AuditAction,
  actorUserId: string,
  recurso: { tipo: string; id: string } | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const hdrs = await headers();
  await audit({
    action,
    actorUserId,
    organizationId: null,
    resourceType: recurso?.tipo ?? null,
    resourceId: recurso?.id ?? null,
    metadata,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent") ?? null,
  });
}

/** O formato de resposta das server actions da agência. */
export type ResultadoDaAcao<T = undefined> = ({ ok: true } & (T extends undefined ? object : { dados: T })) | { ok: false; erro: string };

/** A frase que a tela mostra quando o guarda recusa. */
export function erroDeAcesso(e: unknown): { ok: false; erro: string } | null {
  if (e instanceof AcessoDaAgenciaNegado) {
    return {
      ok: false,
      erro: e.codigo === "sem_acesso" ? "Seu acesso à área da agência não está ativo." : "Você não tem permissão para isso.",
    };
  }
  return null;
}
