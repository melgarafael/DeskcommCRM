import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  criarTabelaDeValores,
  listarTabelasDeValores,
} from "@/lib/tabela-de-valores/store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/**
 * TABELAS DE VALORES DE NEGOCIAÇÃO — listar e criar (issue #4612, fatia 1).
 *
 * A tabela é o cabeçalho: um nome e a organização. Os procedimentos (código,
 * descrição, valor de partida e valor limite) vivem em `tabela_de_valores_itens`
 * e entram pela importação de planilha, em `[id]/importar`.
 *
 * ─── Por que a criação é rota separada da importação ─────────────────────
 *
 * Importar exige um destino: um `tabela_id` que já existe e é da organização.
 * Criar a tabela junto com o primeiro upload faria "confirmei a prévia" e "criei
 * uma tabela" serem o mesmo clique — e uma prévia recusada deixaria tabela
 * vazia para trás. Aqui a ordem é explícita: cria a tabela, importa, confere.
 *
 * Escrita só para `admin` da organização; leitura para `viewer`. A organização
 * vem SEMPRE da autenticação — nada do corpo vira `organization_id`.
 */
const criarSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  descricao: z.string().trim().max(500).nullish(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "tabela_de_valores",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;

  const tabelas = await listarTabelasDeValores(getRequestPool(), authz.organizationId);
  return ok({ tabelas }, { requestId, headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "tabela_de_valores",
    role: "admin",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "tabela_de_valores", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  // Como na importação de prospecção: criar tabela de valores é operação de
  // tela. O `proxy.ts` já recusa o Bearer antes daqui (a rota não está em
  // `PUBLIC_PATHS`); esta linha deixa a intenção escrita no handler e cobre o
  // dia em que alguém abrir a porta sem lembrar do resto.
  if (authz.via === "token")
    return fail("forbidden", t("Criar tabela de valores exige a tela."), 403, {
      requestId,
      headers,
    });

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("validation_failed", t("Envie um JSON com o nome da tabela."), 422, {
      requestId,
      headers,
    });
  }
  const campos = criarSchema.safeParse(corpo);
  if (!campos.success)
    return fail("validation_failed", t("Confira o nome da tabela."), 422, {
      requestId,
      headers,
      details: campos.error.flatten().fieldErrors as Record<string, unknown>,
    });

  const tabela = await criarTabelaDeValores(
    getRequestPool(),
    authz.organizationId,
    campos.data,
    authz.actor.type === "user" ? authz.actor.id : null,
  );
  await audit({
    action: "tabela_de_valores.criada",
    organizationId: authz.organizationId,
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    resourceType: "tabela_de_valores",
    resourceId: tabela.id,
    metadata: { nome: tabela.nome },
    requestId,
  });
  return ok({ id: tabela.id, nome: tabela.nome }, { requestId, headers });
}
