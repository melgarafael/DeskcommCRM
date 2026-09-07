import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * O logo da marca — subir do computador, sem colar URL.
 *
 * Uma rota para as DUAS camadas (instalação e organização), com o escopo vindo
 * do corpo e o GATE trocando por escopo. A alternativa (duas rotas) duplicaria a
 * ordem das verificações, e é a ORDEM que carrega a segurança aqui: duas cópias
 * divergiriam no primeiro conserto feito só de um lado.
 *
 * ── A ORDEM, e por que ela é a decisão desta rota ────────────────────────────
 *
 *  1. **escopo por `z.enum`** — allowlist, nunca string livre. Sem ela,
 *     `../platform` vira prefixo e o arquivo de um tenant aterrissa na pasta da
 *     instalação.
 *  2. **gate por escopo** — `platform_admin` para a instalação (é a marca do
 *     LOGIN, comum a todos os clientes do revendedor); `admin` do tenant + MFA
 *     em dia para a organização. Duplicado dos escritores que já existem
 *     (`updateBranding.ts`, `updateMarcaDaOrganizacao.ts`), de propósito.
 *  3. **rate limit** — depois do gate: quem nem passou no papel não gasta o
 *     orçamento de quem passou.
 *  4. **tamanho (413)** — antes de ler os bytes.
 *  5. **`pareceSvg` (415)** — com a razão dita em português. SVG é o formato em
 *     que um designer entrega logo; a pessoa precisa ler "mande PNG ou JPG", não
 *     "tipo de mídia não suportado".
 *  6. **`farejarTipo` (415)** — a decisão de tipo sai dos BYTES. `file.type` não
 *     decide nada e entra só no `details`, para o log mostrar a mentira.
 *  7. **prefixo de fonte confiável** — `resolveActiveOrg` (cookie validado contra
 *     memberships), NUNCA do body.
 *  8. **lê o caminho antigo DO BANCO** — não do cliente.
 *  9. **sobe → grava → só então apaga.** Inverter troca "sobra um arquivo" por
 *     "o cliente fica sem marca": se a gravação falhar depois do delete, o
 *     ponteiro aponta para um objeto que não existe mais e a tela fica sem logo.
 *     O custo do erro na ordem certa é um órfão de ≤512 KB.
 * 10. **`podeApagar` asseverado, com `logger.error` na recusa.** Recusar em
 *     silêncio deixaria o caminho fora do escopo indistinguível de "não havia
 *     nada para apagar" — que é exatamente o estado que o ataque produz.
 *
 * ── Sem código de ação novo, e sem `event_log` ───────────────────────────────
 *
 * A auditoria reusa `platform_branding.updated` e `org.branding_updated`: o
 * objeto mudado é o mesmo, e um código por campo faria o filtro do painel crescer
 * sem responder nenhuma pergunta nova. `event_log` não entra porque nenhum dos 12
 * handlers de `lib/event-log/register-handlers.ts` cobre branding — a linha
 * nasceria `pending` para sempre em todo clone (anti-pattern nº 3 do CLAUDE.md).
 *
 * ── O que fica sem varredor, declarado ───────────────────────────────────────
 *
 * Não há cron de órfãos. Um logo tem ≤512 KB e muda raramente: encher 1 GB de
 * cota exige ~2000 uploads que falharam DEPOIS do upload e ANTES da gravação.
 * Apagar uma organização também não cascateia no storage. Está no HANDOFF como
 * dívida com esse número — entregar upload sem varredor é aceitável; entregar
 * upload sem render não seria.
 */
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { invalidarMarcaDaInstalacao } from "@/lib/branding/instalacao";
import {
  BUCKET_DE_LOGOS,
  caminhoNovoDoLogo,
  PREFIXO_DA_INSTALACAO,
  prefixoDaOrganizacao,
  TAMANHO_MAXIMO_DO_LOGO,
  urlPublicaDoLogo,
  baseDoStorage,
} from "@/lib/branding/logo";
import { extensaoDe, farejarTipo, pareceSvg, podeApagar } from "@/lib/branding/logo-arquivo";
import { marcaDaOrganizacaoDeSettings } from "@/lib/branding/organizacao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * ALLOWLIST, e é o primeiro passo por isso: o escopo decide o PREFIXO no
 * storage. Aceitar string livre aqui é aceitar que o cliente escolha em qual
 * pasta escrever.
 */
