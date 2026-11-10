/**
 * QUEM DA EQUIPE VIRA `attendee` NO GOOGLE (#4006).
 *
 * O compromisso guarda `team_guest_user_ids` (ids, não e-mails). O Google quer
 * e-mail. Este módulo faz a única tradução possível, e a ordem dela é decisão de
 * produto, não detalhe:
 *
 *   1. **A conta Google conectada da pessoa (a saudável primeiro)** — é o
 *      endereço que o Google reconhece como o calendário dela. Convidar o
 *      e-mail de login quando existe conta conectada põe o convite numa caixa
 *      que a pessoa não abre.
 *   2. **Sem conta conectada, o e-mail de login** — a pessoa continua vendo o
 *      compromisso, mesmo que precise aceitar no e-mail em vez de direto na
 *      agenda.
 *   3. **Sem e-mail nenhum, não vai.** Silêncio é melhor que `attendees` com
 *      string vazia: o Google recusa o EVENTO INTEIRO, não só o convidado.
 *
 * ⚠️ A conferência de organização acontece AQUI também, e não só na rota. A
 * ferramenta MCP, a automação e qualquer escrita direta passam pelo worker de
 * publicação, e ali o client é service-role: sem esta leitura, um id de outra
 * empresa gravado por qualquer caminho viraria convite de verdade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizarConvidadosDaEquipe } from "@/lib/agenda/convidados-da-equipe";

export interface ConvidadoDaEquipe {
  user_id: string;
  email: string;
  nome: string | null;
}

/** O mesmo formato que a rota do convidado digitado aceita (`emailDoConvidado`). */
const EMAIL_VALIDO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function nomeDoUsuario(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const bruto = (metadata as Record<string, unknown>).full_name;
  return typeof bruto === "string" && bruto.trim() ? bruto.trim() : null;
}

/**
 * Os convidados da equipe, já com e-mail — e só os que SÃO desta organização.
 *
 * Falha de leitura degrada para lista vazia: o compromisso continua indo para a
 * agenda do responsável. O contrário (lançar) transformaria um problema de
 * convite em compromisso que nunca chega ao Google.
 */
export async function emailsDosConvidadosDaEquipe(
  db: SupabaseClient,
  org: string,
  ids: readonly string[] | null | undefined,
): Promise<ConvidadoDaEquipe[]> {
  const pedidos = normalizarConvidadosDaEquipe(ids);
  if (!pedidos.length || typeof db.from !== "function") return [];
  try {
    const { data: membros, error: erroMembros } = await db
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", org)
      .in("user_id", pedidos)
      .is("revoked_at", null);
    if (erroMembros) return [];
    const daOrganizacao = new Set(
      ((membros ?? []) as Array<{ user_id: string }>).map((m) => String(m.user_id).toLowerCase()),
    );

    const { data: conexoes } = await db
      .from("calendar_connections")
      .select("user_id,account_email,status,updated_at")
      .eq("organization_id", org)
      .in("user_id", pedidos)
      .eq("status", "healthy")
      .order("updated_at", { ascending: false });
    const porConta = new Map<string, string>();
    for (const c of (conexoes ?? []) as Array<{ user_id: string; account_email: string | null }>) {
      const chave = String(c.user_id).toLowerCase();
      const email = typeof c.account_email === "string" ? c.account_email.trim() : "";
      if (!porConta.has(chave) && EMAIL_VALIDO.test(email)) porConta.set(chave, email);
    }

    const saida: ConvidadoDaEquipe[] = [];
    for (const id of pedidos) {
      // Id que não é membro ativo desta organização não vira convidado, ponto.
      if (!daOrganizacao.has(id)) continue;
      const conta = porConta.get(id);
      if (conta) {
        saida.push({ user_id: id, email: conta, nome: null });
        continue;
      }
      const login = await emailDeLogin(db, id);
      if (login) saida.push({ user_id: id, email: login.email, nome: login.nome });
    }
    return saida;
  } catch {
    return [];
  }
}

