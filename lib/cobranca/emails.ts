/**
 * QUEM RECEBE OS E-MAILS DA COBRANÇA (spec §7a, §7d). Melhor esforço, sempre:
 * a Central e a faixa já mostram o aviso, e um e-mail que não sai vira log —
 * nunca exceção, porque a régua não pode travar porque o SMTP caiu. Um e-mail
 * por pessoa: os administradores não veem uns aos outros no "Para". O log não
 * leva endereço (é dado pessoal).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcaDaSaida } from "@/lib/branding/saida";
import type { TextoDoAviso } from "@/lib/cobranca/avisos";
import { sendEmail } from "@/lib/email/roteador";
import { buildEmailDaCobranca } from "@/lib/email/templates/cobranca";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

const base = () => (env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");

async function emailsDe(admin: SupabaseClient, ids: readonly string[]): Promise<string[]> {
  const lidos = await Promise.all(
    ids.map(async (id) => (await admin.auth.admin.getUserById(id)).data.user?.email ?? null),
  );
  return [...new Set(lidos.filter((e): e is string => typeof e === "string" && e.includes("@")))];
}

async function enviarParaCada(
  para: readonly string[],
  email: { subject: string; html: string; text: string },
  fromName: string,
  contexto: Record<string, unknown>,
): Promise<void> {
  for (const to of para) {
    const r = await sendEmail({ to, subject: email.subject, html: email.html, text: email.text, fromName, tags: [{ name: "tipo", value: "cobranca" }] });
    if (!r.ok) logger.warn("cobranca.email_nao_saiu", { ...contexto, erro: r.error ?? "desconhecido", via: r.via ?? null });
  }
}

export async function enviarAvisoAosAdmins(
  admin: SupabaseClient,
  org: { id: string; idioma: Idioma },
  texto: TextoDoAviso,
  linkDePagamento: string | null,
): Promise<void> {
  try {
    const { data, error } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", org.id)
      .eq("role", "admin")
      .is("revoked_at", null);
    if (error) throw new Error(`admins ilegíveis (${error.code ?? "sem_codigo"})`);
    const para = await emailsDe(admin, ((data ?? []) as Array<{ user_id: string }>).map((l) => l.user_id));
    if (para.length === 0) return;
    const t = (s: string) => traduzir(s, org.idioma);
    const marca = await marcaDaSaida(org.id);
    const email = buildEmailDaCobranca({
      titulo: texto.titulo,
      corpo: texto.corpo,
      marca,
      idioma: org.idioma,
      botao: linkDePagamento
        ? { rotulo: t("Pagar agora"), href: linkDePagamento }
        : { rotulo: t("Abrir plano e cobrança"), href: `${base()}/app/settings/billing` },
      rodape: t("Você recebe este aviso porque administra esta empresa."),
    });
    await enviarParaCada(para, email, marca.nome, { organization_id: org.id });
  } catch (e) {
    logger.warn("cobranca.email_nao_saiu", { organization_id: org.id, erro: e instanceof Error ? e.message : "desconhecido" });
  }
}

/** Troca da chave da instalação (§7a): todo platform admin com acesso total fica sabendo. */
export async function avisarTrocaDeChave(admin: SupabaseClient, o: { antigo: string | null; novo: string }): Promise<void> {
  try {
    const { data, error } = await admin.from("platform_admins").select("user_id").eq("scope", "full").is("revoked_at", null);
    if (error) throw new Error(`donos ilegíveis (${error.code ?? "sem_codigo"})`);
    const para = await emailsDe(admin, ((data ?? []) as Array<{ user_id: string }>).map((l) => l.user_id));
    if (para.length === 0) return;
    const marca = await marcaDaSaida(null);
    const titulo = o.antigo
      ? `A chave de cobrança da instalação foi trocada (…${o.antigo} → …${o.novo})`
      : `A chave de cobrança da instalação foi conectada (…${o.novo})`;
    const email = buildEmailDaCobranca({
      titulo,
      corpo: "Se não foi você, entre em Admin › Cobrança › Conexão e conecte a chave certa agora.",
      marca,
      idioma: "pt-BR",
      botao: { rotulo: "Abrir Cobrança", href: `${base()}/admin/cobranca` },
      rodape: "Você recebe este aviso porque administra esta instalação.",
    });
    await enviarParaCada(para, email, marca.nome, { destino: "donos_da_instalacao" });
  } catch (e) {
    logger.warn("cobranca.email_nao_saiu", { destino: "donos_da_instalacao", erro: e instanceof Error ? e.message : "desconhecido" });
  }
}