const escopoSchema = z.enum(["instalacao", "organizacao"]);
type Escopo = z.infer<typeof escopoSchema>;

/**
 * 10 trocas de logo por pessoa a cada 5 min.
 *
 * Por USUÁRIO e não por IP: o kit self-host expõe o app sem proxy
 * (`docker-compose.prod.yml`), então `x-forwarded-for` não existe na instalação
 * padrão — um teto por IP viraria balde global, e o balde global aqui trancaria a
 * marca da instalação inteira. Quem chega nesta rota já passou pelo gate de
 * papel, então o identificador é conhecido e estável.
 */
const TETO_POR_USUARIO = 10;
const JANELA_SEGUNDOS = 300;

type Contexto =
  | { readonly escopo: "instalacao"; readonly userId: string; readonly prefixo: string }
  | {
      readonly escopo: "organizacao";
      readonly userId: string;
      readonly orgId: string;
      readonly prefixo: string;
    };

type Recusa = { readonly codigo: string; readonly mensagem: string; readonly status: number };

/**
 * O gate, por escopo. Devolve o contexto JÁ com o prefixo montado de fonte
 * confiável — assim nenhum caminho abaixo tem a oportunidade de montá-lo do body.
 *
 * ── Por que `mfaEmDivida` e não o `requirePlatformAdmin()` das telas ─────────
 *
 * `requirePlatformAdmin()` REDIRECIONA (é o gate do layout de `/admin`), e um
 * `307` para `/login` como resposta a um `fetch()` de upload chega ao navegador
 * como HTML no lugar de JSON — a tela mostraria "erro inesperado" para um caso
 * que tem nome. Aqui o predicado é o mesmo que `lib/auth/require-role.ts` aplica
 * em todo `/api/v1`: papel + `mfaEmDivida`. A diferença de comportamento entre os
 * dois é só para quem AINDA NÃO cadastrou fator — e essa pessoa é barrada antes,
 * pelo gate de cadastro do layout, que é onde ela pode resolver.
 */
async function abrirContexto(escopo: Escopo): Promise<{ ctx: Contexto } | { recusa: Recusa }> {
  const user = await loadAuthUser();
  if (!user) {
    return { recusa: { codigo: "unauthenticated", mensagem: "Faça login.", status: 401 } };
  }

  if (escopo === "instalacao") {
    if (!user.is_platform_admin) {
      return {
        recusa: {
          codigo: "forbidden_role",
          mensagem: "Só quem administra a instalação pode trocar o logo do sistema.",
          status: 403,
        },
      };
    }
    // ⚠️ Sem argumentos desde o merge com a frente que tornou a verificação em
    // duas etapas opcional — o porquê está por extenso em
    // `app/actions/settings/updateMarcaDaOrganizacao.ts`. Em uma linha: a função
    // parou de consultar a política, então quem TEM fator prova sempre. Passar
    // papel aqui não é só inútil, é o modelo mental errado gravado no código.
    if (await mfaEmDivida()) {
      return {
        recusa: {
          codigo: "mfa_required",
          mensagem: "Confirme o segundo fator nesta sessão para trocar o logo.",
          status: 403,
        },
      };
    }
    return { ctx: { escopo, userId: user.id, prefixo: PREFIXO_DA_INSTALACAO } };
  }

  const org = await resolveActiveOrg(user);
  if (!org) {
    return {
      recusa: { codigo: "forbidden_tenant", mensagem: "Sem organização ativa.", status: 403 },
    };
  }
  if (!user.is_platform_admin && !roleAtLeast(org.role, "admin")) {
    return {
      recusa: {
        codigo: "forbidden_role",
        mensagem: "Só quem administra a empresa pode trocar o logo dela.",
        status: 403,
      },
    };
  }
  // DEPOIS do papel, de propósito — mesma ordem de `updateMarcaDaOrganizacao.ts`:
  // quem nem tem o papel recebe `forbidden_role`, que é a verdade sobre ele.
  if (await mfaEmDivida()) {
    return {
      recusa: {
        codigo: "mfa_required",
        mensagem: "Confirme o segundo fator nesta sessão para trocar o logo.",
        status: 403,
      },
    };
  }
  return {
    ctx: { escopo, userId: user.id, orgId: org.orgId, prefixo: prefixoDaOrganizacao(org.orgId) },
  };
}