/**
 * Os e-mails de quem está em `deskcomm_guests` e não fica no evento: saiu da
 * lista, ou segue nela sem vínculo ativo com a organização.
 *
 * ⚠️ Não usa o filtro de membro ativo de `emailsDosConvidadosDaEquipe`: é para
 * quem saiu da empresa que a remoção mais importa. Basta o vínculo ter existido
 * nesta organização. Conta encerrada também vale, porque o convite pode ter ido
 * para ela, e por isso vão TODOS os e-mails conhecidos da pessoa.
 *
 * ⚠️ Falha de leitura LANÇA, ao contrário da função acima. O PATCH reescreve
 * `deskcomm_guests`, então seguir sem saber o e-mail apagaria o único registro de
 * quem ainda tem de sair. A passada falha e o worker tenta de novo. Com vínculo
 * lido, a pessoa existe (`on delete cascade`), logo erro do GoTrue é transitório.
 */
export async function emailsDeQuemSaiuDoEvento(
  db: SupabaseClient,
  org: string,
  publicados: readonly string[],
  listados: readonly string[],
): Promise<string[]> {
  const ids = normalizarConvidadosDaEquipe(publicados);
  if (!ids.length || typeof db.from !== "function") return [];
  const { data: vinculos, error } = await db
    .from("user_organizations")
    .select("user_id,revoked_at")
    .eq("organization_id", org)
    .in("user_id", ids);
  if (error) throw new Error("Falha ao conferir quem saiu do evento.");
  const ficam = new Set(normalizarConvidadosDaEquipe(listados));
  const sairam = ((vinculos ?? []) as Array<{ user_id: string; revoked_at: string | null }>)
    .filter((v) => v.revoked_at !== null || !ficam.has(String(v.user_id).toLowerCase()))
    .map((v) => String(v.user_id).toLowerCase());
  if (!sairam.length) return [];
  const { data: contas, error: erroContas } = await db
    .from("calendar_connections")
    .select("account_email")
    .eq("organization_id", org)
    .in("user_id", sairam);
  if (erroContas) throw new Error("Falha ao conferir quem saiu do evento.");
  const emails = ((contas ?? []) as Array<{ account_email: string | null }>).map((c) => c.account_email);
  const admin = resolveAdmin(db);
  for (const id of admin ? sairam : []) {
    const { data, error: erroUsuario } = await admin!.getUserById(id);
    if (erroUsuario) throw new Error("Falha ao conferir quem saiu do evento.");
    emails.push(data.user?.email ?? null);
  }
  return emails.filter((e): e is string => Boolean(e?.trim()));
}

/** O e-mail de login (GoTrue), que é o último recurso antes de desistir. */
async function emailDeLogin(
  db: SupabaseClient,
  userId: string,
): Promise<{ email: string; nome: string | null } | null> {
  try {
    const admin = resolveAdmin(db);
    if (!admin) return null;
    const { data, error } = await admin.getUserById(userId);
    if (error || !data?.user || data.user.id !== userId) return null;
    const email = typeof data.user.email === "string" ? data.user.email.trim() : "";
    if (!EMAIL_VALIDO.test(email)) return null;
    return { email, nome: nomeDoUsuario(data.user.user_metadata) };
  } catch {
    return null;
  }
}

/** O `auth.admin` só existe no client service-role; stub de teste não tem. */
function resolveAdmin(
  db: SupabaseClient,
): { getUserById: SupabaseClient["auth"]["admin"]["getUserById"] } | null {
  const auth = (db as { auth?: { admin?: { getUserById?: unknown } } }).auth;
  const admin = auth?.admin;
  if (!admin || typeof admin.getUserById !== "function") return null;
  return admin as { getUserById: SupabaseClient["auth"]["admin"]["getUserById"] };
}
