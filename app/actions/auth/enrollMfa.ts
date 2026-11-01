"use server";

import QRCode from "qrcode";
import { redirect } from "next/navigation";

import { marcaDaSaida } from "@/lib/branding/saida";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { sessionAal } from "@/lib/auth/server";

export type EnrollMfaResult =
  | { ok: true; factor_id: string; qr_data_url: string; uri: string; secret: string }
  | { ok: false; error: "enroll_failed"; message?: string }
  | { ok: false; error: "mfa_required" };

/**
 * Starts a TOTP enrollment. Returns factor_id + QR data URL (PNG) + raw URI.
 * The factor remains in `unverified` status until the user submits a valid
 * 6-digit code via {@link confirmMfaEnroll}.
 *
 * If a previous unverified factor exists, we delete it first so the user can
 * re-scan a fresh QR.
 */
export async function enrollMfa(): Promise<EnrollMfaResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Drop any stale unverified TOTP factors (idempotent re-enroll).
  const { data: existing, error: listErr } = await supabase.auth.mfa.listFactors();
  // Sem a lista não dá para saber se a conta já tem fator: recusa em vez de
  // tratar como primeiro cadastro.
  if (listErr) return { ok: false, error: "enroll_failed", message: listErr.message };

  // Quem JÁ tem fator verificado só cadastra outro depois de provar o atual
  // nesta sessão (`aal2` exato). Um fator novo confirmado sobe a sessão para
  // `aal2` e emite códigos de recuperação — o mesmo que dispensar o fator antigo.
  const temFatorVerificado = existing?.all?.some(
    (f) => f.factor_type === "totp" && f.status === "verified",
  );
  if (temFatorVerificado && (await sessionAal()) !== "aal2") {
    return { ok: false, error: "mfa_required" };
  }

  for (const f of existing?.all ?? []) {
    if (f.factor_type === "totp" && f.status === "unverified") {
      // O retorno era ignorado. Falhar calado aqui deixa o fator antigo de pé, e
      // o cadastro novo morre no "already exists" do GoTrue — que a tela mostra
      // como frase genérica (#3156). A falha vai para o log do servidor (#3161).
      const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (unenrollErr) {
        logger.error("[mfa-cadastro] o fator não confirmado não pôde ser removido", {
          factor_id: f.id,
          code: unenrollErr.code,
          error: unenrollErr.message,
        });
      }
    }
  }

  // ── O campo que grava no celular é `issuer`, não `friendlyName` ───────────
  //
  // O `friendlyName` NÃO entra na URI `otpauth://` (medido contra o GoTrue
  // v2.188.1); o que o app autenticador mostra vem do `issuer` e do e-mail.
  // Ele era o único campo daqui com marca, e trocá-lo não mudava nada no
  // telefone de ninguém — a marca precisava ir para o `issuer`, que o SDK só
  // envia quando presente (`@supabase/auth-js@2.112.1`).
  //
  // Classe B: o cadastro de MFA é anterior à escolha de organização, então a
  // marca certa é a da INSTALAÇÃO — `marcaDaSaida(null)`.
  //
  // ALCANCE: isto NÃO reescreve fator já cadastrado. Vale só para quem enrolar
  // depois; o que já está no celular de alguém continua como estava.
  //
  // O sufixo de data no `friendlyName` NÃO é enfeite: o GoTrue recusa nome
  // duplicado por usuário ("A factor with the friendly name ... already
  // exists"), e é a data que evita a colisão entre tentativas. Ela é UTC, e de
  // propósito — trocar por horário local só criaria uma colisão nova perto da
  // meia-noite.
  const marca = await marcaDaSaida(null);
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Acesso ${new Date().toISOString().slice(0, 10)}`,
    issuer: marca.nome,
  });
  if (error || !data) {
    // O motivo do provedor sai da tela (#3156) e precisa ficar em algum lugar:
    // sem esta linha, quem opera a VPS vê "não consegui ativar" e nada mais.
    // Entram só o motivo e o código do erro — nem o TOTP nem o segredo passam
    // por aqui.
    logger.error("[mfa-cadastro] o provedor recusou o cadastro do fator", {
      code: error?.code,
      error: error?.message,
    });
    return { ok: false, error: "enroll_failed", message: error?.message };
  }

  // supabase-js returns: { id, type: "totp", totp: { qr_code (svg string), uri, secret } }
  // We re-render the URI to a PNG data URL for predictable rendering.
  const uri = data.totp.uri;
  const qr_data_url = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
  });

  return {
    ok: true,
    factor_id: data.id,
    qr_data_url,
    uri,
    secret: data.totp.secret,
  };
}
