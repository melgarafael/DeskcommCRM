/**
 * Semente do módulo Platform Admins (Admin): além da Helena (a dona, que a
 * instalação já cria), dois acessos de exemplo para a tabela ter um de cada:
 *
 *  - Carlos Mendes: ativo, só de leitura (`support_readonly`), obrigado a usar
 *    a verificação em duas etapas.
 *  - Marcos Teixeira: o técnico de TI que teve acesso total e foi revogado.
 *    É o mesmo ex-funcionário da semente da Equipe (achado pelo e-mail).
 *
 * Datas entre a concessão da Helena (a instalação) e agora, para a ordem da
 * tabela (mais novo primeiro) contar uma história coerente.
 *
 * Idempotente: upsert pela chave (`user_id`). A base devolve `platform_admins`
 * ao estado de fábrica antes de cada lição, então estas linhas nunca vazam para
 * outro módulo — e ninguém daqui entra logado como Carlos nem como Marcos.
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";

const MARCOS = { email: "marcos.teixeira@clinicabemviver.com.br", nome: "Marcos Teixeira" };

export async function semear(c: Contexto) {
  const { db, pessoa } = c;

  const r = await db.auth.admin.listUsers({ perPage: 1000 });
  if (r.error) throw new Error(`listUsers: ${r.error.message}`);
  let marcos = r.data.users.find((u) => u.email === MARCOS.email)?.id;
  if (!marcos) {
    const novo = await db.auth.admin.createUser({
      email: MARCOS.email, password: crypto.randomUUID(), email_confirm: true, user_metadata: { full_name: MARCOS.nome },
    });
    if (novo.error || !novo.data.user) throw new Error(`createUser Marcos: ${novo.error?.message ?? "sem usuário"}`);
    marcos = novo.data.user.id;
  }

  const helena = exigir(
    await db.from("platform_admins").select("granted_at").eq("user_id", pessoa.helena).single(),
    "concessão da Helena",
  ) as { granted_at: string };
  const inicio = new Date(helena.granted_at).getTime();
  const em = (fracao: number) => new Date(inicio + (Date.now() - inicio) * fracao).toISOString();

  semErro(await db.from("platform_admins").upsert([
    {
      user_id: marcos, granted_by: pessoa.helena, granted_at: em(0.2), scope: "full", mfa_required: false,
      reason: "Suporte de TI da clínica", revoked_at: em(0.6), revoked_by: pessoa.helena, revoke_reason: "Saiu da clínica",
    },
    {
      user_id: pessoa.carlos, granted_by: pessoa.helena, granted_at: em(0.8), scope: "support_readonly", mfa_required: true,
      reason: "Acompanhar o painel, sem alterar nada", revoked_at: null, revoked_by: null, revoke_reason: null,
    },
  ], { onConflict: "user_id" }), "platform_admins de exemplo");
}
