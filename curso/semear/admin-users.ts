/**
 * Semente do módulo Users (Admin): duas clínicas de exemplo com equipe própria,
 * para a lista de pessoas da instalação ter o que filtrar.
 *
 *  - Odonto Sorriso Leve: Fernando Costa (Admin) e Juliana Martins (Agente).
 *  - FisioVida Reabilitação: Patrícia Nogueira (Admin) e Rafael Torres (Agente,
 *    com o acesso revogado: saiu da clínica).
 *  - Marina Lopes, consultora, está nas DUAS: Manager na FisioVida e Viewer na
 *    Odonto — a lista mostra uma linha por pessoa em cada empresa.
 *
 * As contas (auth) ficam de uma rodada para a outra; os vínculos somem com as
 * empresas, que a base apaga antes de cada lição e esta semente recria pelos ids
 * fixos. Nenhuma tem Helena, Ana ou Carlos como membro. Ninguém daqui entra no
 * sistema: o "Último acesso" delas fica vazio ("—").
 *
 * `created_at` das empresas fica depois do da Clínica Bem Viver. Convite e aceite
 * são gravados depois da criação da conta, para a ficha não mostrar cronologia impossível.
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";

const ORG = {
  odonto: "a9100000-0000-4000-8000-000000000001",
  fisio: "a9100000-0000-4000-8000-000000000002",
};

const PESSOAS: Array<{ email: string; nome: string; vinculos: Array<{ org: string; role: string; revogado?: boolean }> }> = [
  { email: "fernando.costa@sorrisoleve.com.br", nome: "Fernando Costa", vinculos: [{ org: ORG.odonto, role: "admin" }] },
  { email: "juliana.martins@sorrisoleve.com.br", nome: "Juliana Martins", vinculos: [{ org: ORG.odonto, role: "agent" }] },
  { email: "patricia.nogueira@fisiovida.com.br", nome: "Patrícia Nogueira", vinculos: [{ org: ORG.fisio, role: "admin" }] },
  { email: "rafael.torres@fisiovida.com.br", nome: "Rafael Torres", vinculos: [{ org: ORG.fisio, role: "agent", revogado: true }] },
  { email: "marina.lopes@consultoriasaude.com.br", nome: "Marina Lopes", vinculos: [{ org: ORG.fisio, role: "manager" }, { org: ORG.odonto, role: "viewer" }] },
];

export async function semear(c: Contexto) {
  const { db } = c;
  const principal = exigir(await db.from("organizations").select("created_at").eq("id", c.org).single(), "criação da org principal") as { created_at: string };
  const depois = (min: number) => new Date(Math.min(new Date(principal.created_at).getTime() + min * 60_000, Date.now() - (10 - min) * 1000)).toISOString();

  semErro(await db.from("organizations").delete().in("id", Object.values(ORG)), "apagar empresas de exemplo");
  semErro(
    await db.from("organizations").insert([
      {
        id: ORG.odonto, slug: "odonto-sorriso-leve", display_name: "Odonto Sorriso Leve",
        legal_name: "Odonto Sorriso Leve Clínica Odontológica Ltda", cnpj: "23.456.789/0001-10",
        status: "active", onboarded_at: depois(3.5), created_at: depois(3), settings: { plan: "pro" },
      },
      {
        id: ORG.fisio, slug: "fisiovida-reabilitacao", display_name: "FisioVida Reabilitação",
        legal_name: "FisioVida Fisioterapia e Reabilitação Ltda", cnpj: "34.567.890/0001-21",
        status: "active", onboarded_at: depois(4.5), created_at: depois(4), settings: { plan: "standard" },
      },
    ]),
    "empresas de exemplo",
  );

  const r = await db.auth.admin.listUsers({ perPage: 1000 });
  if (r.error) throw new Error(`listUsers: ${r.error.message}`);
  const vinculos = [];
  for (const p of PESSOAS) {
    let id = r.data.users.find((u) => u.email === p.email)?.id;
    if (!id) {
      // senha aleatória: ninguém daqui entra no sistema
      const novo = await db.auth.admin.createUser({ email: p.email, password: crypto.randomUUID(), email_confirm: true, user_metadata: { full_name: p.nome } });
      if (novo.error || !novo.data.user) throw new Error(`createUser ${p.email}: ${novo.error?.message ?? "sem usuário"}`);
      id = novo.data.user.id;
    }
    for (const { org, role, revogado } of p.vinculos) {
      vinculos.push({
        user_id: id, organization_id: org, role,
        invited_at: new Date().toISOString(), accepted_at: new Date().toISOString(),
        revoked_at: revogado ? new Date().toISOString() : null,
      });
    }
  }
  semErro(await db.from("user_organizations").insert(vinculos), "equipes das empresas de exemplo");
}
