"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { normalizarHex } from "@/lib/branding/rampa";
import {
  marcaDaOrganizacaoSchema,
  type MarcaDaOrganizacaoInput,
} from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateMarcaDaOrganizacaoResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "nao_gravou"
        | "db_error";
      details?: unknown;
    };

/**
 * Troca o nome e a cor que a ORGANIZAÇÃO mostra dentro do produto.
 *
 * ── Por que RPC, e não `.update({ settings })` ───────────────────────────────
 *
 * `organizations.settings` já tem TRÊS donos com gates diferentes — a aba
 * Organização (`updateTenant.ts:56-83`, admin), o PATCH de atendimento
 * (`api/v1/settings/routing`, manager) e a régua de atrito (`api/v1/metrics/
 * atrito`, manager) — e os três leem o jsonb INTEIRO, espalham em memória e
 * regravam o objeto inteiro, em round-trips separados. A perda é medida:
 * `visibility_mode` volta de `own` para `all` sem erro em lugar nenhum, e essa
 * chave é lida DIRETO pela RLS (`fn_can_view_conversation`, `fn_can_view_lead`).
 * Um write de COR reverteria, em silêncio, uma decisão de exposição de dado de
 * cliente. Um quarto escritor com o mesmo padrão seria inaceitável, então aqui a
 * escrita é UMA instrução dentro de `fn_definir_marca_da_organizacao` (0157).
 *
 * `.select()` no update NÃO resolveria isto: ele só torna o "0 linhas"
 * detectável, não torna o merge atômico. Precisamos das duas propriedades, e a
 * função entrega as duas — o merge e o `row_count` de volta.
 *
 * ── Por que o gate daqui NÃO é o que garante a regra ─────────────────────────
 *
 * Server Action NÃO é rota: ela não passa por `requireRole`, logo não herda a
 * re-resolução do papel pelo RPC — o papel abaixo vem do SNAPSHOT de membership
 * que `loadAuthUser()` carregou. Nenhuma das actions de `app/actions/` chama
 * `requireRole`, e o gate de MFA das telas mora no layout, que não roda quando a
 * action é invocada por POST direto. É por isso que a autorização de PAPEL está
 * DUPLICADA dentro da função SQL, que a re-resolve do banco e levanta 42501.
 *
 * ── Mas o banco NÃO defende as duas dimensões ────────────────────────────────
 *
 * "Quem defende o dado é o banco" vale para PAPEL e só para ele. O AAL é
 * propriedade da SESSÃO do GoTrue, e o Postgres não tem como enxergá-lo: a
 * escrita chega pelo `service_role`, e mesmo pelo client de sessão o JWT não
 * carrega nada que uma policy possa cobrar sobre segundo fator. Ou seja, a
 * duplicação no SQL não cobre este eixo — sem a linha abaixo, um POST direto na
 * action com sessão `aal1` de um admin que JÁ cadastrou TOTP passava, que é
 * exatamente o cenário (senha vazada / phishing) que a MFA existe para conter.
 *
 * `mfaEmDivida` é o mesmo predicado que `lib/auth/require-role.ts` aplica em
 * `/api/v1` — e o call site de lá é o ÚNICO que existia. A classe inteira (as
 * demais Server Actions sem gate de sessão) NÃO é escopo deste épico; aqui
 * fecha-se o que este épico abriu.
 *
 * ── Por que NÃO emite `event_log` ────────────────────────────────────────────
 *
 * `lib/event-log/drain.ts` só seleciona tipos COM handler registrado, e os 12 de
 * `register-handlers.ts` não cobrem nada de `org.*`. Um `branding.updated`
 * nasceria `pending` para sempre em todo clone — anti-pattern nº 3 do CLAUDE.md,
 * o mesmo que `updateBranding.ts:45-51` já recusou por escrito. O registro desta
 * mutação é o `audit()` abaixo, que tem consumidor real (`/admin/audit`).
 */
