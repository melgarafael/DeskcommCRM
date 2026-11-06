/**
 * Semente do módulo Audit (Admin): seis eventos da Clínica Bem Viver, com o
 * mesmo formato que as rotas do produto gravam (ação, recurso e metadata
 * conferidos em cada emissor), para a lista e a página de um evento terem o que
 * mostrar sem depender do que as outras lições deixaram no registro.
 *
 * O registro (`api_audit_log`) é só-acréscimo — nenhum papel apaga nem altera —,
 * então cada evento tem id fixo e é gravado uma vez só, se ainda não existir.
 * Por isso o horário é o da primeira vez que a semente rodou, e envelhece.
 * Ficam presos à organização principal: as empresas extras são apagadas antes
 * de cada lição, e o evento delas perderia o vínculo.
 */
import { type Contexto, contatoId, conversaId, exigir, ha, semErro } from "../semear-demonstracao";

export const EVENTO = {
  transferencia: "ad100000-0000-4000-8000-000000000001",
  papel: "ad100000-0000-4000-8000-000000000002",
  convite: "ad100000-0000-4000-8000-000000000003",
  agente: "ad100000-0000-4000-8000-000000000004",
  bloqueio: "ad100000-0000-4000-8000-000000000005",
  fechada: "ad100000-0000-4000-8000-000000000006",
} as const;
const DIA = 60 * 24;

/**
 * A lição "Eventos mais antigos" mostra o "Carregar mais", que só existe com mais de 50 eventos.
 * Numa bancada nova o registro ainda não acumulou isso: 50 edições de contato da Ana, mais
 * antigas que os seis eventos acima, garantem a segunda página. Mesmo formato do PATCH de contato.
 */
const ANTIGOS = Array.from({ length: 50 }, (_, i) => `ad100000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);

async function semearAntigos(c: Contexto) {
  const existentes = exigir(await c.db.from("api_audit_log").select("id").in("id", ANTIGOS), "eventos antigos") as Array<{ id: string }>;
  const novos = ANTIGOS.filter((id) => !existentes.some((x) => x.id === id)).map((id) => {
    const i = ANTIGOS.indexOf(id);
    return {
      id, organization_id: c.org, action: "contact.updated", actor_user_id: c.pessoa.ana, created_at: ha((10 + i) * DIA),
      resource_type: "contact", resource_id: contatoId((i % 12) + 1), request_id: null,
      metadata: { fields: [i % 2 ? "tags" : "email"] },
    };
  });
  if (novos.length) semErro(await c.db.from("api_audit_log").insert(novos), "eventos antigos do registro");
}

export async function semear(c: Contexto) {
  const { db, org, pessoa, agenteId } = c;
  await semearAntigos(c);
  const ids = Object.values(EVENTO);
  const existentes = exigir(await db.from("api_audit_log").select("id").in("id", ids), "eventos existentes") as Array<{ id: string }>;
  if (existentes.length === ids.length) return;

  const carlos = exigir(
    await db.from("user_organizations").select("id").eq("organization_id", org).eq("user_id", pessoa.carlos).single(),
    "vínculo do Carlos",
  ) as { id: string };

  const eventos = [
    {
      id: EVENTO.transferencia, action: "conversation.transferred", actor_user_id: pessoa.ana, created_at: ha(2 * 60 + 15),
      resource_type: "conversation", resource_id: conversaId(2), request_id: "b3f1c2a4-6d8e-4f10-9a2b-3c4d5e6f7a81",
      metadata: { to_user_id: pessoa.carlos, note: "Paciente quer falar sobre o reembolso do convênio.", negocio_aberto: "sem_negocio_aberto" },
    },
    {
      id: EVENTO.fechada, action: "conversation.closed", actor_user_id: pessoa.carlos, created_at: ha(2 * DIA),
      resource_type: "conversation", resource_id: conversaId(8), request_id: "c4a2d3b5-7e9f-4a21-8b3c-4d5e6f7a8b92",
      metadata: {},
    },
    {
      id: EVENTO.bloqueio, action: "contact.blocked", actor_user_id: null, created_at: ha(DIA),
      resource_type: "contact", resource_id: null, request_id: null,
      metadata: { reason: "stop_keyword", contact_id: contatoId(11), origem: "whatsapp" },
    },
    {
      id: EVENTO.papel, action: "team.role_changed", actor_user_id: pessoa.helena, created_at: ha(5 * DIA),
      resource_type: "membership", resource_id: carlos.id, request_id: "d5b3e4c6-8f0a-4b32-9c4d-5e6f7a8b9ca3",
      metadata: { target_user_id: pessoa.carlos, old_role: "agent", new_role: "manager" },
    },
    {
      id: EVENTO.convite, action: "member.invited", actor_user_id: pessoa.helena, created_at: ha(6 * DIA),
      resource_type: "membership", resource_id: "e6c4f5d7-9a1b-4c43-8d5e-6f7a8b9cadb4", request_id: "f7d5a6e8-0b2c-4d54-9e6f-7a8b9cadbec5",
      metadata: { email: "livia.nutri@clinicabemviver.com.br", role: "agent", email_dispatched: true, email_error: null, email_via: "resend" },
    },
    {
      id: EVENTO.agente, action: "ai_agent.published", actor_user_id: pessoa.helena, created_at: ha(8 * DIA),
      resource_type: "ai_agent", resource_id: agenteId, request_id: "a8e6b7f9-1c3d-4e65-8f7a-8b9cadbecfd6",
      metadata: { version_id: "9b7c8d0e-2f4a-4b76-9c8d-9cadbecfd0e7", previous_version_id: null },
    },
  ].filter((e) => !existentes.some((x) => x.id === e.id));
  semErro(await db.from("api_audit_log").insert(eventos.map((e) => ({ ...e, organization_id: org }))), "eventos do registro");
}
