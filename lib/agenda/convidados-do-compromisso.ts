/**
 * QUEM DA EQUIPE ESTÁ CONVIDADO — carregado na hora do ENVIO (#4006).
 *
 * Os convidados moram em `calendar_appointment_team_guests` como PESSOAS (ids),
 * e o Google precisa de e-mails. Este é o único lugar que faz essa tradução, e
 * ele roda dentro da sincronização, não na tela: o e-mail que vale é o de AGORA
 * (a pessoa pode ter conectado outra conta Google depois de marcada).
 *
 * ─── Duas listas, e a diferença importa ────────────────────────────────────
 *
 * · `ativos` — quem recebe o convite. Sai de `removed_at is null`.
 * · `conhecidos` — todo e-mail que já foi gerenciado por nós, inclusive os
 *   removidos. É com ele que o `delta` sabe que pode TIRAR alguém do
 *   `attendees`; sem a memória do removido, o convite ficaria vivo no Google
 *   para sempre.
 *
 * ─── Falha de leitura não inventa convidado ────────────────────────────────
 *
 * Sem banco, a lista volta vazia (e o evento segue como sempre foi). O
 * contrário — chutar endereços ou convidar a organização inteira — mandaria
 * convite de reunião a quem ninguém escolheu.
 */
import { isServiceRoleConfigured } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { convidadosDaEquipe, emailDoConvidado, type MembroConvidavel } from "./convidados-da-equipe";
import { rotulosDosResponsaveisDaAgenda } from "./rotulos-dos-responsaveis";

export interface ConvidadosDoCompromisso {
  /** E-mails de quem recebe o convite, já resolvidos e deduplicados. */
  ativos: { email: string; nome: string | null }[];
  /** Todo e-mail já gerenciado, inclusive de quem saiu do convite. */
  conhecidos: string[];
}

const VAZIO: ConvidadosDoCompromisso = { ativos: [], conhecidos: [] };

/** Só estes status descrevem uma conexão que ainda recebe convite. */
const CONEXAO_SAUDAVEL = "healthy";

export async function carregarConvidadosDoCompromisso(
  db: { from: (tabela: string) => any },
  org: string,
  appointmentId: string,
): Promise<ConvidadosDoCompromisso> {
  try {
    const { data: linhas, error } = await db
      .from("calendar_appointment_team_guests")
      .select("user_id,removed_at")
      .eq("organization_id", org)
      .eq("appointment_id", appointmentId);
    if (error || !linhas || linhas.length === 0) return VAZIO;

    const rows = linhas as { user_id: string; removed_at: string | null }[];
    const todos = [...new Set(rows.map((r) => r.user_id))];
    const ativosIds = rows.filter((r) => r.removed_at === null).map((r) => r.user_id);

    const membros = await montarMembros(db, org, todos);
    const ativos = convidadosDaEquipe(membros, ativosIds);

    // Os "conhecidos" incluem quem saiu: é a memória que permite REMOVER do
    // Google. Um e-mail resolvido hoje pode ser diferente do da época — por
    // isso a lista também carrega o e-mail da conexão ATUAL de cada pessoa e,
    // quando existe, o de login.
    const conhecidos = new Set<string>();
    for (const membro of membros) {
      const atual = emailDoConvidado(membro);
      if (atual) conhecidos.add(atual.toLowerCase());
      const login = membro.emailDeLogin?.trim();
      if (login) conhecidos.add(login.toLowerCase());
      const google = membro.emailGoogle?.trim();
      if (google) conhecidos.add(google.toLowerCase());
    }

    return { ativos, conhecidos: [...conhecidos] };
  } catch (erro) {
    logger.warn("[agenda-convidados] leitura falhou; o evento segue sem convidados da equipe", {
      organization_id: org,
      appointment_id: appointmentId,
      erro: erro instanceof Error ? erro.name : "desconhecido",
    });
    return VAZIO;
  }
}

/**
 * Monta o membro convidável: nome, e-mail de login e e-mail do Google saudável.
 *
 * `user_organizations` só entra para confirmar VÍNCULO (a FK composta da tabela
 * já garante, mas a leitura é barata e falha fechada). O e-mail de login vem do
 * admin do Supabase Auth — é o mesmo caminho de `rotulosDosResponsaveisDaAgenda`.
 */
async function montarMembros(
  db: { from: (tabela: string) => any },
  org: string,
  userIds: readonly string[],
): Promise<MembroConvidavel[]> {
  const nomes = await rotulosDosResponsaveisDaAgenda(userIds);

  const { data: conexoes } = await db
    .from("calendar_connections")
    .select("user_id,account_email,status")
    .eq("organization_id", org)
    .in("user_id", [...userIds]);

  const google = new Map<string, string>();
  for (const c of (conexoes ?? []) as { user_id: string; account_email: string; status: string }[]) {
    if (c.status !== CONEXAO_SAUDAVEL) continue;
    const email = c.account_email?.trim();
    if (email && !google.has(c.user_id)) google.set(c.user_id, email);
  }

  const login = await emailsDeLogin(userIds);

  return userIds.map((user_id) => ({
    user_id,
    nome: nomes.get(user_id)?.full_name ?? null,
    emailDeLogin: login.get(user_id) ?? "",
    emailGoogle: google.get(user_id) ?? null,
    googleSaudavel: google.has(user_id),
    ativo: true,
  }));
}

/** E-mail de login de cada pessoa — `Map` vazio quando o admin não está disponível. */
async function emailsDeLogin(userIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    if (!isServiceRoleConfigured()) return out;
    const admin = createAdminClient();
    await Promise.all(
      userIds.map(async (id) => {
        try {
          const { data } = await admin.auth.admin.getUserById(id);
          const email = data?.user?.id === id ? data.user.email?.trim() : "";
          if (email) out.set(id, email);
        } catch {
          // Sem e-mail de login a pessoa não vira convidado — e é o certo:
          // inventar endereço manda convite para a caixa errada.
        }
      }),
    );
  } catch {
    // idem
  }
  return out;
}
