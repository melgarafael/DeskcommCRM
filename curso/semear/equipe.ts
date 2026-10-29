/**
 * Semente do módulo Equipe: a disponibilidade de cada atendente (plantão,
 * capacidade, jornada e sinal de tela), um ex-funcionário com acesso revogado e
 * quatro convites em estados diferentes (pendente sem e-mail, pendente reenviado,
 * expirado e aceito).
 *
 * Idempotente: disponibilidade por upsert; convites apagados e recriados pelos
 * ids fixos desta semente; o Marcos é criado uma vez e tem o vínculo regravado.
 *
 * ⚠️ O que sobra depois da última lição: o Marcos fica na organização como
 * membro REVOGADO (fora do roteamento e das listas de quem atende), e a
 * disponibilidade do trio fica como abaixo. A jornada da Ana e do Carlos é
 * reescrita pela semente da Agenda; a da Helena fica vazia, como numa
 * instalação nova.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

const conviteId = (n: number) => `be400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MARCOS = { email: "marcos.teixeira@clinicabemviver.com.br", nome: "Marcos Teixeira" };
const SP = "America/Sao_Paulo";
const DIA = 24 * 60;
const daqui = (minutos: number) => new Date(Date.now() + minutos * 60_000).toISOString();

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  // ---------- disponibilidade: um de cada estado ----------
  const util = (inicio: string, fim: string) => [1, 2, 3, 4, 5].map((dow) => ({ dow, start: inicio, end: fim }));
  const DISPONIBILIDADE = [
    // chave ligada e jornada vazia: "De plantão" a qualquer hora, mas "Não publicado" na Agenda
    { user_id: pessoa.helena, is_available: true, capacity: 8, schedule: { timezone: SP, windows: [] }, last_heartbeat_at: new Date().toISOString() },
    // chave ligada e jornada de segunda a sexta: "De plantão" ou "Fora do horário", conforme a hora
    { user_id: pessoa.ana, is_available: true, capacity: 5, schedule: { timezone: SP, windows: util("08:00", "18:00") }, last_heartbeat_at: ha(95) },
    // chave desligada, sem jornada e sem nunca ter aberto a tela
    { user_id: pessoa.carlos, is_available: false, capacity: 4, schedule: { timezone: SP, windows: [] }, last_heartbeat_at: null },
  ];
  semErro(await db.from("attendant_availability").upsert(
    DISPONIBILIDADE.map((d) => ({ ...d, organization_id: org, updated_at: new Date().toISOString() })),
    { onConflict: "organization_id,user_id" },
  ), "disponibilidade");

  // ---------- ex-funcionário com acesso revogado ----------
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
  semErro(await db.from("user_organizations").upsert({
    user_id: marcos, organization_id: org, role: "agent", invited_by: pessoa.helena,
    invited_at: ha(120 * DIA), accepted_at: ha(119 * DIA), revoked_at: ha(12 * DIA),
  }, { onConflict: "user_id,organization_id" }), "vínculo do Marcos");
  semErro(await db.from("attendant_availability").delete().eq("organization_id", org).eq("user_id", marcos), "disponibilidade do Marcos");

  // ---------- convites (valem 24 h: INVITE_TTL_SECONDS em lib/auth/invite-token.ts) ----------
  const CONVITES = [
    // o e-mail não saiu (instalação sem provedor de e-mail): o link é copiado à mão
    { n: 1, email: "joana.martins@clinicabemviver.com.br", role: "agent", email_dispatched: false, created_at: ha(3 * 60), last_sent_at: ha(3 * 60), resend_count: 0, expires_at: daqui(21 * 60) },
    { n: 2, email: "paulo.andrade@clinicabemviver.com.br", role: "manager", email_dispatched: true, created_at: ha(2 * DIA), last_sent_at: ha(5 * 60), resend_count: 1, expires_at: daqui(19 * 60) },
    { n: 3, email: "livia.nutricao@gmail.com", role: "agent", email_dispatched: true, created_at: ha(4 * DIA), last_sent_at: ha(4 * DIA), resend_count: 0, expires_at: ha(3 * DIA) },
    { n: 4, email: "ana@clinicabemviver.com.br", role: "agent", email_dispatched: true, created_at: ha(40 * DIA), last_sent_at: ha(40 * DIA), resend_count: 0, expires_at: ha(39 * DIA), accepted_at: ha(40 * DIA - 120), accepted_by: pessoa.ana },
  ];
  const ids = CONVITES.map((v) => conviteId(v.n));
  semErro(await db.from("team_invites").delete().eq("organization_id", org).in("id", ids), "limpar convites");
  // um pendente por e-mail: um convite de verdade para o mesmo endereço bloquearia o insert
  semErro(await db.from("team_invites").delete().eq("organization_id", org).in("email", CONVITES.map((v) => v.email)), "limpar convites do mesmo e-mail");
  exigir(await db.from("team_invites").insert(CONVITES.map(({ n, ...v }) => ({
    ...v, id: conviteId(n), organization_id: org, invited_by: pessoa.helena, inviter_name: "Helena Prado",
  }))).select("id"), "convites");
}
