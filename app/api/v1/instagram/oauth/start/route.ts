/**
 * GET /api/v1/instagram/oauth/start?org=<uuid>&contact=<uuid>
 *
 * A IDA do consentimento. Pública (sem sessão): quem chega aqui é o LEAD,
 * clicando num link que o agente mandou pelo WhatsApp — não um membro logado
 * do CRM. `org`/`contact` na query não são controle de acesso (o link em si é
 * o segredo, como qualquer magic link); eles só decidem PARA QUEM emitir o
 * `state` assinado, que é o que o callback de fato confia.
 *
 * Sempre responde alguma coisa ao navegador — nunca 500 anônimo: um lead sem
 * conta técnica não tem o que fazer com uma stack trace.
 */
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { emitirEstado } from "@/lib/instagram/estado";
import { instagramAppDaOrganizacao } from "@/lib/instagram/apps";
import { montarUrlDeAutorizacao } from "@/lib/instagram/oauth";
import { enderecoDeRetorno } from "@/lib/instagram/config";
import { paginaDeResultado } from "@/lib/instagram/pagina";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const organizationId = url.searchParams.get("org") ?? "";
  const contactId = url.searchParams.get("contact") ?? "";

  if (!UUID_RX.test(organizationId) || !UUID_RX.test(contactId)) {
    return paginaDeResultado({
      status: 400,
      titulo: "Link inválido",
      mensagem: "Este link de conexão com o Instagram está incompleto. Peça um novo link.",
    });
  }

  const admin = createAdminClient();

  const { data: contato } = await admin
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .eq("is_anonymized", false)
    .maybeSingle();
  if (!contato) {
    return paginaDeResultado({
      status: 404,
      titulo: "Link expirado",
      mensagem: "Não encontramos o seu cadastro para este link. Peça um novo link no WhatsApp.",
    });
  }

  const app = await instagramAppDaOrganizacao(admin, organizationId);
  if (!app) {
    return paginaDeResultado({
      status: 503,
      titulo: "Instagram ainda não configurado",
      mensagem: "Esta empresa ainda não ativou a publicação automática no Instagram. Avise quem te atendeu.",
    });
  }

  let state: string;
  try {
    state = emitirEstado(
      { organizationId, contactId },
      { segredo: env.INTERNAL_SECRET, agora: new Date() },
    );
  } catch {
    return paginaDeResultado({
      status: 503,
      titulo: "Não foi possível iniciar a conexão",
      mensagem: "Tente novamente em alguns minutos. Se persistir, avise quem te atendeu.",
    });
  }

  const destino = montarUrlDeAutorizacao({
    appId: app.appId,
    redirectUri: enderecoDeRetorno(),
    state,
  });

  await audit({
    action: "instagram.connect_iniciado",
    organizationId,
    metadata: { contact_id: contactId },
  });

  return Response.redirect(destino, 302);
}
