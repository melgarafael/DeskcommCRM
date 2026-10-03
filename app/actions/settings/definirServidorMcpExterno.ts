"use server";

/**
 * Registra (ou apaga) o servidor MCP externo que o agente vai poder usar — a
 * metade REGISTRÁVEL do #2147.
 *
 * ── Quem pode ───────────────────────────────────────────────────────────────
 *
 * O mesmo gate das outras actions de Configurações, e não outro: sessão viva
 * (`loadAuthUser`), papel de administrar a organização
 * (`podeAdministrarEmpresa`) e segundo fator em dia (`mfaEmDivida`, o AAL2 que
 * a issue cobra das extensões). O endereço do servidor é configuração de quem
 * já tem poder para instalar coisa — a issue é enfática nisso: o endereço NÃO
 * vem de pacote nenhum, vem de uma pessoa.
 *
 * ── O que grava ─────────────────────────────────────────────────────────────
 *
 * `organizations.settings.mcp_externo`, com merge em dois níveis (ver
 * `mesclarServidorMcpExterno`) — SEM migration, pelo mesmo motivo do PR #2197:
 * `settings` é jsonb e a linha já existe para toda organização. Endpoint e
 * chave vazios apagam o registro, que é o contrato de formulário de sempre.
 *
 * ── O que NÃO faz (fora da fatia) ───────────────────────────────────────────
 *
 * Tela em `/admin`, limite de ferramentas, catálogo completo, escrita remota.
 * Quem chama é o runtime, em `carregarServidorMcpExterno`; esta action só
 * grava.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { mesclarServidorMcpExterno } from "@/lib/mcp/servidor-externo/registro";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoRegistroDeServidorMcp =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "erro_ao_gravar";
    };

/**
 * Endpoint (http/https) e chave. Vazio apaga; a validação de URL de verdade é
 * a de `ehEndpointValido`, na leitura — aqui só se impõe tamanho, porque a
 * Server Action é endpoint público e o tipo do parâmetro não chega ao servidor.
 */
const entradaSchema = z.object({
  endpoint: z.string().trim().max(500),
  chave: z.string().trim().max(500),
});

export type RegistroDeServidorMcpInput = z.infer<typeof entradaSchema>;

export async function definirServidorMcpExterno(
  input: RegistroDeServidorMcpInput,
): Promise<ResultadoRegistroDeServidorMcp> {
  const entrada = entradaSchema.safeParse(input);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  // `settings` é jsonb compartilhado: ler, mesclar SÓ o nosso bolso e gravar
  // preserva o que é dos outros — é a razão do merge em dois níveis.
  const settings = mesclarServidorMcpExterno(atual?.settings ?? {}, entrada.data);

  const { error } = await admin.from("organizations").update({ settings }).eq("id", org.orgId);
  if (error) return { ok: false, error: "erro_ao_gravar" };

  await audit({
    action: "org.mcp_externo_registrado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: {
      // FORMA, nunca credencial: a CHAVE do ERP não entra na trilha, nem em
      // texto corrido. O endpoint é host de configuração (a leitura já recusa
      // URL com usuário/senha embutido), então ele sim é o que o operador
      // precisa encontrar ao investigar "de onde vêm essas ferramentas".
      endpoint: settings.mcp_externo
        ? (settings.mcp_externo as { endpoint?: unknown }).endpoint ?? null
        : null,
      registrado: settings.mcp_externo !== undefined,
    },
  });

  revalidatePath("/app/settings", "layout");
  return { ok: true };
}
