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

/**
 * `estrito`: o auth-js devolve falha de rede/5xx como `{ user: null, error }` sem
 * lançar. No melhor esforço (avisos) isso tira só aquele destinatário; em quem
 * DECIDE um dado (o e-mail gravado no provedor) tem de lançar, senão a falha
 * vira "esse admin não existe" e o próximo da fila ocupa o lugar dele.
 */
async function emailsDe(admin: SupabaseClient, ids: readonly string[], estrito = false): Promise<string[]> {
  const lidos = await Promise.all(
    ids.map(async (id) => {
      const { data, error } = await admin.auth.admin.getUserById(id);
      if (error && estrito) throw new Error(`e-mail de admin ilegível (${error.code ?? error.status ?? "sem_codigo"})`);
      return data.user?.email ?? null;
    }),
  );
  return [...new Set(lidos.filter((e): e is string => typeof e === "string" && e.includes("@")))];
}

/**
 * Admins ativos da empresa, o mais antigo primeiro. LANÇA se a leitura dos
 * vínculos falhar; a de cada e-mail só lança com `estrito`.
 * `semProvisorio` tira o vínculo que o dono ganha ao criar a empresa para outra
 * pessoa (`provisional_until_handover`, até o convite ser aceito): sem isso, o
 * "admin mais antigo" de uma empresa recém-criada é o próprio dono. `exceto`
 * tira esses usuários antes de ler o e-mail deles.
 */
export async function emailsDosAdmins(
  admin: SupabaseClient,
  orgId: string,
  {
    semProvisorio = false,
    exceto = [],
    estrito = false,
  }: { semProvisorio?: boolean; exceto?: readonly string[]; estrito?: boolean } = {},
): Promise<string[]> {
  let consulta = admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("role", "admin")
    .is("revoked_at", null);
  if (semProvisorio) consulta = consulta.eq("provisional_until_handover", false);
  const { data, error } = await consulta.order("created_at");
  if (error) throw new Error(`admins ilegíveis (${error.code ?? "sem_codigo"})`);
  const ids = ((data ?? []) as Array<{ user_id: string }>).map((l) => l.user_id);
  return emailsDe(admin, ids.filter((id) => !exceto.includes(id)), estrito);
}

/**
 * O e-mail do cliente da empresa no provedor quando quem gera o link é o dono
 * (D-15): fica gravado no cliente para sempre, então nunca o de um dono da
 * instalação. O filtro de provisório não basta: o vínculo de quem criou a
 * empresa antes da migration 0237 ficou `provisional_until_handover = false`
 * (sem expurgo retroativo) e sobrevive ao aceite do convite, ativo e mais antigo
 * que o do cliente. Os avisos (`enviarAvisoAosAdmins`) seguem chegando a ele.
 */
export async function emailDoAdminDaEmpresa(admin: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await admin.from("platform_admins").select("user_id").is("revoked_at", null);
  if (error) throw new Error(`donos ilegíveis (${error.code ?? "sem_codigo"})`);
  const donos = ((data ?? []) as Array<{ user_id: string }>).map((l) => l.user_id);
  return (await emailsDosAdmins(admin, orgId, { semProvisorio: true, exceto: donos, estrito: true }))[0] ?? null;
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
    const para = await emailsDosAdmins(admin, org.id);
    if (para.length === 0) return;
    const t = (s: string) => traduzir(s, org.idioma);
    const marca = await marcaDaSaida(org.id, { semMemo: true });
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
    const marca = await marcaDaSaida(null, { semMemo: true });
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
