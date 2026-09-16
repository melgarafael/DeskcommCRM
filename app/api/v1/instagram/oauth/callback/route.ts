/**
 * GET /api/v1/instagram/oauth/callback — a volta do consentimento do Instagram.
 *
 * Pública (sem sessão, ver `lib/instagram/estado.ts` sobre por que não há
 * cookie de vínculo aqui). Confere o `state`, troca o código por um token de
 * longa duração, descobre de quem é a conta, cifra e grava a conexão. Sempre
 * responde uma página em português — nunca JSON, nunca redirect para um
 * painel que o lead não tem.
 *
 * ─── A ORDEM DOS PASSOS É CONTRATO, mesmo raciocínio de
 *     `app/api/v1/agenda/google/callback/route.ts` ──────────────────────────
 * 1. `error` na query ANTES de tudo: "Cancelar" não é falha.
 * 2. `state` ANTES do `code`: sem org/contato não há o que auditar.
 * 3. App da organização ANTES da troca de código: sem ele a troca nem tem
 *    `client_secret` para usar.
 * 4. Perfil ANTES de cifrar/gravar: uma conta PESSOAL não deve virar linha —
 *    gravar e recusar depois na hora de publicar é o mesmo erro tarde demais.
 * 5. Cifra ANTES do upsert: gravar em claro por um instante é gravar em claro.
 */
