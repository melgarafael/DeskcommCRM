/**
 * Semente do módulo "Cobrança (Admin)" (/admin/cobranca).
 *
 * A tela só existe com a cobrança do revendedor ligada NA INSTALAÇÃO
 * (`MODULO_COBRANCA` em platform_config), e a base volta ao estado de fábrica
 * antes de cada lição — então ligamos aqui, junto com o que a aba Conexão
 * grava (`app/api/v1/admin/cobranca/conexao/route.ts`): COBRANCA_PROVEDOR em
 * claro, a chave secreta e o segredo do aviso CIFRADOS com a AI_CRED_AES_KEY do
 * app. A chave é `sk_test_…`: a tela mostra MODO DE TESTE e a faixa amarela.
 *
 * Planos: os três de "Plano e cobrança" (mesmos ids e valores, para os dois
 * módulos verem o mesmo catálogo em qualquer ordem), com o Essencial marcado
 * para o cadastro, e um plano negociado que só o dono atribui. Cinco empresas
 * de exemplo, uma por situação da aba Clientes (em dia, em atraso com link de
 * pagamento, teste grátis, troca de plano agendada, cobrança dupla). Nenhuma
 * tem Helena, Ana ou Carlos como membro; `created_by` nulo de propósito: o
 * gatilho `fn_trial_na_criacao_da_org` só age em org com criador.
 *
 * A assinatura da Clínica Bem Viver (deixada por "Plano e cobrança", que a
 * recria a cada lição) sai daqui: senão a lista de Clientes mudaria conforme a
 * ordem em que os módulos foram fotografados.
 *
 * Nenhum provedor é chamado: os ids da Stripe são de mentira e as lições não
 * clicam em "Testar e conectar", "Salvar plano" nem "Salvar régua".
 */
import { createCipheriv, randomBytes } from "node:crypto";

import { type Contexto, exigir, semErro } from "../semear-demonstracao";

const DIA = 24 * 60 * 60_000;
const HORA = 60 * 60_000;
const plano = (n: number) => `be7c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NEGOCIADO = "c0b40000-0000-4000-8000-0000000000a1";
const org = (n: number) => `c0b40000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AVISO = "c0b40000-0000-4000-8000-0000000000e1";

const bytea = (b: Buffer) => `\\x${b.toString("hex")}`;
/** O envelope de `lib/crypto/aes_gcm.ts` (encryptKey + bufToBytea), sem importar o env do app. */
function cifrado(valor: string) {
  const chave = Buffer.from(process.env.AI_CRED_AES_KEY ?? "", "base64");
  if (chave.length !== 32) throw new Error("admin-cobranca: AI_CRED_AES_KEY ausente ou sem 32 bytes (o .env.e2e tem)");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chave, iv);
  const ct = Buffer.concat([c.update(valor, "utf8"), c.final()]);
  return { ciphertext: bytea(ct), iv: bytea(iv), tag: bytea(c.getAuthTag()), last4: valor.slice(-4), valor: null, eh_segredo: true };
}

