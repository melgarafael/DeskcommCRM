/**
 * Semente do módulo "Plano e cobrança" (Configurações › Plano e cobrança).
 *
 * A tela só mostra o painel com a cobrança do revendedor ligada NA INSTALAÇÃO
 * (`MODULO_COBRANCA` em platform_config, a linha que `gravarModulo` grava), e a
 * base desliga tudo antes de cada lição — então ligamos aqui. Depois: três
 * planos mensais da instalação (ids fixos) e a assinatura da Clínica Bem Viver
 * EM DIA no plano do meio, paga pela Stripe — o estado em que "Gerenciar
 * pagamento", "Trocar de plano" e "Cancelar assinatura" aparecem juntos.
 *
 * Nenhum botão das lições confirma nada: o provedor nunca é chamado, e os ids
 * da Stripe abaixo são de mentira. Com a chave desligada (os outros módulos), a
 * assinatura que fica no banco é inerte: limites nulos, sem faixa, cron pula.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

const DIA = 24 * 60 * 60_000;
const plano = (n: number) => `be7c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PLANOS = [
  { id: plano(1), nome: "Essencial", preco_cents: 19_700, max_assentos: 3, max_canais: 1, teto_ia_usd_cents: 2_000 },
  { id: plano(2), nome: "Profissional", preco_cents: 39_700, max_assentos: 5, max_canais: 2, teto_ia_usd_cents: 5_000 },
  { id: plano(3), nome: "Clínica Completa", preco_cents: 69_700, max_assentos: 10, max_canais: 3, teto_ia_usd_cents: 15_000 },
];

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_COBRANCA", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar a cobrança",
  );
  // a assinatura aponta para os planos (on delete restrict): sai antes, volta depois
  semErro(await db.from("cobranca_assinaturas").delete().eq("organization_id", org), "limpar assinatura");
  semErro(
    await db.from("cobranca_planos").upsert(
      PLANOS.map((p) => ({
        ...p, moeda: "BRL", intervalo: "mes", trial_dias: 14, padrao_no_cadastro: false, oferecido_ao_cliente: true, arquivado_em: null,
      })),
      { onConflict: "id" },
    ),
    "planos",
  );
  const agora = Date.now();
  semErro(
    await db.from("cobranca_assinaturas").insert({
      organization_id: org, plano_id: plano(2), estado: "ativa", provedor: "stripe", modo: "producao",
      provedor_cliente_id: "cus_curso_bemviver", provedor_assinatura_id: "sub_curso_bemviver", assinaturas_vivas: 1,
      periodo_pago_desde: new Date(agora - 10 * DIA).toISOString(), proximo_vencimento: new Date(agora + 20 * DIA).toISOString(),
      relida_em: new Date(agora).toISOString(),
    }),
    "assinatura",
  );
}
