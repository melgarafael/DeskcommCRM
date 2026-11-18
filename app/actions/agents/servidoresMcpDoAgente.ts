"use server";
/**
 * Server actions dos SERVIDORES MCP DO AGENTE (migration 9095) — a seção
 * "Servidores MCP" da tela do agente.
 *
 * ── As regras que nenhuma action aqui dispensa ───────────────────────────────
 *
 * 1. Sessão e papel ANTES da forma: `admin` da organização ativa, sessão de
 *    suporte recusada para escrita.
 * 2. Organização da SESSÃO e agente conferido nela (`ai_agents` filtrado por
 *    `organization_id`) — nunca do corpo. O service role bypassa RLS, então o
 *    filtro é manual em toda consulta.
 * 3. Segredo não volta à tela: chave e `client_secret` só como `last4`/presença.
 * 4. Anti-SSRF no cadastro (prova textual) e em toda saída da descoberta.
 * 5. Auditoria em toda mutação, com FORMA (servidor, modo, host) e nunca
 *    credencial.
 * 6. Módulo opcional `mcp_por_agente` desligado (doc 252) recusa tudo, depois
 *    do papel: a tela some, e a action não fala com terceiro nenhum.
 */
import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { marcaDaSaida } from "@/lib/branding/saida";
import type { Tables } from "@/lib/database.types";
import { supportWriteError } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { listarFerramentasDoServidor } from "@/lib/mcp/servidor-externo/chamada";
import { apagado, cifrar, ultimos4 } from "@/lib/mcp/servidor-externo/cifra";
import { urlDoCallbackMcp } from "@/lib/mcp/servidor-externo/do-agente/enderecos";
import {
  ErroDeOauth,
  descobrir,
  hostsDoServidor,
  registrarCliente,
  type CodigoDeErroOauth,
} from "@/lib/mcp/servidor-externo/do-agente/oauth";
import {
  EntradaDoServidorSchema,
  LIMITE_DE_SERVIDORES_POR_AGENTE,
  conferirEndpointDoServidor,
  lerServidor,
  lerServidoresDoAgente,
  semSegredo,
  slugDoNome,
  type MetadadosOauth,
  type ServidorDoAgente,
} from "@/lib/mcp/servidor-externo/do-agente/registro";
import { revogarAcessosDoServidor } from "@/lib/mcp/servidor-externo/do-agente/revogacao";
import { hostDoEndpoint } from "@/lib/mcp/servidor-externo/registro";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ErroDaAcao =
  | "unauthenticated"
  | "forbidden_tenant"
  | "forbidden_role"
  | "validation_failed"
  | "agente_inexistente"
  | "servidor_inexistente"
  | "limite_de_servidores"
  | "endpoint_inseguro"
  | "erro_ao_gravar"
  | "modulo_desligado"
  | CodigoDeErroOauth;

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: ErroDaAcao };

/** O que a tela vê de um servidor: sem segredo, com os hosts que ele alcança. */
export interface ServidorNaTela extends ServidorDoAgente {
  hosts: string[];
  redirectUri: string;
}

function naTela(s: ServidorDoAgente): ServidorNaTela {
  return { ...s, hosts: hostsDoServidor(s.endpoint, s.oauth), redirectUri: urlDoCallbackMcp(s.id) };
}

async function exigirAdminDoAgente(agentId: string, escrita: boolean) {
  const user = await loadAuthUser();
  if (!user) return { ok: false as const, error: "unauthenticated" as const };
  if (escrita && supportWriteError(user.support)) return { ok: false as const, error: "forbidden_role" as const };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false as const, error: "forbidden_tenant" as const };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false as const, error: "forbidden_role" as const };
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "mcp_por_agente"))) return { ok: false as const, error: "modulo_desligado" as const };
  if (!UUID.test(agentId)) return { ok: false as const, error: "validation_failed" as const };
  const { data: agente } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", org.orgId)
    .eq("id", agentId)
    .maybeSingle();
  if (!agente) return { ok: false as const, error: "agente_inexistente" as const };
  // O admin client não é tipado com `Database`: o `.select()` aceita qualquer
  // coluna. O genérico do `maybeSingle` amarra a LEITURA ao tipo gerado — a
  // tabela não tem `name`, e ler `.name` voltava vazio sem o typecheck ver.
  const { data: orgRow } = await admin
    .from("organizations")
    .select("display_name")
    .eq("id", org.orgId)
    .maybeSingle<Pick<Tables<"organizations">, "display_name">>();
  return {
    ok: true as const,
    user,
    orgId: org.orgId,
    orgNome: orgRow?.display_name ?? "",
    admin,
  };
}