/** O caminho HOJE gravado, lido do BANCO. Nunca do cliente. */
async function caminhoGravado(ctx: Contexto): Promise<string | null> {
  const admin = createAdminClient();
  if (ctx.escopo === "instalacao") {
    const { data } = await admin
      .from("platform_branding")
      .select("logo_path")
      .eq("id", 1)
      .maybeSingle();
    return (data as { logo_path?: string | null } | null)?.logo_path ?? null;
  }
  const { data } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", ctx.orgId)
    .maybeSingle();
  return marcaDaOrganizacaoDeSettings(data?.settings ?? null)?.logo_path ?? null;
}

/**
 * Grava o ponteiro. `null` apaga.
 *
 * Instalação: `upsert` e não `update` — numa instalação cujo `.env` não tem marca
 * nenhuma a linha ainda não existe, e um `update` casaria zero linhas devolvendo
 * sucesso (a forma exata da issue #144). `seeded_from_env: false` porque a linha
 * passa a ser HUMANA: é o que impede a semeadura do `.env` de reescrever no
 * render seguinte a escolha de quem subiu o arquivo.
 *
 * Organização: RPC, porque `settings` tem quatro donos com gates diferentes e os
 * outros fazem read-modify-write do jsonb inteiro. O `row_count` de volta é o que
 * distingue "gravou" de "não gravou".
 */
async function gravarCaminho(ctx: Contexto, caminho: string | null): Promise<Recusa | null> {
  const admin = createAdminClient();
  if (ctx.escopo === "instalacao") {
    const { error } = await admin
      .from("platform_branding")
      .upsert({ id: 1, logo_path: caminho, seeded_from_env: false }, { onConflict: "id" });
    if (error) {
      logger.error("[marca/logo] gravação da instalação falhou", {
        codigo: error.code,
        detalhe: error.message,
      });
      return { codigo: "internal_error", mensagem: "Erro ao gravar o logo.", status: 500 };
    }
    // A troca aparece no próximo render sem esperar o TTL de 30s do memo.
    //
    // ⚠️ Isto já foi um NO-OP, e o comentário aqui dizia "no MESMO processo que
    // renderiza (na VPS há um processo de app só)" — verdade sobre o processo,
    // falsidade sobre o que importa. O Turbopack compila esta rota e as telas em
    // dois runtimes com caches de módulo próprios, então esta chamada zerava uma
    // cópia do memo que nenhuma tela lê. O memo passou a morar em `globalThis`;
    // a medição do build está no comentário dele, em `lib/branding/instalacao.ts`.
    invalidarMarcaDaInstalacao();
    return null;
  }

  const { data, error } = await admin.rpc("fn_definir_logo_da_organizacao", {
    p_org: ctx.orgId,
    p_actor: ctx.userId,
    p_path: caminho,
  });
  if (error) {
    // Os dois códigos que a função levanta de propósito. `42501` é papel — e
    // chegar aqui significa que o snapshot de membership do gate acima estava
    // velho, que é exatamente o caso que a duplicação no banco existe para pegar.
    if (error.code === "42501") {
      return {
        codigo: "forbidden_role",
        mensagem: "Só quem administra a empresa pode trocar o logo dela.",
        status: 403,
      };
    }
    if (error.code === "22023") {
      logger.error("[marca/logo] caminho recusado pelo banco", { detalhe: error.message });
      return {
        codigo: "validation_failed",
        mensagem: "O caminho do logo não pertence a esta empresa.",
        status: 422,
      };
    }
    logger.error("[marca/logo] gravação da organização falhou", {
      codigo: error.code,
      detalhe: error.message,
    });
    return { codigo: "internal_error", mensagem: "Erro ao gravar o logo.", status: 500 };
  }
  // A CATRACA DA ISSUE #144: `data` é o `row_count`. 0 significa que a
  // organização não casou o filtro, e sem esta linha a tela diria "salvo".
  if (data !== 1) {
    return { codigo: "internal_error", mensagem: "O logo não foi gravado.", status: 500 };
  }
  return null;
}

