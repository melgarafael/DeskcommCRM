/**
 * Semente do módulo Meta de vendas: nove negócios GANHOS no funil Pacientes,
 * fechados dentro do mês corrente, para o painel "Meta do mês" do Desempenho
 * ter um realizado contra o alvo que a lição cadastra pela tela.
 *
 * Apaga a meta da organização (as lições a gravam pela tela, e cada lição parte
 * de "sem meta") e os próprios negócios (ids fixos), e recria os negócios.
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";

const negocioId = (n: number) => `a7e30000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const GANHOS: Array<{ titulo: string; reais: number; dono: "helena" | "ana" | "carlos"; dias: number }> = [
  { titulo: "Pacote de 10 sessões de fisioterapia — Rogério Lima", reais: 1500, dono: "helena", dias: 2 },
  { titulo: "Consulta nutricional — Beatriz Nogueira", reais: 280, dono: "ana", dias: 3 },
  { titulo: "Limpeza e avaliação odontológica — Paulo Freitas", reais: 220, dono: "carlos", dias: 5 },
  { titulo: "Acompanhamento nutricional trimestral — Júlia Castro", reais: 840, dono: "ana", dias: 6 },
  { titulo: "Clareamento dental — Mônica Tavares", reais: 1200, dono: "carlos", dias: 8 },
  { titulo: "Pilates duas vezes por semana — Sérgio Andrade", reais: 960, dono: "helena", dias: 10 },
  { titulo: "Avaliação postural — Carolina Dias", reais: 180, dono: "ana", dias: 12 },
  { titulo: "Retorno nutricional — Fábio Martins", reais: 200, dono: "helena", dias: 14 },
  { titulo: "Restauração dentária — Elaine Rocha", reais: 450, dono: "carlos", dias: 17 },
];

export async function semear(c: Contexto) {
  const { db, org, pessoa, funil } = c;

  semErro(await db.from("crm_metas").delete().eq("organization_id", org), "limpar metas");
  semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("id", GANHOS.map((_, i) => negocioId(i + 1))), "limpar negócios");

  const ganho = exigir(
    await db.from("crm_stages").select("id").eq("pipeline_id", funil.id).eq("is_won", true).limit(1).single(),
    "etapa de ganho",
  ) as { id: string };

  // Dia do mês de hoje em São Paulo: o fechamento nunca cai no mês anterior.
  // ponytail: no dia 1º todos fecham hoje, uma hora a menos cada.
  const sp = new Date(Date.now() - 3 * 3_600_000);
  const hojeNoMes = sp.getUTCDate();
  for (const [i, x] of GANHOS.entries()) {
    const dias = Math.min(x.dias, hojeNoMes - 1);
    const quando = dias > 0
      ? new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() - dias, 14 + 3, 10 + i)).toISOString()
      : new Date(Date.now() - (i + 1) * 60_000).toISOString();
    semErro(await db.from("crm_leads").insert({
      id: negocioId(i + 1), organization_id: org, pipeline_id: funil.id, stage_id: ganho.id,
      title: x.titulo, value_cents: x.reais * 100, currency: "BRL", status: "won", closed_at: quando,
      owner_user_id: pessoa[x.dono], owner_kind: "user", assigned_at: quando,
      position_in_stage: 9000 + i * 1000, created_at: quando,
    }), `negócio ${x.titulo}`);
  }
}
