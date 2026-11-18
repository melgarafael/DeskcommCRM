/**
 * O idioma da ORGANIZAÇÃO na hora de montar um e-mail (#4302).
 *
 * Fica separado de `idioma-do-email.ts` de propósito: aquele arquivo é a REGRA
 * (pura, sem I/O, testável em milissegundos) e este é a única parte que fala
 * com o Postgres. Quem chama é o envio do convite de time, que não tem sessão
 * de quem recebe — a pessoa convidada ainda não existe como usuário, então não
 * há `user_metadata.locale` a consultar. Sobra a organização, e é isso que a
 * precedência do #4302 manda olhar em segundo lugar.
 *
 * NUNCA lança: idioma é enfeite comparado ao e-mail sair. Banco fora, coluna
 * nula, instalação sem `SUPABASE_DB_URL` (a suíte unitária) — tudo cai na
 * próxima fonte da fila e, no fim, em `pt-BR`.
 */
import { portaDaAplicacao } from "@/lib/db";
import type { Idioma } from "@/lib/i18n/idiomas";

import { idiomaDoEmail } from "./idioma-do-email";

/** O `organizations.locale` cru, ou `null` quando não dá para saber. */
export async function localeDaOrganizacao(
  organizationId: string | null | undefined,
): Promise<string | null> {
  if (!organizationId) return null;
  // Sem endereço do banco não há consulta a fazer — e a suíte unitária é
  // exatamente esse caso. Sair aqui evita abrir pool para descobrir isso.
  if (!process.env.SUPABASE_DB_URL) return null;
  try {
    const linha = await portaDaAplicacao().queryOne<{ locale: string | null }>(
      "select locale from organizations where id = $1 limit 1",
      [organizationId],
    );
    return linha?.locale ?? null;
  } catch {
    return null;
  }
}

/**
 * O idioma do e-mail de uma organização, pela cadeia
 * `organização → APP_LOCALE → pt-BR` (o destinatário não é conhecido aqui).
 */
export async function idiomaDoEmailDaOrganizacao(
  organizationId: string | null | undefined,
): Promise<Idioma> {
  return idiomaDoEmail({
    organizacao: await localeDaOrganizacao(organizationId),
    instalacao: process.env.APP_LOCALE,
  });
}