export async function semear(c: Contexto) {
  const { db, pessoa } = c;
  const config = (chave: string, linha: Record<string, unknown>) => ({
    chave, semeado_do_env: false, updated_by: pessoa.helena, updated_at: new Date().toISOString(),
    ciphertext: null, iv: null, tag: null, last4: null, ...linha,
  });
  semErro(
    await db.from("platform_config").upsert(
      [
        config("MODULO_COBRANCA", { valor: "ligado", eh_segredo: false }),
        config("COBRANCA_PROVEDOR", { valor: "stripe", eh_segredo: false }),
        config("STRIPE_SECRET_KEY", cifrado("sk_test_51CursoBemViverDemonstracao7Xq2")),
        config("STRIPE_WEBHOOK_SECRET", cifrado("whsec_cursoBemViverDemonstracao")),
      ],
      { onConflict: "chave" },
    ),
    "ligar e conectar a cobrança",
  );

  // as assinaturas apontam para os planos (on delete restrict) e travam a exclusão da org: saem antes
  const ids = [1, 2, 3, 4, 5].map(org);
  semErro(await db.from("cobranca_assinaturas").delete().in("organization_id", [...ids, c.org]), "limpar assinaturas");
  semErro(await db.from("organizations").delete().in("id", ids), "apagar empresas de exemplo");
  semErro(await db.from("webhook_events_log").delete().eq("id", AVISO), "limpar aviso");

  semErro(
    await db.from("cobranca_planos").upsert(
      [
        { id: plano(1), nome: "Essencial", preco_cents: 19_700, max_assentos: 3, max_canais: 1, teto_ia_usd_cents: 2_000, padrao_no_cadastro: true, oferecido_ao_cliente: true },
        { id: plano(2), nome: "Profissional", preco_cents: 39_700, max_assentos: 5, max_canais: 2, teto_ia_usd_cents: 5_000, padrao_no_cadastro: false, oferecido_ao_cliente: true },
        { id: plano(3), nome: "Clínica Completa", preco_cents: 69_700, max_assentos: 10, max_canais: 3, teto_ia_usd_cents: 15_000, padrao_no_cadastro: false, oferecido_ao_cliente: true },
        { id: NEGOCIADO, nome: "Rede Parceira (negociado)", preco_cents: 149_000, max_assentos: 30, max_canais: 6, teto_ia_usd_cents: 30_000, padrao_no_cadastro: false, oferecido_ao_cliente: false },
      ].map((p) => ({ ...p, moeda: "BRL", intervalo: "mes", trial_dias: 14, arquivado_em: null })),
      { onConflict: "id" },
    ),
    "planos",
  );

  // depois da org principal, nunca no futuro (a base já chegou a mirar a org mais antiga)
  const principal = exigir(await db.from("organizations").select("created_at").eq("id", c.org).single(), "criação da org principal") as { created_at: string };
  const depois = (min: number) => new Date(Math.min(new Date(principal.created_at).getTime() + min * 60_000, Date.now() - (10 - min) * 1000)).toISOString();
  const empresas: Array<[n: number, slug: string, nome: string, razao: string]> = [
    [1, "curso-odonto-sorriso-leve", "Odonto Sorriso Leve", "Odonto Sorriso Leve Clínica Odontológica Ltda"],
    [2, "curso-fisiovida-reabilitacao", "FisioVida Reabilitação", "FisioVida Fisioterapia e Reabilitação Ltda"],
    [3, "curso-nutribem-consultorio", "NutriBem Consultório", "NutriBem Consultório de Nutrição Ltda"],
    [4, "curso-studio-movimento-pilates", "Studio Movimento Pilates", "Studio Movimento Pilates e Fisioterapia Ltda"],
    [5, "curso-rede-sorrir-odontologia", "Rede Sorrir Odontologia", "Rede Sorrir Odontologia Integrada Ltda"],
  ];
  semErro(
    await db.from("organizations").insert(
      empresas.map(([n, slug, nome, razao]) => ({
        id: org(n), slug, display_name: nome, legal_name: razao, status: "active",
        onboarded_at: depois(n + 0.5), created_at: depois(n), settings: {},
      })),
    ),
    "empresas de exemplo",
  );

  const agora = Date.now();
  const em = (ms: number) => new Date(agora + ms).toISOString();
  const pelaStripe = (n: number) => ({
    provedor: "stripe", modo: "teste", provedor_cliente_id: `cus_curso_${n}`, provedor_assinatura_id: `sub_curso_${n}`, assinaturas_vivas: 1,
  });
  semErro(
    await db.from("cobranca_assinaturas").insert([
      { organization_id: org(1), plano_id: plano(2), estado: "ativa", ...pelaStripe(1),
        periodo_pago_desde: em(-12 * DIA), proximo_vencimento: em(18 * DIA), relida_em: em(-2 * HORA) },
      { organization_id: org(2), plano_id: plano(3), estado: "em_atraso", ...pelaStripe(2),
        periodo_pago_desde: em(-33 * DIA), proximo_vencimento: em(-3 * DIA), vencida_desde: em(-3 * DIA), relida_em: em(-1 * HORA),
        link_de_pagamento: "https://invoice.stripe.com/i/acct_curso/test_fisiovida" },
      { organization_id: org(3), plano_id: plano(1), estado: "trial", trial_ate: em(9 * DIA), assinaturas_vivas: 0 },
      { organization_id: org(4), plano_id: plano(1), plano_agendado_id: plano(2), estado: "ativa", ...pelaStripe(4),
        periodo_pago_desde: em(-20 * DIA), proximo_vencimento: em(10 * DIA), relida_em: em(-3 * HORA) },
      { organization_id: org(5), plano_id: NEGOCIADO, estado: "ativa", ...pelaStripe(5), assinaturas_vivas: 2,
        periodo_pago_desde: em(-5 * DIA), proximo_vencimento: em(25 * DIA), relida_em: em(-2 * HORA) },
    ]),
    "assinaturas",
  );

  // o último aviso de pagamento da Stripe (ponteiro {id,type}, como o webhook grava)
  semErro(
    await db.from("webhook_events_log").insert({
      id: AVISO, provider: "stripe", organization_id: null, raw_body: JSON.stringify({ id: "evt_curso_1", type: "invoice.paid" }),
      valid_signature: true, event_type: "invoice.paid", external_id: "evt_curso_1", status: "processed",
      processed_at: em(-3 * HORA), received_at: em(-3 * HORA),
    }),
    "último aviso da Stripe",
  );
}