/**
 * Apaga o arquivo anterior — e só se ele estiver DENTRO do prefixo de quem pediu.
 *
 * Nunca lança e nunca falha a requisição: o ponteiro novo já está gravado, então
 * o cliente já tem a marca certa na tela. O que não pode acontecer é a recusa ser
 * silenciosa — um caminho fora do escopo é sinal de dado adulterado, não de
 * limpeza rotineira, e é o único lugar onde esse sinal aparece.
 */
async function apagarAnterior(ctx: Contexto, anterior: string | null): Promise<void> {
  if (!anterior) return;
  if (!podeApagar(anterior, ctx.prefixo)) {
    logger.error("[marca/logo] recusei apagar arquivo fora do escopo de quem pediu", {
      escopo: ctx.escopo,
      prefixo_esperado: ctx.prefixo,
      // O caminho INTEIRO, e não só o prefixo: sem ele o registro guarda a
      // mensagem e descarta o dono do erro — completo por fora, indiagnosticável
      // por dentro. O caminho não é segredo (o bucket é público) e é a única
      // pista de qual linha do banco foi adulterada.
      caminho_recusado: anterior,
    });
    return;
  }
  const { error } = await createAdminClient().storage.from(BUCKET_DE_LOGOS).remove([anterior]);
  if (error) {
    logger.warn("[marca/logo] arquivo anterior ficou órfão", {
      detalhe: error.message,
      caminho: anterior,
    });
  }
}

