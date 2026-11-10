"use server";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { invalidarOrg } from "@/lib/auth/cache-curto";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import {
  interfaceSettingsSchema,
  interfaceTemDestino,
  lerInterface,
  type InterfaceSettings,
} from "@/lib/navigation/interface";

export type InterfaceDaEmpresaResult = { ok: true } | { ok: false; error: string };

/**
 * Grava as portas da EMPRESA (issue #1341) — o universo de itens do menu lateral
 * da instalação inteira. Cada vínculo continua escolhendo MENOS dentro dele
 * (`PATCH /api/v1/team/:user_id/interface`); ninguém abre além daqui, porque a
 * leitura resolve a INTERSEÇÃO (`combinarInterfaces`).
 *
 * Isto é configuração de APRESENTAÇÃO, como a escolha por vínculo: não concede
 * nem tira acesso. Papel, RLS e permissões seguem decidindo o que cada pessoa
 * alcança, e desmarcar uma área aqui apenas a esconde — link contextual, aviso e
 * busca continuam abrindo o que o papel autoriza.
 */
export async function atualizarInterfaceDaEmpresa(input: InterfaceSettings): Promise<InterfaceDaEmpresaResult> {
  const parsed = interfaceSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  // Sessão de suporte é somente-leitura: quem está do outro lado não muda o menu
  // da instalação (mesma trava de `updateTenant` e da rota por vínculo).
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  // Mesma guarda da escolha por vínculo: recusa a seleção que deixaria a empresa
  // sem NENHUMA área além das essenciais. As essenciais continuariam aparecendo
  // de qualquer forma, então essa seleção não é escolha — é menu vazio.
  if (!interfaceTemDestino(parsed.data, activeOrg.role)) {
    return { ok: false, error: "sem_area" };
  }

  // O MENU NUNCA GRAVA A TRAVA DO INBOX (#3012): as duas moram no mesmo campo,
  // e este cartão carrega o `bloquearAteAssumir` da MONTAGEM da página. Usá-lo
  // desligaria a trava em silêncio (o editor do menu monta o objeto do zero) ou a
  // religaria depois de alguém tê-la desligado no cartão do Inbox. Por isso o
  // valor do input é descartado SEMPRE, presente ou ausente, e o gravado fica.
  const { bloquearAteAssumir: _doInput, ...menu } = parsed.data;
  return gravarInterface(activeOrg.orgId, authUser.id, (gravada) => ({
    ...menu,
    ...(travaGravada(gravada) ? { bloquearAteAssumir: true } : {}),
  }));
}

/**
 * Liga e desliga o bloqueio da caixa de mensagem até assumir (#3012), e SÓ ele.
 *
 * Irmã de `atualizarInterfaceDaEmpresa` com os mesmos gates: a trava mora em
 * `interface_settings`, mas o cartão do Inbox não pode mandar o retrato do menu
 * que leu na montagem — salvá-lo desfaria a escolha de menu feita depois. Lê o
 * gravado e troca só a chave. Desligar REMOVE a chave: ausente = desligado.
 */
export async function atualizarBloqueioAteAssumir(ligado: boolean): Promise<InterfaceDaEmpresaResult> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ligado);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  return gravarInterface(activeOrg.orgId, authUser.id, (gravada) => {
    const { bloquearAteAssumir: _anterior, ...menu } = lerInterface(gravada).settings;
    return entrada.data ? { ...menu, bloquearAteAssumir: true } : menu;
  });
}

function travaGravada(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).bloquearAteAssumir === true;
}

async function gravarInterface(
  orgId: string,
  actorUserId: string,
  mesclar: (gravada: unknown) => InterfaceSettings,
): Promise<InterfaceDaEmpresaResult> {
  /**
   * A ESCRITA EM `organizations` VAI PELO ADMIN CLIENT — pelo mesmo motivo medido
   * em `updateTenant` (issue #144): a única policy de escrita da tabela é
   * `orgs_write_platform_admin`, então o UPDATE de um admin de organização pelo
   * client de sessão casa ZERO linhas e o PostgREST devolve sucesso. O gate
   * continua sendo o de cima (papel resolvido de fonte confiável) e o filtro por
   * organização é explícito — a organização vem da SESSÃO, nunca do corpo.
   */
  const supabase = createAdminClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  // Ler antes de gravar: a coluna é dividida entre o menu e a trava do Inbox, e
  // cada cartão só pode trocar a SUA parte.
  // ponytail: ler-e-gravar não é atômico; dois admins salvando no mesmo segundo
  // ainda disputam. Merge em SQL (jsonb ||) se isso aparecer.
  const { data: atual, error: erroLeitura } = await supabase
    .from("organizations")
    .select("interface_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "internal_error" };
  const novo = mesclar(atual?.interface_settings);

  // #3696: `interface_settings` da empresa viaja DENTRO do snapshot de
  // permissões de CADA membro (o menu lateral inteiro sai dele) — e o cache
  // curto é por usuário. `invalidarOrg` é o único jeito de derrubar o menu de
  // todos de uma vez. Antes e depois da escrita: antes, para a tela que já está
  // aberta não regravar o valor velho no meio do UPDATE; depois, para o commit.
  invalidarOrg(orgId);
  const { error } = await supabase
    .from("organizations")
    .update({ interface_settings: novo })
    .eq("id", orgId);
  if (error) return { ok: false, error: "internal_error" };
  invalidarOrg(orgId);

  await audit({
    action: "org.interface_changed",
    organizationId: orgId,
    actorUserId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    ip,
    userAgent,
    metadata: { fields_changed: ["interface_settings"], interface_settings: novo },
  });

  // Mesmo evento que `updateTenant` publica: quem escuta "a empresa mudou" não
  // deveria descobrir por recarregar a tela. É LITERALMENTE o mesmo TIPO — um
  // tipo novo (`org.interface_changed`) não teria assinante, não entraria no
  // vocabulário de `fn_event_log_e_registro` (migration 0239) e o fato nasceria
  // pendente para sempre; o detalhe fino de QUAL campo mudou fica no `audit_log`
  // (`action: "org.interface_changed"`), que é onde a pergunta é feita.
  await supabase
    .rpc("emit_event", {
      p_event_type: "org.updated",
      p_entity_kind: "organization",
      p_entity_id: orgId,
      p_payload: { organization_id: orgId },
      p_metadata: { request_id: requestId },
      p_organization_id: orgId,
    })
    .then(({ error: e }) => {
      if (e) console.error("[atualizarInterfaceDaEmpresa] emit_event failed", e.message);
    });

  revalidatePath("/app/settings/tenant");
  // O menu vive no layout do /app: sem isto quem acabou de escolher continuaria
  // vendo o menu antigo até o próximo carregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}
