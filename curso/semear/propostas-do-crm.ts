/**
 * Semente do módulo "Propostas do CRM" (CRM › Ver tudo em CRM › Propostas,
 * /app/proposals): a lista de propostas de uma clínica que já usa o recurso.
 *
 * - um rascunho que a IA preparou para a Mariana, ainda sem modelo confirmado
 *   (o selo "Aguardando revisão" e o aviso "A IA sugeriu o modelo");
 * - uma proposta enviada à Fernanda, esperando a resposta;
 * - uma aceita e uma recusada, mais antigas, de negócios que já saíram do funil.
 *
 * Liga Propostas nos DOIS níveis, como `modelos-de-proposta.ts`: o módulo da
 * instalação (`platform_config.MODULO_PROPOSTAS`) e a chave da empresa
 * (`organizations.settings.proposals.enabled`). A base devolve as duas ao
 * estado de fábrica antes de cada lição, então `limpar` não precisa desligá-las.
 *
 * O modelo do documento é da própria semente, e não "Pacote de nutrição"
 * (de modelos-de-proposta.ts, que não tem `limpar` e pode não estar no banco):
 * só usa variáveis que a proposta preenche, para a proposta enviada não abrir
 * com "Não é possível enviar — N pendência(s)".
 *
 * Os negócios vêm da base (ids novos a cada rodada); acha-os pelo contato.
 */
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, contatoId, exigir, ha, semErro } from "../semear-demonstracao";

const propostaId = (n: number) => `f1b00002-0000-4000-8000-${String(n).padStart(12, "0")}`;
const itemId = (n: number) => `f1b00003-0000-4000-8000-${String(n).padStart(12, "0")}`;
const IDS = [1, 2, 3, 4].map(propostaId);
const MODELO = "empresa_plano_de_cuidado_bem_viver";

const DIA = 24 * 60;
const data = (minutosAtras: number, diasDepois: number) =>
  new Date(new Date(ha(minutosAtras)).getTime() + diasDepois * 86_400_000).toISOString().slice(0, 10);