async function registrarAuditoria(
  ctx: Contexto,
  req: NextRequest,
  requestId: string,
  acao: "definido" | "removido",
): Promise<void> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;
  // FORMA, nunca IDENTIDADE — mesma disciplina de `resolve.ts`. O caminho do
  // arquivo não entra: a trilha é lida por quem opera a plataforma inteira.
  const metadata = { fields_changed: ["logo_path"], logo_definido: acao === "definido" };

  if (ctx.escopo === "instalacao") {
    await audit({
      action: "platform_branding.updated",
      actorUserId: ctx.userId,
      resourceType: "platform_branding",
      // `null`, e NÃO `"1"`: `api_audit_log.resource_id` é `uuid` e a chave
      // natural do singleton faria o INSERT do audit estourar com 22P02 — em
      // silêncio, porque audit é fire-and-forget. Ver
      // `tests/unit/audit-resource-id-e-uuid.test.ts`.
      resourceId: null,
      requestId,
      ip,
      userAgent,
      actingAsPlatformAdmin: true,
      metadata,
    });
    return;
  }
  await audit({
    action: "org.branding_updated",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "organization",
    resourceId: ctx.orgId,
    requestId,
    ip,
    userAgent,
    metadata,
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const form = await req.formData().catch(() => null);
  const escopoLido = escopoSchema.safeParse(form?.get("escopo"));
  if (!escopoLido.success) {
    return fail("validation_failed", "Campo 'escopo' inválido.", 422, { requestId });
  }

  const aberto = await abrirContexto(escopoLido.data);
  if ("recusa" in aberto) {
    return fail(aberto.recusa.codigo, aberto.recusa.mensagem, aberto.recusa.status, { requestId });
  }
  const ctx = aberto.ctx;

  const limite = await checkRateLimit(
    `marca-logo:${ctx.userId}`,
    TETO_POR_USUARIO,
    JANELA_SEGUNDOS,
  );
  if (!limite.allowed) {
    return fail("rate_limited", "Muitas trocas de logo seguidas. Tente em alguns minutos.", 429, {
      requestId,
      headers: { "Retry-After": String(JANELA_SEGUNDOS) },
    });
  }

  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", "Campo 'file' (multipart) obrigatório.", 422, { requestId });
  }
  if (file.size > TAMANHO_MAXIMO_DO_LOGO) {
    return fail(
      "payload_too_large",
      "O logo precisa ter até 512 KB. Arquivo maior vai inteiro para o navegador em toda página.",
      413,
      { requestId },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (pareceSvg(bytes)) {
    return fail(
      "logo_svg_recusado",
      "SVG não é aceito como logo: ele pode executar código quando aberto direto do endereço da imagem. Exporte o mesmo arquivo em PNG (fundo transparente) ou JPG.",
      415,
      { requestId },
    );
  }

  const tipo = farejarTipo(bytes);
  if (!tipo) {
    return fail("unsupported_media_type", "O logo precisa ser PNG ou JPG.", 415, {
      requestId,
      // O que o cliente DISSE que mandou entra aqui e em lugar nenhum da decisão:
      // é o campo que o atacante escolhe, e guardá-lo é o que permite ver a
      // mentira no log depois.
      details: { content_type_declarado: file.type || null },
    });
  }

  const anterior = await caminhoGravado(ctx);
  const caminho = caminhoNovoDoLogo(ctx.prefixo, extensaoDe(tipo));

  const { error: erroUp } = await createAdminClient()
    .storage.from(BUCKET_DE_LOGOS)
    .upload(caminho, bytes, { contentType: tipo, upsert: false });
  if (erroUp) {
    logger.error("[marca/logo] upload falhou", { detalhe: erroUp.message, requestId });
    return fail("internal_error", "Erro ao subir o logo.", 500, { requestId });
  }

  const recusa = await gravarCaminho(ctx, caminho);
  if (recusa) {
    // A gravação falhou DEPOIS do upload: o arquivo novo é que vira órfão, não o
    // antigo. Tentar apagá-lo aqui seria o caminho certo e não é obrigatório —
    // por isso é `void`, sem `await` no caminho de erro.
    void createAdminClient().storage.from(BUCKET_DE_LOGOS).remove([caminho]);
    return fail(recusa.codigo, recusa.mensagem, recusa.status, { requestId });
  }

  await apagarAnterior(ctx, anterior);
  await registrarAuditoria(ctx, req, requestId, "definido");

  return ok(
    { logo_path: caminho, logo_url: urlPublicaDoLogo(caminho, baseDoStorage()) },
    { requestId },
  );
}

/**
 * Remove o logo desta camada — e o produto volta a mostrar o da camada de baixo.
 *
 * Mesma ordem do POST na parte que importa: apaga o PONTEIRO primeiro, o arquivo
 * depois. Se a remoção do arquivo falhar, sobra um órfão; se fosse ao contrário,
 * a tela apontaria para um objeto que não existe mais.
 */
export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const escopoLido = escopoSchema.safeParse(new URL(req.url).searchParams.get("escopo"));
  if (!escopoLido.success) {
    return fail("validation_failed", "Parâmetro 'escopo' inválido.", 422, { requestId });
  }

  const aberto = await abrirContexto(escopoLido.data);
  if ("recusa" in aberto) {
    return fail(aberto.recusa.codigo, aberto.recusa.mensagem, aberto.recusa.status, { requestId });
  }
  const ctx = aberto.ctx;

  const limite = await checkRateLimit(
    `marca-logo:${ctx.userId}`,
    TETO_POR_USUARIO,
    JANELA_SEGUNDOS,
  );
  if (!limite.allowed) {
    return fail("rate_limited", "Muitas trocas de logo seguidas. Tente em alguns minutos.", 429, {
      requestId,
      headers: { "Retry-After": String(JANELA_SEGUNDOS) },
    });
  }

  const anterior = await caminhoGravado(ctx);
  const recusa = await gravarCaminho(ctx, null);
  if (recusa) return fail(recusa.codigo, recusa.mensagem, recusa.status, { requestId });

  await apagarAnterior(ctx, anterior);
  await registrarAuditoria(ctx, req, requestId, "removido");

  return ok({ logo_path: null, logo_url: null }, { requestId });
}
