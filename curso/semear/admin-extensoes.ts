/**
 * Semente do módulo Extensões (Admin) (/admin/extensoes).
 *
 * A tela só lê: o catálogo admitido, as extensões instaladas e, para cada uma,
 * em quantas empresas ela está vinculada e em quantas está LIGADA. Para essa
 * contagem ensinar alguma coisa, ela precisa de duas empresas e das duas
 * situações:
 *
 *  - catálogo e instalações: os mesmos da semente do módulo Extensões
 *    (curso/semear/extensoes.ts, convergente) — "Roteiro da primeira consulta"
 *    1.1.0 e "Retorno de pacientes" 1.0.0, ambas vinculadas e DESLIGADAS na
 *    Clínica Bem Viver (desligadas: ligar faria o hub do CRM das outras telas
 *    ganhar a seção de guias);
 *  - Odonto Sorriso Leve (empresa de exemplo, id fixo): "Retorno de pacientes"
 *    ligada e "Roteiro" vinculada mas desligada.
 *
 * Resultado na tela: Roteiro "0 de 2 empresa(s) com ela ligada" e Retorno
 * "1 de 2".
 *
 * Ligar numa empresa passa por fn_extensions_configure, que exige um ADMIN
 * daquela empresa como autor — e Helena não pode ser membro de empresa de
 * exemplo. O autor é Fernando Costa, a mesma conta (mesmo e-mail) que a semente
 * do Admin › Users usa como admin da Odonto, para não somar uma pessoa nova à
 * lista de usuários da instalação. A empresa (e com ela vínculos e recibos, por
 * cascata) some na limpeza da base antes de cada lição; aqui ela é apagada e
 * recriada pelo id fixo.
 */
import { randomUUID } from "node:crypto";

import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";
import { semear as semearExtensoes } from "./extensoes";

const ODONTO = "a9e00000-0000-4000-8000-000000000001";
const FERNANDO = { email: "fernando.costa@sorrisoleve.com.br", nome: "Fernando Costa" };
const EDITOR = "guias-clinica";
const PADRAO = { density: "comfortable", show_description: true };
const DIA = 24 * 60;

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  await semearExtensoes(c);

  const instalacoes = exigir(
    await db.from("extension_installations").select("id, name").eq("publisher", EDITOR).is("removed_at", null),
    "instalações",
  ) as Array<{ id: string; name: string }>;
  const idDe = (name: string) => {
    const i = instalacoes.find((x) => x.name === name);
    if (!i) throw new Error(`extensão ${name} não está instalada`);
    return i.id;
  };
  const roteiro = idDe("roteiro-primeira-consulta");
  const retorno = idDe("retorno-de-pacientes");

  async function vincular(empresa: string, ator: string, instalacao: string, ligada: boolean) {
    const atual = exigir(
      await db.from("organization_extensions").select("revision").eq("organization_id", empresa).eq("installation_id", instalacao),
      "vínculo",
    ) as Array<{ revision: number }>;
    exigir(await db.rpc("fn_extensions_configure", {
      p_actor: ator, p_organization: empresa, p_installation: instalacao, p_operation: randomUUID(),
      p_expected_revision: atual[0]?.revision ?? 0, p_enabled: ligada, p_configuration: PADRAO,
    }), `vincular ${instalacao} em ${empresa}`);
  }

  // Clínica Bem Viver: a semente de Extensões só DESLIGA vínculo que já existe; aqui ele passa a existir
  for (const id of [roteiro, retorno]) {
    const v = exigir(
      await db.from("organization_extensions").select("enabled").eq("organization_id", org).eq("installation_id", id),
      "vínculo da clínica",
    ) as Array<{ enabled: boolean }>;
    if (!v[0]) await vincular(org, pessoa.helena, id, false);
  }

  // ---------- Odonto Sorriso Leve, com Fernando Costa como admin ----------
  const principal = exigir(await db.from("organizations").select("created_at").eq("id", org).single(), "criação da org principal") as { created_at: string };
  // Mantém a cronologia depois da principal; a base identifica a dona pelo vínculo, nunca pela data.
  const depois = (min: number) => new Date(Math.min(new Date(principal.created_at).getTime() + min * 60_000, Date.now() - (10 - min) * 1000)).toISOString();
  semErro(await db.from("organizations").delete().eq("id", ODONTO), "apagar empresa de exemplo");
  semErro(await db.from("organizations").insert({
    id: ODONTO, slug: "odonto-sorriso-leve", display_name: "Odonto Sorriso Leve",
    legal_name: "Odonto Sorriso Leve Clínica Odontológica Ltda", cnpj: "23.456.789/0001-10",
    status: "active", onboarded_at: depois(3.5), created_at: depois(3), settings: { plan: "pro" },
  }), "empresa de exemplo");

  const r = await db.auth.admin.listUsers({ perPage: 1000 });
  if (r.error) throw new Error(`listUsers: ${r.error.message}`);
  let fernando = r.data.users.find((u) => u.email === FERNANDO.email)?.id;
  if (!fernando) {
    // senha aleatória: ninguém entra com esta conta
    const novo = await db.auth.admin.createUser({ email: FERNANDO.email, password: randomUUID(), email_confirm: true, user_metadata: { full_name: FERNANDO.nome } });
    if (novo.error || !novo.data.user) throw new Error(`createUser ${FERNANDO.email}: ${novo.error?.message ?? "sem usuário"}`);
    fernando = novo.data.user.id;
  }
  semErro(await db.from("user_organizations").insert({
    user_id: fernando, organization_id: ODONTO, role: "admin", invited_at: ha(90 * DIA), accepted_at: ha(89 * DIA),
  }), "Fernando na Odonto");

  await vincular(ODONTO, fernando, retorno, true);
  await vincular(ODONTO, fernando, roteiro, false);
}