export async function limpar(c: Contexto) {
  // os itens saem por cascata
  semErro(await c.db.from("crm_proposals").delete().eq("organization_id", c.org).in("id", IDS), "limpar propostas");
  semErro(
    await c.db.from("proposal_templates").delete().eq("organization_id", c.org).eq("slug", MODELO),
    "limpar modelo das propostas",
  );
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  await limpar(c);

  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_PROPOSTAS", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar o módulo Propostas",
  );
  const linha = exigir(await db.from("organizations").select("settings").eq("id", org).single(), "settings") as {
    settings: Record<string, unknown> | null;
  };
  const settings = linha.settings ?? {};
  const proposals = (settings.proposals as Record<string, unknown> | undefined) ?? {};
  semErro(
    await db.from("organizations").update({ settings: { ...settings, proposals: { ...proposals, enabled: true } } }).eq("id", org),
    "ligar as propostas da empresa",
  );

  const secao = (id: string, title: string, body: string) => ({
    id, title: demo(title), title_es: null, body: demo(body), body_es: null, required: true, conditional: false,
  });
  const SECOES = [
    secao("resumo", "Resumo", "Proposta de {{project.name}} para {{client.name}}, na Clínica Bem Viver."),
    secao("objetivo", "Objetivo do tratamento", "{{project.objective}}"),
    secao("investimento", "Investimento", "Valor total: {{investment.total_formatted}}. Esta proposta vale {{commercial_terms.validity_days}} dias."),
  ];
  semErro(
    await db.from("proposal_templates").insert({
      organization_id: org, slug: MODELO, version: 1, base_slug: null, base_version: null,
      nome: demo("Plano de cuidado da clínica"),
      descricao: demo("Pacote de sessões com o objetivo do tratamento e o investimento."),
      sections: SECOES, section_order: SECOES.map((s) => s.id), is_active: true,
    }),
    "modelo das propostas",
  );

  const negocioDe = async (n: number) =>
    (exigir(
      await db.from("crm_leads").select("id").eq("organization_id", org).eq("contact_id", contatoId(n)).limit(1).single(),
      `negócio do contato ${n}`,
    ) as { id: string }).id;
  const ano = new Date().getFullYear();

  semErro(
    await db.from("crm_proposals").insert([
      {
        // o rascunho da IA: sem número, sem modelo confirmado, com a sugestão dela
        id: propostaId(1), organization_id: org, lead_id: await negocioDe(1), contact_id: contatoId(1),
        titulo: demo("Acompanhamento nutricional — 3 meses"), status: "rascunho",
        condicoes: demo("Pagamento em até 3x no cartão ou 5% de desconto no Pix."),
        // versao explícita: num insert em lote, coluna ausente numa linha vai NULL (não o default)
        total_cents: 84_000, moeda: "BRL", valid_until: data(25, 15), pricing_status: "manual", versao: 1,
        drafted_by_agent_id: c.agenteId, template_slug_sugerido: MODELO, created_at: ha(25),
      },
      {
        id: propostaId(2), organization_id: org, lead_id: await negocioDe(5), contact_id: contatoId(5),
        titulo: demo("Reabilitação pós-cirúrgica — 10 sessões"), status: "enviada",
        condicoes: demo("Pagamento em até 5x no cartão."), total_cents: 150_000, moeda: "BRL",
        valid_until: data(3 * DIA, 15), pricing_status: "manual", numero: 7, ano, versao: 1,
        template_slug: MODELO, template_version: 1,
        briefing_json: {
          project: {
            name: demo("reabilitação pós-cirúrgica do joelho"),
            objective: demo("Recuperar a força e a amplitude do joelho em 10 sessões, com exercícios para fazer em casa."),
          },
        },
        sent_at: ha(3 * DIA - 30), sent_by_user_id: pessoa.helena, destinatario_nome: "Fernanda Oliveira",
        created_at: ha(3 * DIA),
      },
      {
        id: propostaId(3), organization_id: org, lead_id: null, contact_id: contatoId(6),
        titulo: demo("Pilates em grupo — plano semestral"), status: "aceita", total_cents: 108_000, moeda: "BRL",
        valid_until: data(40 * DIA, 15), pricing_status: "manual", numero: 5, ano, versao: 1,
        sent_at: ha(40 * DIA), sent_by_user_id: pessoa.helena, decided_at: ha(38 * DIA),
        decided_by_user_id: pessoa.ana, destinatario_nome: "Lucas Martins", created_at: ha(40 * DIA + 60),
      },
      {
        id: propostaId(4), organization_id: org, lead_id: null, contact_id: contatoId(8),
        titulo: demo("Tratamento odontológico completo"), status: "recusada", total_cents: 420_000, moeda: "BRL",
        valid_until: data(20 * DIA, 15), pricing_status: "manual", numero: 6, ano, versao: 1,
        sent_at: ha(20 * DIA), sent_by_user_id: pessoa.carlos, decided_at: ha(17 * DIA),
        decided_by_user_id: pessoa.carlos, decision_reason: "Preferiu fazer o tratamento em etapas.",
        destinatario_nome: "Beatriz Nogueira", created_at: ha(20 * DIA + 60),
      },
    ]),
    "propostas",
  );

  const item = (n: number, proposta: number, descricao: string, quantidade: number, preco: number, posicao: number) => ({
    id: itemId(n), organization_id: org, proposal_id: propostaId(proposta), product_id: null,
    descricao: demo(descricao), quantidade, preco_unitario_cents: preco, desconto_cents: 0, position: posicao,
  });
  semErro(
    await db.from("crm_proposal_items").insert([
      item(1, 1, "Consulta com a nutricionista", 3, 28_000, 1000),
      item(2, 2, "Sessão de fisioterapia", 10, 15_000, 1000),
      item(3, 3, "Mensalidade do pilates em grupo", 6, 18_000, 1000),
      item(4, 4, "Tratamento odontológico completo", 1, 420_000, 1000),
    ]),
    "itens das propostas",
  );
}
