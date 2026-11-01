/**
 * Semente do módulo Meta de vendas: nove negócios GANHOS no funil Pacientes,
 * fechados dentro do mês corrente, para o painel "Meta do mês" do Desempenho
 * ter um realizado contra o alvo que a lição cadastra pela tela.
 *
 * Apaga a meta da organização (as lições a gravam pela tela, e cada lição parte
 * de "sem meta") e os próprios negócios (ids fixos), e recria os negócios.
 *
 * ─── O mês é o de São Paulo, o fuso do navegador do capturador ──────────────
 * O painel "Meta do mês" pede ao servidor a janela do mês LOCAL do navegador
 * (`janelaDoMes(mesLocal())`, rodando no browser), e o capturador abre o
 * navegador em `America/Sao_Paulo`. Por isso o fechamento é calculado no
 * calendário de São Paulo, e cai SEMPRE entre a meia-noite do dia 1º desse mês
 * e agora — em qualquer dia, inclusive nos primeiros minutos do dia 1º.
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

/** São Paulo não tem horário de verão desde 2019: UTC−3 o ano inteiro. */
const SP_MS = 3 * 3_600_000;

/**
 * As metas da organização de demonstração só nascem nas aulas deste módulo (pela
 * tela de Meta de vendas), e uma meta que sobra muda o painel "Meta do mês" nas
 * fotos do Desempenho, que esperam "Nenhuma meta cadastrada para este mês.".
 */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  semErro(await db.from("crm_metas").delete().eq("organization_id", org), "limpar metas");
  semErro(
    await db.from("crm_leads").delete().eq("organization_id", org).in("id", GANHOS.map((_, i) => negocioId(i + 1))),
    "limpar negócios da meta",
  );
}

export async function semear(c: Contexto) {
  const { db, org, pessoa, funil } = c;

  await limpar(c);

  const ganho = exigir(
    await db.from("crm_stages").select("id").eq("pipeline_id", funil.id).eq("is_won", true).limit(1).single(),
    "etapa de ganho",
  ) as { id: string };

  const agora = Date.now();
  const sp = new Date(agora - SP_MS);
  const hojeNoMes = sp.getUTCDate();

  // A tela de Meta de vendas escolhe o mês no SERVIDOR (fuso do processo, UTC na
  // bancada), e o painel do Desempenho no NAVEGADOR (São Paulo). Das 21h à
  // meia-noite do último dia do mês os dois discordam: a meta é gravada no mês
  // seguinte e o painel do mês corrente segue "sem meta". A semente não alcança
  // esse defeito do produto; ela só avisa, para a falha não parecer de seletor.
  const servidor = new Date(agora);
  if (servidor.getUTCMonth() !== sp.getUTCMonth()) {
    console.warn(
      "aviso meta-de-vendas: virada de mês — em São Paulo ainda é " +
        `${String(sp.getUTCMonth() + 1).padStart(2, "0")}/${sp.getUTCFullYear()}, no servidor (UTC) já é ` +
        `${String(servidor.getUTCMonth() + 1).padStart(2, "0")}/${servidor.getUTCFullYear()}. ` +
        "A tela de meta grava o mês do servidor e o Desempenho lê o do navegador; capture depois da meia-noite de São Paulo.",
    );
  }

  // Meia-noite de hoje e do dia 1º, no calendário de São Paulo, como instantes.
  const inicioDeHoje = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), hojeNoMes) + SP_MS;
  for (const [i, x] of GANHOS.entries()) {
    // Até a véspera: x.dias atrás, sem passar do dia 1º, às 14h10 (+i min) de São Paulo.
    // No dia 1º não há véspera no mês: todos fecham HOJE, entre a meia-noite e agora,
    // em frações decrescentes do tempo já passado — nunca no mês anterior, nunca no futuro.
    const dias = Math.min(x.dias, hojeNoMes - 1);
    const instante = dias > 0
      ? Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), hojeNoMes - dias, 14, 10 + i) + SP_MS
      : inicioDeHoje + Math.floor(((agora - inicioDeHoje) * (GANHOS.length - i)) / (GANHOS.length + 1));
    const quando = new Date(instante).toISOString();
    semErro(await db.from("crm_leads").insert({
      id: negocioId(i + 1), organization_id: org, pipeline_id: funil.id, stage_id: ganho.id,
      title: x.titulo, value_cents: x.reais * 100, currency: "BRL", status: "won", closed_at: quando,
      owner_user_id: pessoa[x.dono], owner_kind: "user", assigned_at: quando,
      position_in_stage: 9000 + i * 1000, created_at: quando,
    }), `negócio ${x.titulo}`);
  }
}