/** Lista os servidores do agente (sem segredo). */
export async function listarServidoresMcpDoAgente(agentId: string): Promise<Resultado<ServidorNaTela[]>> {
  const g = await exigirAdminDoAgente(agentId, false);
  if (!g.ok) return g;
  const lista = await lerServidoresDoAgente(g.admin, g.orgId, agentId);
  return { ok: true, data: lista.map((s) => naTela(semSegredo(s))) };
}

/**
 * Descoberta OAuth do endereço (sem gravar) — o "Testar conexão" do modo
 * `oauth_por_contato`. Valida RFC 9728/8414, exige S256 e diz se há DCR e
 * revogação. Não registra cliente (isso é do salvar). Devolve também o
 * endereço de retorno DESTE servidor (é por servidor), para o cadastro manual
 * de cliente no terceiro — `servidorId` é o do servidor em edição, ou o id que
 * a tela reservou para o novo (o mesmo que ela manda ao salvar).
 */
export async function descobrirOauthDoServidor(
  agentId: string,
  endpoint: string,
  servidorId?: string,
): Promise<
  Resultado<{
    emissor: string;
    escopos: string[];
    temRegistroDinamico: boolean;
    temRevogacao: boolean;
    hosts: string[];
    redirectUri: string | null;
  }>
> {
  const g = await exigirAdminDoAgente(agentId, false);
  if (!g.ok) return g;
  try {
    conferirEndpointDoServidor(endpoint);
  } catch {
    return { ok: false, error: "endpoint_inseguro" };
  }
  try {
    const d = await descobrir(endpoint);
    return {
      ok: true,
      data: {
        emissor: d.emissor,
        escopos: d.escopos_suportados,
        temRegistroDinamico: Boolean(d.registration_endpoint),
        temRevogacao: Boolean(d.revocation_endpoint),
        hosts: hostsDoServidor(endpoint, { ...d, cliente_dinamico: false, descoberto_em: "" }),
        redirectUri: servidorId && UUID.test(servidorId) ? urlDoCallbackMcp(servidorId) : null,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof ErroDeOauth ? err.codigo : "descoberta_falhou" };
  }
}

/**
 * Cria (sem `servidorId`) ou edita um servidor. Para `oauth_por_contato`, faz a
 * descoberta e — sem `client_id` informado e com `registration_endpoint` — o
 * registro dinâmico (RFC 7591) com o endereço de retorno DESTE servidor.
 * `idNovo` (só na criação) é o id que a tela reservou para mostrar o endereço
 * de retorno antes de salvar; um id que já exista faz o INSERT falhar.
 */
export async function salvarServidorMcpDoAgente(
  agentId: string,
  servidorId: string | null,
  entradaBruta: unknown,
  idNovo?: string,
): Promise<Resultado<ServidorNaTela>> {
  const g = await exigirAdminDoAgente(agentId, true);
  if (!g.ok) return g;
  const parsed = EntradaDoServidorSchema.safeParse(entradaBruta);
  if (!parsed.success) return { ok: false, error: "validation_failed" };
  const entrada = parsed.data;
  try {
    conferirEndpointDoServidor(entrada.endpoint);
  } catch {
    return { ok: false, error: "endpoint_inseguro" };
  }

  const existentes = await lerServidoresDoAgente(g.admin, g.orgId, agentId);
  const atual = servidorId ? existentes.find((s) => s.id === servidorId) ?? null : null;
  if (servidorId && !atual) return { ok: false, error: "servidor_inexistente" };
  if (!atual && existentes.length >= LIMITE_DE_SERVIDORES_POR_AGENTE) return { ok: false, error: "limite_de_servidores" };
  // O id nasce AQUI no cadastro: o endereço de retorno é por servidor e vai no
  // registro dinâmico, antes do INSERT.
  const idDoServidor = atual?.id ?? (idNovo && UUID.test(idNovo) ? idNovo : randomUUID());

  // Slug estável: nasce do nome e NÃO muda na edição (mudaria o nome que o
  // modelo vê e as ferramentas já escolhidas pareceriam outras).
  let slug = atual?.slug ?? slugDoNome(entrada.nome);
  if (!atual) {
    const ocupados = new Set(existentes.map((s) => s.slug));
    for (let n = 2; ocupados.has(slug); n += 1) slug = `${slugDoNome(entrada.nome).slice(0, 14)}${n}`;
  }

  const colunas: Record<string, unknown> = {
    nome: entrada.nome,
    endpoint: entrada.endpoint,
    modo_autenticacao: entrada.modo,
    escopos_pedidos: entrada.modo === "oauth_por_contato" ? entrada.escoposPedidos : [],
    escrita_delegada: entrada.modo === "oauth_por_contato" && entrada.escritaDelegada,
    retencao_apos_encerramento_horas: entrada.retencaoHoras,
    ativo: entrada.ativo,
  };

  // Chave: vazio = manter a atual (edição) — só o modo `chave_estatica` a usa.
  if (entrada.modo === "chave_estatica") {
    if (entrada.chave !== "") Object.assign(colunas, cifrar("chave", entrada.chave), { chave_last4: ultimos4(entrada.chave) });
    else if (!atual?.chave) return { ok: false, error: "validation_failed" };
  } else {
    Object.assign(colunas, apagado("chave"), { chave_last4: null });
  }

  if (entrada.modo === "oauth_por_contato") {
    const mudouEndereco = !atual || atual.endpoint !== entrada.endpoint || !atual.oauth;
    let metadados: MetadadosOauth | null = mudouEndereco ? null : atual!.oauth;
    let clientId = entrada.oauthClientId || (mudouEndereco ? "" : atual?.oauthClientId ?? "");
    try {
      if (!metadados) {
        const d = await descobrir(entrada.endpoint);
        const { metodosDeAutenticacaoNoToken, ...resto } = d;
        metadados = {
          ...resto,
          cliente_dinamico: false,
          descoberto_em: new Date().toISOString(),
          metodos_no_token: metodosDeAutenticacaoNoToken,
        };
      }
      if (!clientId) {
        if (!metadados.registration_endpoint) return { ok: false, error: "sem_cliente" };
        clientId = await registrarCliente(metadados.registration_endpoint, {
          redirectUri: urlDoCallbackMcp(idDoServidor),
          // A marca da SAÍDA (white-label): o nome que o cliente final lê na
          // tela de consentimento do terceiro é o da instalação/organização.
          nomeDoCliente: `${(await marcaDaSaida(g.orgId)).nome} — ${g.orgNome}`.trim(),
          escopos: entrada.escoposPedidos,
        });
        metadados = { ...metadados, cliente_dinamico: true };
      }
    } catch (err) {
      return { ok: false, error: err instanceof ErroDeOauth ? err.codigo : "descoberta_falhou" };
    }
    colunas.oauth_metadados = metadados;
    colunas.oauth_client_id = clientId;
    // Cliente do registro dinâmico é público: segredo NUNCA é gravado (um campo
    // de senha autopreenchido pelo navegador não pode virar credencial).
    if (metadados.cliente_dinamico) Object.assign(colunas, apagado("oauth_client_secret"));
    else if (entrada.oauthClientSecret !== "") Object.assign(colunas, cifrar("oauth_client_secret", entrada.oauthClientSecret));
    else if (mudouEndereco) Object.assign(colunas, apagado("oauth_client_secret"));
  } else {
    Object.assign(colunas, { oauth_metadados: {}, oauth_client_id: null }, apagado("oauth_client_secret"));
  }

  // Trocou a ORIGEM dos tokens (endereço, modo ou cliente OAuth)? Os acessos
  // de contato emitidos pela configuração antiga são revogados nela e apagados
  // ANTES de gravar a nova — senão o próximo turno mandaria o token ao host novo.
  if (
    atual?.modo === "oauth_por_contato" &&
    (entrada.modo !== "oauth_por_contato" ||
      atual.endpoint !== entrada.endpoint ||
      (colunas.oauth_client_id ?? null) !== atual.oauthClientId)
  ) {
    await revogarAcessosDoServidor(g.admin, atual);
  }

  const gravacao = atual
    ? g.admin.from("ai_agent_mcp_servers").update(colunas).eq("organization_id", g.orgId).eq("id", atual.id)
    : g.admin.from("ai_agent_mcp_servers").insert({
        ...colunas,
        id: idDoServidor,
        organization_id: g.orgId,
        agent_id: agentId,
        slug,
        created_by: g.user.id,
      });
  const { error } = await gravacao;
  if (error) return { ok: false, error: "erro_ao_gravar" };

  const salvo = (await lerServidoresDoAgente(g.admin, g.orgId, agentId)).find((s) => s.id === idDoServidor);
  if (!salvo) return { ok: false, error: "erro_ao_gravar" };

  await audit({
    action: "agent.mcp_servidor_salvo",
    actorUserId: g.user.id,
    organizationId: g.orgId,
    resourceType: "ai_agent",
    resourceId: agentId,
    metadata: {
      servidor_id: salvo.id,
      criado: !atual,
      modo: salvo.modo,
      endpoint: hostDoEndpoint(salvo.endpoint),
      escrita_delegada: salvo.escritaDelegada,
      cliente_dinamico: salvo.oauth?.cliente_dinamico ?? false,
    },
  });
  revalidatePath(`/app/ai/agents/${agentId}`);
  return { ok: true, data: naTela(semSegredo(salvo)) };
}

/**
 * Remove o servidor. Antes, REVOGA no terceiro todas as credenciais de contato
 * dele (melhor esforço); a FK em cascata apaga as linhas e os pedidos. As
 * escolhas `mcp_externo:<id>:*` em `tool_ids` ficam órfãs e não montam nada
 * (a carga só lê servidor que existe); o editor as limpa no próximo salvar.
 */
export async function removerServidorMcpDoAgente(
  agentId: string,
  servidorId: string,
): Promise<Resultado<{ revogadas: number }>> {
  const g = await exigirAdminDoAgente(agentId, true);
  if (!g.ok) return g;
  if (!UUID.test(servidorId)) return { ok: false, error: "validation_failed" };
  const servidor = await lerServidor(g.admin, g.orgId, servidorId);
  if (!servidor || servidor.agentId !== agentId) return { ok: false, error: "servidor_inexistente" };

  const revogadas = servidor.modo === "oauth_por_contato" ? await revogarAcessosDoServidor(g.admin, servidor) : 0;
  const { error } = await g.admin
    .from("ai_agent_mcp_servers")
    .delete()
    .eq("organization_id", g.orgId)
    .eq("id", servidorId);
  if (error) return { ok: false, error: "erro_ao_gravar" };

  await audit({
    action: "agent.mcp_servidor_removido",
    actorUserId: g.user.id,
    organizationId: g.orgId,
    resourceType: "ai_agent",
    resourceId: agentId,
    metadata: { servidor_id: servidorId, modo: servidor.modo, endpoint: hostDoEndpoint(servidor.endpoint), credenciais_revogadas: revogadas },
  });
  revalidatePath(`/app/ai/agents/${agentId}`);
  return { ok: true, data: { revogadas } };
}

/**
 * As ferramentas que o servidor anuncia, para o seletor do editor.
 *
 * `nenhuma`/`chave_estatica`: `tools/list` de verdade (sem contato, sem
 * cabeçalho de identidade). `oauth_por_contato`: o servidor não lista sem o
 * token de alguém — a tela recebe o que turnos com token já viram
 * (`ferramentas_vistas`) e o admin pode escrever o nome à mão.
 */
export async function listarFerramentasDoServidorMcpDoAgente(
  agentId: string,
  servidorId: string,
): Promise<Resultado<{ origem: "servidor" | "vistas_em_turnos"; ferramentas: Array<{ name: string; description?: string; somenteLeitura?: boolean }> }>> {
  const g = await exigirAdminDoAgente(agentId, false);
  if (!g.ok) return g;
  if (!UUID.test(servidorId)) return { ok: false, error: "validation_failed" };
  const servidor = await lerServidor(g.admin, g.orgId, servidorId);
  if (!servidor || servidor.agentId !== agentId) return { ok: false, error: "servidor_inexistente" };
  if (servidor.modo === "oauth_por_contato") {
    return { ok: true, data: { origem: "vistas_em_turnos", ferramentas: servidor.oauth?.ferramentas_vistas ?? [] } };
  }
  try {
    const ferramentas = await listarFerramentasDoServidor({
      endpoint: servidor.endpoint,
      chave: servidor.modo === "chave_estatica" ? servidor.chave : null,
    });
    return {
      ok: true,
      data: {
        origem: "servidor",
        ferramentas: ferramentas.map((f) => ({
          name: f.name,
          ...(f.description ? { description: f.description } : {}),
          ...(f.somenteLeitura ? { somenteLeitura: true } : {}),
        })),
      },
    };
  } catch {
    return { ok: false, error: "rede" };
  }
}