import type { NextResponse, NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { env } from "@/lib/env";
import { verificarEstado } from "@/lib/instagram/estado";
import { instagramAppDaOrganizacao } from "@/lib/instagram/apps";
import { enderecoDeRetorno } from "@/lib/instagram/config";
import { trocarCodigoPorTokenCurto, trocarTokenCurtoPorLongo, buscarPerfil } from "@/lib/instagram/token";
import { paginaDeResultado } from "@/lib/instagram/pagina";

export const dynamic = "force-dynamic";

const PAGINA_CANCELADO = () =>
  paginaDeResultado({
    status: 200,
    titulo: "Conexão cancelada",
    mensagem: "Você não autorizou o acesso ao seu Instagram. Pode fechar esta janela e pedir um novo link quando quiser tentar de novo.",
  });

const PAGINA_FALHA_GENERICA = () =>
  paginaDeResultado({
    status: 400,
    titulo: "Não deu para conectar",
    mensagem: "Este link de conexão não é mais válido. Volte no WhatsApp e peça um novo link.",
  });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const recusa = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const stateBruto = url.searchParams.get("state");

  // 1. A pessoa desistiu na tela do Instagram. Não é falha.
  if (recusa) return PAGINA_CANCELADO();

  // 2. Quem está voltando? Sem isto não há org para auditar.
  let estado: ReturnType<typeof verificarEstado> = null;
  try {
    estado = verificarEstado(stateBruto, { segredo: env.INTERNAL_SECRET, agora: new Date() });
  } catch {
    return PAGINA_FALHA_GENERICA();
  }
  if (!estado) {
    await audit({ action: "instagram.connect_falhou", metadata: { reason: "state_invalido" } });
    return PAGINA_FALHA_GENERICA();
  }
  const { organizationId, contactId } = estado;

  if (!code) {
    await audit({
      action: "instagram.connect_falhou",
      organizationId,
      metadata: { reason: "sem_codigo", contact_id: contactId },
    });
    return PAGINA_FALHA_GENERICA();
  }

  const admin = createAdminClient();

  // 3. O App desta organização — sem ele não há client_secret para trocar o código.
  const app = await instagramAppDaOrganizacao(admin, organizationId);
  if (!app) {
    await audit({
      action: "instagram.connect_falhou",
      organizationId,
      metadata: { reason: "app_nao_configurado", contact_id: contactId },
    });
    return PAGINA_FALHA_GENERICA();
  }

  // Troca o código pelo token curto.
  const curto = await trocarCodigoPorTokenCurto(app, code, enderecoDeRetorno());
  if (!curto.ok) {
    await audit({
      action: "instagram.connect_falhou",
      organizationId,
      metadata: { reason: curto.motivo, detalhe: curto.detalhe, contact_id: contactId },
    });
    return PAGINA_FALHA_GENERICA();
  }

  // Troca pelo token de longa duração (~60 dias).
  const longo = await trocarTokenCurtoPorLongo(app, curto.accessToken, { agora: new Date() });
  if (!longo.ok) {
    await audit({
      action: "instagram.connect_falhou",
      organizationId,
      metadata: { reason: longo.motivo, detalhe: longo.detalhe, contact_id: contactId },
    });
    return PAGINA_FALHA_GENERICA();
  }

  // 4. De quem é a conta, e ela publica? Antes de gravar qualquer coisa.
  const perfil = await buscarPerfil(longo.accessToken);
  if (!perfil.ok) {
    await audit({
      action: "instagram.connect_falhou",
      organizationId,
      metadata: { reason: perfil.motivo, detalhe: perfil.detalhe, contact_id: contactId },
    });
    return PAGINA_FALHA_GENERICA();
  }
  if (perfil.accountType === "PERSONAL") {
    await audit({
      action: "instagram.connect_falhou",
      organizationId,
      metadata: { reason: "conta_pessoal", contact_id: contactId, ig_user_id: perfil.id },
    });
    return paginaDeResultado({
      status: 200,
      titulo: "Sua conta precisa ser Business ou Creator",
      mensagem:
        "O Instagram só deixa publicar automaticamente em contas Business ou Creator. No app do Instagram, vá em Configurações → Conta → Mudar para conta profissional, escolha Business ou Creator, e peça um novo link.",
    });
  }

  // 5. Cifra ANTES de gravar.
  const tokenCifrado = await encryptWebhookSecret(admin, longo.accessToken);
  if (!tokenCifrado) {
    await audit({
      action: "instagram.connect_falhou",
      organizationId,
      metadata: { reason: "cifra_indisponivel", contact_id: contactId },
    });
    return PAGINA_FALHA_GENERICA();
  }

  const { error: erroAoGravar } = await admin
    .from("instagram_connections")
    .upsert(
      {
        organization_id: organizationId,
        contact_id: contactId,
        ig_user_id: perfil.id,
        ig_username: perfil.username,
        ig_account_type: perfil.accountType,
        access_token_encrypted: tokenCifrado,
        token_expires_at: longo.expiraEm,
        connected_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: "organization_id,contact_id" },
    );

  if (erroAoGravar) {
    // Índice único de `ig_user_id` ativo: esta conta Instagram já está
    // conectada a OUTRO contato desta organização. Não decide sozinho qual
    // dos dois é o dono — recusa e nomeia o problema, quem atende resolve.
    const contaJaConectadaAOutroLead = erroAoGravar.code === "23505";
    await audit({
      action: "instagram.connect_falhou",
      organizationId,
      metadata: {
        reason: contaJaConectadaAOutroLead ? "conta_ja_conectada_a_outro_lead" : "upsert_falhou",
        detalhe: erroAoGravar.message,
        contact_id: contactId,
        ig_user_id: perfil.id,
      },
    });
    if (contaJaConectadaAOutroLead) {
      return paginaDeResultado({
        status: 200,
        titulo: "Esta conta já está conectada",
        mensagem: "Esta conta do Instagram já está conectada a outro contato nosso. Avise quem te atendeu para resolver.",
      });
    }
    return PAGINA_FALHA_GENERICA();
  }

  await audit({
    action: "instagram.connect_concluido",
    organizationId,
    metadata: { contact_id: contactId, ig_user_id: perfil.id, ig_username: perfil.username },
  });

  return paginaDeResultado({
    status: 200,
    titulo: "Instagram conectado!",
    mensagem: `Conta @${perfil.username ?? perfil.id} conectada com sucesso. Pode voltar para o WhatsApp e mandar a foto ou o vídeo que quer publicar.`,
  });
}
