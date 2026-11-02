import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { enviarPushDaOrg } from "@/lib/notifications/web_push";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * O aviso é publicado na hora em que é criado — não há cron/worker que o
 * publique depois. Um `publicar_em` no futuro, portanto, ficaria gravado e
 * NUNCA sairia; por isso ele é recusado nesta fatia (#1418) em vez de aceito
 * em silêncio. O agendamento de verdade entra junto com quem o dispara.
 *
 * A tolerância existe para o relógio do navegador que chega alguns segundos
 * adiantado ao do servidor (skew comum): um "publicar agora" com timestamp um
 * pouco à frente continua sendo "agora", e o valor gravado é achatado no
 * relógio desta rota — nenhuma linha nasce com `publicar_em > agora`. 60 s é
 * folgado para skew e curto demais para ser um agendamento intencional.
 */
const TOLERANCIA_DE_RELOGIO_MS = 60_000;

const esquema = z
  .object({
    titulo: z.string().trim().min(1),
    corpo: z.string(),
    publicar_em: z.string().datetime({ offset: true }).optional().nullable(),
    expira_em: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict();

function normalizarData(valor: string | null | undefined): string | null {
  if (!valor) return null;
  return new Date(valor).toISOString();
}

export async function POST(req: NextRequest) {
  // Guarda de EFEITO do acompanhamento administrativo: em `support_readonly` o
  // aviso sairia como push para a empresa inteira em nome do cliente. Ela não
  // substitui o RBAC abaixo — soma.
  const suporteNegado = await requireSupportWrite();
  if (suporteNegado) return suporteNegado;

  const requestId = randomUUID();

  const auth = await requireRole("admin", { requestId });
  if (!auth.ok) return auth.response;

  const t = (texto: string) => traduzir(texto, auth.user.idioma);

  const corpo = esquema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_error", t("Aviso inválido."), 400, {
      requestId,
      details: corpo.error.flatten(),
    });
  }

  const titulo = corpo.data.titulo;
  const texto = corpo.data.corpo;
  if (!texto.trim()) {
    return fail("validation_error", t("Título e corpo são obrigatórios."), 400, { requestId });
  }

  // UM relógio para a decisão, para o achatamento da tolerância e para o
  // `devePublicar` abaixo — três `new Date()` diferentes deixariam a janela
  // com frestas de milissegundos.
  const agora = new Date();
  const expiraEm = normalizarData(corpo.data.expira_em ?? null);
  let publicarEm = normalizarData(corpo.data.publicar_em ?? null);

  if (publicarEm) {
    const pedidoEm = new Date(publicarEm).getTime();
    if (pedidoEm > agora.getTime() + TOLERANCIA_DE_RELOGIO_MS) {
      // Recusa ANTES do insert: o aviso agendado não tem quem o publique, e
      // gravá-lo seria criar um recado que nunca chega. O corpo diz o que fazer.
      return fail(
        "aviso_agendado_nao_suportado",
        t("O agendamento de aviso ainda não está disponível. Publique agora ou envie sem data de publicação."),
        400,
        { requestId },
      );
    }
    if (pedidoEm > agora.getTime()) {
      // Dentro da tolerância: é "agora" com o relógio do cliente adiantado.
      publicarEm = agora.toISOString();
    }
  }

  const admin = createAdminClient();
  const { data: aviso, error } = await admin
    .from("avisos")
    .insert({
      organization_id: auth.org.orgId,
      autor_id: auth.user.id,
      titulo,
      corpo: texto,
      publicar_em: publicarEm,
      expira_em: expiraEm,
    })
    .select("id, organization_id, autor_id, titulo, corpo, publicar_em, expira_em, created_at")
    .single();

  if (error || !aviso) {
    return fail("internal_error", "Não foi possível criar o aviso.", 500, {
      requestId,
      details: error?.message,
    });
  }

  const inicio = publicarEm ? new Date(publicarEm) : agora;
  const fim = expiraEm ? new Date(expiraEm) : null;
  const devePublicar = inicio <= agora && (!fim || fim > agora);

  if (devePublicar) {
    await enviarPushDaOrg(auth.org.orgId, {
      title: titulo,
      body: texto,
      tag: `aviso:${aviso.id}`,
      href: "/app/inbox",
    });
  }

  return ok(aviso, { status: 201, requestId });
}