export async function updateMarcaDaOrganizacao(
  input: MarcaDaOrganizacaoInput,
): Promise<UpdateMarcaDaOrganizacaoResult> {
  const parsed = marcaDaOrganizacaoSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  // DEPOIS do papel, de propósito: quem nem tem o papel recebe `forbidden_role`,
  // que é a verdade sobre ele. Só quem passaria pelo papel é cobrado pelo
  // segundo fator — a ordem é o que faz cada código dizer a coisa certa.
  //
  // ⚠️ `mfaEmDivida()` DEIXOU DE RECEBER PAPEL, no merge com a frente que tornou
  // a verificação em duas etapas opcional. Ele consultava a política antes de
  // olhar a sessão; agora não consulta — quem TEM fator prova, qualquer que seja
  // o papel. A cobrança aqui fica MAIS abrangente, não menos: um manager com
  // fator e sessão `aal1` passava por este ponto e agora é barrado.
  if (await mfaEmDivida()) {
    return { ok: false, error: "mfa_required" };
  }

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  // Os dois campos vazios significam "volte ao que vem da instalação", e é `null`
  // que a função entende como apagar a chave `branding` — gravar `{}` deixaria um
  // envelope vazio que o resolvedor teria de aprender a ignorar.
  const limpar = parsed.data.app_name === null && parsed.data.accent_hex === null;
  const marca = limpar
    ? null
    : {
        app_name: parsed.data.app_name,
        // Normaliza porque a função valida com `^#[0-9a-f]{6}$`: `#FFF` e
        // `#FFFFFF` passam pelo Zod (o validador do domínio aceita as duas
        // formas) e só uma das duas passa pelo banco. Normalizar aqui é o que faz
        // "mudou?" ser uma pergunta com resposta.
        accent_hex:
          parsed.data.accent_hex === null ? null : normalizarHex(parsed.data.accent_hex),
        updated_by: authUser.id,
        updated_at: new Date().toISOString(),
      };

  // HEX CRU, não envelope. Quem monta o envelope versionado é `camadaDaOrganizacao`
  // (lib/branding/resolve.ts), exatamente como `camadaDaInstalacao` faz com
  // `platform_branding.accent_hex`. Um envelope gravado no jsonb teria
  // `format`/`algo` sem nada que os force a bater com a versão do código, e o
  // resolvedor já sabe degradar a partir de um hex. Um único escritor da forma.
  const { data, error } = await createAdminClient().rpc(
    "fn_definir_marca_da_organizacao",
    { p_org: activeOrg.orgId, p_actor: authUser.id, p_marca: marca },
  );

  if (error) {
    // Os dois códigos que a função levanta de propósito. `42501` é papel — e
    // chegar aqui significa que o snapshot de membership do gate de cima estava
    // velho, que é exatamente o caso que a duplicação no banco existe para pegar.
    if (error.code === "42501") return { ok: false, error: "forbidden_role" };
    if (error.code === "22023") {
      return { ok: false, error: "validation_failed", details: error.message };
    }
    return { ok: false, error: "db_error", details: error.message };
  }

  // A CATRACA DA ISSUE #144, no caminho quente. `data` é o `row_count` do UPDATE:
  // 0 significa que a organização não casou o filtro, e sem esta linha a tela
  // diria "salvo" com nada gravado — que é a forma exata do defeito medido em
  // `organizations` (policy FOR ALL de platform admin, PostgREST devolvendo 204).
  if (data !== 1) return { ok: false, error: "nao_gravou" };

  await audit({
    action: "org.branding_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    // O uuid da ORGANIZAÇÃO, e não `null`. O `null` que `updateBranding.ts` usa
    // nesta posição existe porque aquele singleton tem id `1` numa coluna `uuid`;
    // aqui o recurso É um uuid, e copiar o `null` por simetria perderia qual
    // organização mudou — que é a única pergunta que esta linha responde.
    // (E não escreva o nome do campo seguido de `null` em texto corrido aqui: o
    // gate `tests/unit/audit-resource-id-e-uuid.test.ts` é TEXTUAL de propósito e
    // acusa a própria prosa. Medido — foi o que aconteceu na primeira versão.)
    resourceId: activeOrg.orgId,
    requestId,
    ip,
    userAgent,
    metadata: {
      // FORMA, nunca IDENTIDADE: nenhum hex e nenhum nome de empresa entram na
      // trilha. Mesma disciplina de `resolve.ts` — a auditoria de plataforma é
      // lida por quem opera a instalação inteira.
      fields_changed: Object.keys(parsed.data),
      accent_definido: parsed.data.accent_hex !== null,
      nome_definido: parsed.data.app_name !== null,
    },
  });

  // `/app` como LAYOUT, e não a página da tela. O bloco de CSS da marca e o nome
  // no menu são emitidos pelo layout de `/app`: revalidar só a página deixaria o
  // admin salvando, vendo "ok" e navegando com a cor velha. Mesmo motivo do
  // `revalidatePath("/app", "layout")` de `setActiveOrg.ts`.
  revalidatePath("/app", "layout");
  return { ok: true };
}
