"use server";

/**
 * MUDAR O STATUS DE UMA MANIFESTAÇÃO (#3611, fatia 3).
 *
 * ─── Por que o UPDATE passa pelo service role ──────────────────────────────
 *
 * A migration 9030 revogou `update` de `authenticated` em
 * `ouvidoria_manifestacoes` e concedeu escrita só a `service_role`. Isso é
 * deliberado e está escrito em `tests/invariants/ouvidoria-registro-privado.test.ts`
 * (fato 3): sem a revogação, qualquer administrador "corrigiria" o texto de uma
 * manifestação pelo PostgREST e a trilha não saberia — que é justamente o dado
 * que a issue chama de sigiloso. Então a mudança de status é a única escrita do
 * módulo feita pela tela, e ela paga o preço: **passa por aqui e grava
 * auditoria**. Sem o `audit()` esta action seria um buraco na razão pela qual a
 * tabela não tem UPDATE para `authenticated`.
 *
 * ─── A ordem, e por que ela não pode mudar ────────────────────────────────
 *
 * 1. valida a forma do pedido (`z.strictObject`: id, status, motivo — nada mais);
 * 2. a barreira da ouvidoria (`lib/ouvidoria/acesso.ts`, a MESMA da leitura):
 *    sem sessão, em acompanhamento, sem organização ou abaixo de `admin`, nada
 *    acontece — nem leitura;
 * 3. LÊ a manifestação pelo cliente de SESSÃO (`lib/ouvidoria/leitura.ts`, a
 *    leitura da fatia 1). Não é redundância: é ela que diz o status de HOJE, e
 *    sem ela não há transição a conferir — só um status a sobrescrever. E é a
 *    RLS da 9030 que responde "não é sua" nesta etapa;
 * 4. confere a transição (`lib/ouvidoria/transicao.ts`) — para frente um degrau,
 *    para trás com motivo, nada para o mesmo lugar;
 * 5. escreve com o cliente de SERVIÇO, com TRÊS predicados: organização, id e o
 *    status lido no passo 3. O terceiro é compare-and-set: se outra pessoa
 *    concluiu a manifestação entre o passo 3 e o 5, o UPDATE casa ZERO linhas e
 *    a resposta é `conflito` em vez de uma trilha que diz que Ana mudou de
 *    "em análise" para "concluída" quando o estado real era outro;
 * 6. grava a auditoria (`ouvidoria.status_updated`) com `de`, `para` e o motivo
 *    da reabertura — o motivo não é coluna, e não é desta fatia criar uma (sem
 *    migration): ele mora na trilha.
 *
 * ─── O que a action NÃO devolve ────────────────────────────────────────────
 *
 * Nunca o texto do relato. Quem precisa dele chama `lerManifestacaoDaOuvidoria`
 * (fatia 1). Uma resposta de escrita que ecoa o dado sigiloso amplia a
 * superfície sem servir a nada.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { acessoDaOuvidoria } from "@/lib/ouvidoria/acesso";
import { lerManifestacao } from "@/lib/ouvidoria/leitura";
import { STATUS_DA_OUVIDORIA, type StatusDaOuvidoria } from "@/lib/ouvidoria/registro";
import { conferirTransicao, type RecusaDaTransicao } from "@/lib/ouvidoria/transicao";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * O pedido. `strictObject` de propósito: `organization_id`, `protocolo` e
 * `texto` não são campos desta action. Organização vem de `resolveActiveOrg`;
 * protocolo e texto são imutáveis depois do registro.
 */
const pedidoSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(STATUS_DA_OUVIDORIA),
  /** Só é usado (e exigido) na reabertura — ver `lib/ouvidoria/transicao.ts`. */
  motivo: z.string().optional(),
});

export type PedidoDeMudancaDeStatus = z.infer<typeof pedidoSchema>;

export type ResultadoDaMudancaDeStatus =
  | { ok: true; de: StatusDaOuvidoria; para: StatusDaOuvidoria }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "not_found"
        | "erro_ao_ler"
        | "conflito"
        | "erro_ao_gravar"
        | RecusaDaTransicao;
    };

export async function mudarStatusDaManifestacao(
  entrada: PedidoDeMudancaDeStatus,
): Promise<ResultadoDaMudancaDeStatus> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = pedidoSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, error: "validation_failed" };

  const acesso = await acessoDaOuvidoria();
  if (!acesso.ok) return acesso;

  // Passo 3: o status de HOJE, pela leitura da fatia 1 (sessão + RLS).
  const sessao = await createClient();
  const atual = await lerManifestacao({ supabase: sessao, organizationId: acesso.org.orgId }, lido.data.id);
  if (!atual.ok) {
    return { ok: false, error: atual.erro === "erro_ao_ler" ? "erro_ao_ler" : "not_found" };
  }

  // Passo 4: a régua da transição.
  const conferida = conferirTransicao(atual.manifestacao.status, lido.data.status, lido.data.motivo);
  if (!conferida.ok) return { ok: false, error: conferida.erro };

  // Passo 5: escrita pelo service role, com compare-and-set no status lido.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ouvidoria_manifestacoes")
    .update({ status: conferida.para, updated_at: new Date().toISOString() })
    .eq("organization_id", acesso.org.orgId)
    .eq("id", lido.data.id)
    .eq("status", conferida.de)
    .select("id, status")
    .single();

  if (error) {
    // PGRST116: o `single()` não achou linha — alguém mudou o status entre a
    // leitura e a escrita, ou a linha deixou de casar os três predicados.
    if (error.code === "PGRST116") return { ok: false, error: "conflito" };
    logger.error("[ouvidoria] a mudança de status falhou", {
      organization_id: acesso.org.orgId,
      de: conferida.de,
      para: conferida.para,
      code: error.code,
      error: error.message.slice(0, 120),
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  const confirmada = (data as { status?: string } | null)?.status === conferida.para;
  if (!confirmada) {
    logger.error("[ouvidoria] a mudança de status não confirmou o novo estado", {
      organization_id: acesso.org.orgId,
      de: conferida.de,
      para: conferida.para,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  // Passo 6: a trilha. `audit` é fire-and-forget (nunca lança e nunca desfaz a
  // escrita) — a razão de ele vir DEPOIS do UPDATE confirmado é que registrar
  // uma mudança que não aconteceu seria pior que não registrar nada.
  await audit({
    action: "ouvidoria.status_updated",
    actorUserId: acesso.user.id,
    organizationId: acesso.org.orgId,
    resourceType: "ouvidoria_manifestacao",
    resourceId: lido.data.id,
    metadata: {
      de: conferida.de,
      para: conferida.para,
      // Presente só na reabertura: avançar não pede motivo, e gravar `null`
      // explícito deixa a trilha dizendo "não houve motivo" em vez de omitir.
      motivo: conferida.motivo,
      reabertura: conferida.reabertura,
    },
  });

  // A lista mostra o status; o detalhe também. O layout cobre as duas de uma vez.
  revalidatePath("/app/ouvidoria", "layout");

  return { ok: true, de: conferida.de, para: conferida.para };
}
