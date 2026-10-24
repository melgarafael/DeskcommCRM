import { NextResponse, type NextRequest } from "next/server";

import { verificarEstado } from "@/lib/agenda/google/estado";
import { conectarComCodigo } from "@/lib/agencia/acervo/drive";
import { garantirPastaRaiz, sincronizarCompartilhamento } from "@/lib/agencia/acervo/pastas";
import { somarPermissoes } from "@/lib/agencia/permissoes";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * A volta do Google na conexão do Drive da agência (docs/agencia/SPEC-acervo.md › Como funciona, 1).
 *
 * Rota PÚBLICA no proxy (`lib/auth/public-paths.ts`): quem chega é o navegador
 * que o Google devolveu, de outro site, e o cookie Strict não viaja. A
 * identidade vem do `state` assinado — e, mesmo assim, a permissão de quem o
 * emitiu é conferida de novo no banco, agora, antes de gravar qualquer coisa.
 */
function voltar(motivo: string, base = env.NEXT_PUBLIC_APP_URL): NextResponse {
  const url = new URL("/agencia/configuracoes", base);
  url.searchParams.set("drive", motivo);
  return NextResponse.redirect(url, 303);
}

async function podeConfigurar(userId: string): Promise<boolean> {
  const db = createAdminClient();
  const { data: admin } = await db
    .from("platform_admins")
    .select("scope")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if ((admin as { scope?: string } | null)?.scope === "full") return true;
  const { data: membro } = await db
    .from("agencia_membros")
    .select("situacao, agencia_membros_funcoes(agencia_funcoes(ativa, permissoes))")
    .eq("user_id", userId)
    .maybeSingle();
  const m = membro as {
    situacao: string;
    agencia_membros_funcoes: Array<{ agencia_funcoes: { ativa: boolean; permissoes: string[] } | null }> | null;
  } | null;
  if (m?.situacao !== "ativo") return false;
  const funcoes = (m.agencia_membros_funcoes ?? []).flatMap((f) => (f.agencia_funcoes ? [f.agencia_funcoes] : []));
  return somarPermissoes(funcoes).has("configuracoes.gerenciar");
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return voltar("cancelado");
  const estado = verificarEstado(params.get("state"), { segredo: env.INTERNAL_SECRET, agora: new Date() });
  const code = params.get("code");
  if (!estado || estado.organizationId !== "agencia" || !code) return voltar("invalido");
  if (!(await podeConfigurar(estado.userId))) return voltar("sem_permissao");

  const r = await conectarComCodigo(code, estado.userId);
  if (!r.ok) {
    logger.warn("agência: conexão do Drive falhou", { erro: r.erro });
    return voltar("falhou");
  }
  await garantirPastaRaiz();
  await sincronizarCompartilhamento();
  void audit({
    action: "agencia.drive_conectado",
    actorUserId: estado.userId,
    organizationId: null,
    metadata: { conta: r.valor.email },
  });
  return voltar("conectado");
}
