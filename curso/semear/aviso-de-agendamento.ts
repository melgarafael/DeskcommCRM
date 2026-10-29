/**
 * Semente do módulo "Aviso de agendamento" (/app/agenda/avisos): o aviso já
 * configurado e ligado — saindo pela "Recepção Bem Viver" para o celular da
 * Helena — e os últimos avisos de dois dias, com um de cada tipo de linha que a
 * tela sabe mostrar (novo, remarcado, cancelado, resumo do dia, um que não saiu
 * e um que caiu na madrugada e entrou no resumo).
 *
 * O aviso de CASO volta ao estado de fábrica (sem número): é ele que decide se a
 * chave "Usar o mesmo número do aviso de caso" aparece livre ou travada, e uma
 * sobra de outro módulo mudaria a tela debaixo das lições.
 *
 * Idempotente: a configuração é por upsert (uma linha por organização) e as
 * entregas são apagadas e recriadas pelos ids fixos desta semente.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

const entregaId = (n: number) => `be7a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eventoId = (n: number) => `be7b0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CELULAR_DA_HELENA = "+5531998764521";

/** Instante de "N dias atrás às h:m" em São Paulo (UTC-3, sem horário de verão). */
function diasAtras(n: number, h: number, m: number) {
  const sp = new Date(Date.now() - 3 * 3_600_000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() - n, h + 3, m));
}
const dia = (n: number) => diasAtras(n, 12, 0).toISOString().slice(0, 10);

export async function semear(c: Contexto) {
  const { db, org, sessao, pessoa } = c;

  semErro(await db.from("config_aviso_de_caso").delete().eq("organization_id", org), "aviso de caso de fábrica");

  // service role: a RPC da tela (fn_definir_aviso_de_agendamento) exige auth.uid()
  semErro(await db.from("config_aviso_de_agendamento").upsert({
    organization_id: org, usa_numero_do_aviso_de_caso: false, channel_session_id: sessao,
    telefone_destino: CELULAR_DA_HELENA, ligado: true, criado_por: pessoa.helena, atualizado_por: pessoa.helena,
    updated_at: diasAtras(3, 18, 20).toISOString(),
  }, { onConflict: "organization_id" }), "config do aviso de agendamento");

  const ids = Array.from({ length: 7 }, (_, i) => entregaId(i + 1));
  semErro(await db.from("entregas_de_aviso_de_agendamento").delete().eq("organization_id", org).in("id", ids), "limpar entregas");

  type Linha = { n: number; quando: Date; evento?: string; status: string; erro?: string; enviado?: boolean; resumoDoDia?: number };
  const LINHAS: Linha[] = [
    { n: 1, quando: diasAtras(1, 16, 40), evento: "appointment.cancelled", status: "enviado", enviado: true },
    { n: 2, quando: diasAtras(1, 11, 15), evento: "appointment.rescheduled", status: "enviado", enviado: true },
    { n: 3, quando: diasAtras(1, 9, 2), evento: "appointment.created", status: "falhou", erro: "canal_desconectado" },
    { n: 4, quando: diasAtras(1, 7, 0), status: "enviado", enviado: true, resumoDoDia: 1 },
    { n: 5, quando: diasAtras(2, 23, 10), evento: "appointment.created", status: "no_resumo" },
    { n: 6, quando: diasAtras(2, 14, 30), evento: "appointment.created", status: "enviado", enviado: true },
    { n: 7, quando: diasAtras(2, 7, 0), status: "enviado", enviado: true, resumoDoDia: 2 },
  ];
  semErro(await db.from("entregas_de_aviso_de_agendamento").insert(LINHAS.map((l) => ({
    id: entregaId(l.n), organization_id: org,
    tipo: l.resumoDoDia ? "resumo" : "aviso",
    event_id: l.resumoDoDia ? null : eventoId(l.n),
    evento: l.evento ?? null,
    dia: l.resumoDoDia ? dia(l.resumoDoDia) : null,
    destino: CELULAR_DA_HELENA, channel_session_id: sessao,
    status: l.status, tentativas: l.status === "falhou" ? 3 : 1, erro_codigo: l.erro ?? null,
    enviado_em: l.enviado ? l.quando.toISOString() : null,
    created_at: l.quando.toISOString(),
  }))), "entregas do aviso de agendamento");
}
