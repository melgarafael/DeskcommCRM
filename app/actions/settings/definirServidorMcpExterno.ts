"use server";

/**
 * Registra (ou apaga) o servidor MCP externo que os agentes vão poder usar — a
 * metade REGISTRÁVEL do #2147.
 *
 * ── Quem pode (item 1) ──────────────────────────────────────────────────────
 *
 * O DONO DA INSTALAÇÃO, pela MESMA regra das extensões: `regraPlatformAdmin`
 * (`lib/extensions/http.ts`) cobra `is_platform_admin`, recusa sessão de
 * suporte, exige escopo `full` e cobra `aal2` quando a política da plataforma
 * pede. A regra, e não a `Response` de API que ela também sabe produzir —
 * Server Action não devolve `Response`.
 *
 * O gate vem ANTES do `safeParse`: quem não tem permissão recebe recusa de
 * permissão, não `validation_failed`. Um erro de forma dizer "você não pode" e
 * um erro de permissão dizer "preencha direito" ensinariam o operador errado.
 *
 * ── O que grava (itens 2 e 3) ──────────────────────────────────────────────
 *
 * Uma linha por ORGANIZAÇÃO: o `organization_id` sai da sessão (`resolveActiveOrg`),
 * nunca do corpo do pedido — um registro da instalação inteira faria a empresa B
 * consultar o ERP da empresa A. No `organizations` dessa organização:
 * `settings.mcp_externo` guarda só o ENDEREÇO (merge em dois níveis, ver
 * `mesclarServidorMcpExterno`), e a CHAVE vai cifrada para as colunas
 * `mcp_externo_chave_*` (`encryptKey`, o caminho das chaves de IA) — ela saiu do
 * jsonb porque a RLS entrega esse jsonb a todo membro, inclusive `viewer`.
 *
 * ── Endereço seguro, e sem segredo nele (itens 4 e 5) ──────────────────────
 *
 * `conferirEndpointSeguro` roda no CADASTRO (o mesmo guard anti-SSRF dos
 * webhooks de saída, que também roda na chamada). E o endpoint que vai para a
 * trilha de auditoria é SÓ o host: `api_audit_log` é append-only, e um ERP que
 * autentica por `?token=` deixaria o segredo lá para sempre.
 *
 * ── O que NÃO faz (fora da fatia) ───────────────────────────────────────────
 *
 * Tela em `/admin`, catálogo completo, escrita remota. Quem chama é o runtime,
 * em `carregarServidorMcpExterno`; esta action só grava.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { regraPlatformAdmin } from "@/lib/extensions/http";
import { supportWriteError } from "@/lib/impersonate/support";
import { BOLSO_MCP_EXTERNO, conferirEndpointSeguro, hostDoEndpoint, mesclarServidorMcpExterno } from "@/lib/mcp/servidor-externo/registro";
import { SEGREDO_APAGADO, cifrarChaveMcpExterno } from "@/lib/mcp/servidor-externo/segredo";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoRegistroDeServidorMcp =
  | { ok: true; chaveUltimos4: string | null }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "upstream_unavailable"
        | "endpoint_inseguro"
        | "erro_ao_gravar";
    };

/**
 * Endpoint (http/https) e chave. Vazio apaga; a conferência de segurança do
 * ENDEREÇO acontece logo abaixo, depois do gate — aqui só se impõe tamanho,
 * porque a Server Action é endpoint público e o tipo do parâmetro não chega ao
 * servidor.
 */
const entradaSchema = z.object({
  endpoint: z.string().trim().max(500),
  chave: z.string().trim().max(500),
});

export type RegistroDeServidorMcpInput = z.infer<typeof entradaSchema>;

export async function definirServidorMcpExterno(
  input: RegistroDeServidorMcpInput,
): Promise<ResultadoRegistroDeServidorMcp> {
  // 1) SESSÃO E PERMISSÃO ANTES DA FORMA (item 1) — ver o cabeçalho.
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // A barreira de sessão de suporte que toda action de escrita desta pasta
  // mostra no topo. A regra logo abaixo já recusa suporte por outro caminho
  // (`is_platform_admin` vem falso numa sessão emprestada); manter as duas é
  // de propósito: quem lê acha a barreira de sempre no lugar de sempre, e
  // nenhuma das duas depende da outra continuar existindo.
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };

  const regra = await regraPlatformAdmin(user);
  if (!regra.ok) {
    return { ok: false, error: regra.codigo === "forbidden" ? "forbidden_role" : regra.codigo };
  }
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };

  // 2) Só então a forma.
  const entrada = entradaSchema.safeParse(input);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const endpoint = entrada.data.endpoint.trim();
  const chave = entrada.data.chave.trim();
  const apagando = endpoint === "" || chave === "";

  // 3) Anti-SSRF no CADASTRO (item 4). Endpoint vazio não passa por aqui: ele
  // é o contrato de apagar, não um endereço a chamar.
  if (!apagando) {
    try {
      conferirEndpointSeguro(endpoint);
    } catch {
      // `unsafe_url:*` (literal privado, IPv6 literal, http em produção, forma
      // inválida) vira recusa de formulário; o motivo técnico fica no erro.
      return { ok: false, error: "endpoint_inseguro" };
    }
  }

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  // `settings` é jsonb compartilhado: ler, mesclar SÓ o nosso bolso e gravar
  // preserva o que é dos outros — é a razão do merge em dois níveis.
  const settings = mesclarServidorMcpExterno(atual?.settings ?? {}, { endpoint, chave });
  const temRegistro = settings[BOLSO_MCP_EXTERNO] !== undefined;
  // A CHAVE nunca entra no jsonb: sai cifrada, ou zerada quando apagam.
  const colunas = temRegistro ? cifrarChaveMcpExterno(chave) : SEGREDO_APAGADO;

  const { error } = await admin
    .from("organizations")
    .update({ settings, ...colunas })
    // A LINHA da organização da sessão (item 2) — o filtro é parte do contrato,
    // não detalhe de implementação: sem ele um update sem where gravaria a
    // chave de todo mundo.
    .eq("id", org.orgId);
  if (error) return { ok: false, error: "erro_ao_gravar" };

  await audit({
    action: "org.mcp_externo_registrado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: {
      // FORMA, nunca credencial: a CHAVE do ERP não entra na trilha, nem em
      // texto corrido, nem os últimos 4. E o endpoint vai SÓ como HOST (item 5):
      // `api_audit_log` é append-only e um `?token=` no endereço viveria lá
      // para sempre. O host é o que o operador precisa encontrar ao investigar
      // "de onde vêm essas ferramentas".
      endpoint: temRegistro ? hostDoEndpoint(endpoint) : null,
      registrado: temRegistro,
      chave_presente: temRegistro,
    },
  });

  revalidatePath("/app/settings", "layout");
  return { ok: true, chaveUltimos4: temRegistro ? chave.slice(-4) : null };
}
