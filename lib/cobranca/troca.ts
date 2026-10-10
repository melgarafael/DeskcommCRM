/**
 * TROCAR DE PLANO — um caminho só, para a empresa (Plano e cobrança) e para o
 * dono (card do tenant). Spec da cobrança do revendedor §7e, §7g; D-3, D-4, D-13.
 *
 *   - teste grátis (estado `trial` e `trial_ate` no futuro): vale na hora; com
 *     provedor, o preço da 1ª cobrança muda junto. Divergência 44: a D-13 vale só
 *     enquanto nada foi pago — pagou dentro do teste (estado `ativa`), agenda;
 *   - a empresa só escolhe plano com `oferecido_ao_cliente` (Task 4A); o dono,
 *     qualquer um ativo (plano negociado);
 *   - depois do teste, com provedor: fica AGENDADA e vira na próxima cobrança
 *     paga (`aplicarLeitura`) — subir no dia 1 e descer no dia 28 não compensa;
 *   - em dívida, ou teste vencido sem assinatura: recusa ("regularize antes");
 *   - teste com link de pagamento em aberto e sem assinatura: recusa até o link
 *     ser pago ou expirar (`checkout_em_aberto`);
 *   - uso acima do plano novo: recusa com a lista do que remover (D-4).
 * O provedor é chamado ANTES da escrita e fora de transação; a escrita é um
 * compare-and-set no plano E no agendamento lidos. Se a escrita não acontece
 * depois de o provedor ter aceitado, o preço volta ao que o banco registra
 * (`reconciliar`). Voltar ao plano atual (desfazer o agendamento) não passa pelas
 * portas de arquivado/oferecido/excedente: é só soltar o que já foi aceito.
 * Quem chama audita (o ator muda).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { adaptador as adaptadorPadrao } from "@/lib/cobranca/provedores";
import { ErroDoProvedor, type AdaptadorDeCobranca } from "@/lib/cobranca/provedores/contrato";
import { excedenteDoPlano, lerUsoDaOrganizacao } from "@/lib/cobranca/uso";
import type { EstadoDaAssinatura, Intervalo, ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";

export type ResultadoDaTroca =
  | {
      ok: true;
      changed: boolean;
      quando: "imediato" | "agendado" | "nenhum";
      planoId: string;
      planoAgendadoId: string | null;
      valeAPartirDe: string | null;
      de: string;
    }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

interface Atual {
  plano_id: string;
  plano_agendado_id: string | null;
  estado: EstadoDaAssinatura;
  trial_ate: string | null;
  provedor: ProvedorDeCobranca | null;
  provedor_assinatura_id: string | null;
  proximo_vencimento: string | null;
  checkout_url: string | null;
  checkout_expira_em: string | null;
}
interface Plano {
  id: string;
  nome: string;
  preco_cents: number;
  intervalo: Intervalo;
  max_assentos: number | null;
  max_canais: number | null;
  arquivado_em: string | null;
  oferecido_ao_cliente: boolean;
}

const EM_DIVIDA: readonly EstadoDaAssinatura[] = ["em_atraso", "cancelada"];
const recusa = (status: number, code: string, message: string, details?: unknown): ResultadoDaTroca => ({
  ok: false, status, code, message, ...(details === undefined ? {} : { details }),
});

async function lerPlanoCompleto(admin: SupabaseClient, id: string): Promise<Plano | null | "erro"> {
  const { data, error } = await admin
    .from("cobranca_planos")
    .select("id, nome, preco_cents, intervalo, max_assentos, max_canais, arquivado_em, oferecido_ao_cliente")
    .eq("id", id)
    .maybeSingle();
  if (error) return "erro";
  return (data as Plano | null) ?? null;
}

export async function trocarPlanoDaOrg(
  admin: SupabaseClient,
  orgId: string,
  planoId: string,
  deps: { adaptador?: (id: ProvedorDeCobranca) => AdaptadorDeCobranca; agora?: () => Date; origem?: "empresa" | "dono" } = {},
): Promise<ResultadoDaTroca> {
  const agora = (deps.agora ?? (() => new Date()))();
  const { data: lida, error } = await admin
    .from("cobranca_assinaturas")
    .select("plano_id, plano_agendado_id, estado, trial_ate, provedor, provedor_assinatura_id, proximo_vencimento, checkout_url, checkout_expira_em")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return recusa(500, "internal_error", "Não foi possível ler a assinatura.");
  const atual = lida as Atual | null;
  if (!atual) return recusa(404, "not_found", "Esta empresa não tem assinatura (é isenta).");

  const nada = (quando: "nenhum" | "agendado"): ResultadoDaTroca => ({
    ok: true, changed: false, quando, planoId: atual.plano_id, planoAgendadoId: atual.plano_agendado_id,
    valeAPartirDe: quando === "agendado" ? atual.proximo_vencimento : null, de: atual.plano_id,
  });
  if (planoId === atual.plano_id && atual.plano_agendado_id === null) return nada("nenhum");
  if (planoId === atual.plano_agendado_id) return nada("agendado");
  if (EM_DIVIDA.includes(atual.estado)) return recusa(409, "pagamento_pendente", "Regularize o pagamento antes de trocar de plano.");
  const emTeste = atual.estado === "trial" && atual.trial_ate !== null && Date.parse(atual.trial_ate) > agora.getTime();
  if (!emTeste && !atual.provedor) {
    return recusa(409, "pagamento_pendente", "O teste grátis acabou e não há pagamento. A troca de plano vale depois da assinatura.");
  }

  const [novo, antigo] = await Promise.all([lerPlanoCompleto(admin, planoId), lerPlanoCompleto(admin, atual.plano_id)]);
  if (novo === "erro" || antigo === "erro") return recusa(500, "internal_error", "Não foi possível ler o plano.");
  const desfazendo = novo !== null && novo.id === atual.plano_id;
  if (!novo || !antigo || (!desfazendo && (novo.arquivado_em !== null || novo.intervalo !== antigo.intervalo))) {
    return recusa(422, "plano_invalido", "Escolha um plano ativo com o mesmo intervalo de cobrança.");
  }
  // Enquanto houver link de pagamento em aberto, o plano não muda.
  const linkEmAberto = atual.checkout_url !== null && atual.checkout_expira_em !== null && Date.parse(atual.checkout_expira_em) > agora.getTime();
  if (!desfazendo && emTeste && atual.provedor && !atual.provedor_assinatura_id && linkEmAberto) {
    return recusa(409, "checkout_em_aberto", "Há um link de pagamento em aberto com o plano atual. Conclua o pagamento ou aguarde o link expirar para trocar de plano.");
  }
  if (!desfazendo) {
    // Plano negociado: só o dono atribui (a tela da empresa nem o lista).
    if ((deps.origem ?? "empresa") === "empresa" && !novo.oferecido_ao_cliente) {
      return recusa(422, "plano_invalido", "Este plano não está disponível para troca. Fale com quem administra o sistema.");
    }
    const uso = await lerUsoDaOrganizacao(admin, orgId);
    if (!uso) return recusa(500, "internal_error", "Não foi possível medir o uso da empresa.");
    const excedente = excedenteDoPlano(uso, novo);
    if (Object.keys(excedente).length > 0) {
      return recusa(409, "plan_limit_reached", "O uso atual não cabe no plano escolhido.", { excedente });
    }
  }

  const provedorDaTroca = atual.provedor && atual.provedor_assinatura_id ? { provedor: atual.provedor, ref: atual.provedor_assinatura_id } : null;
  const aoProvedor = (p: Plano) =>
    (deps.adaptador ?? adaptadorPadrao)(provedorDaTroca!.provedor).trocarPlano({
      assinaturaRef: provedorDaTroca!.ref,
      plano: { id: p.id, nome: p.nome, precoCents: p.preco_cents, intervalo: p.intervalo },
    });
  // O preço no provedor tem de ser o do que o banco registra (agendado, senão o atual).
  // Relê a linha (outra troca pode ter vencido a corrida); se a leitura falha, vale o que líamos.
  // Devolve false quando não conseguiu desfazer: aí a divergência fica dita na resposta.
  const reconciliar = async (): Promise<boolean> => {
    let alvo = atual.plano_agendado_id ?? atual.plano_id;
    const { data: relida } = await admin
      .from("cobranca_assinaturas").select("plano_id, plano_agendado_id").eq("organization_id", orgId).maybeSingle();
    if (relida) alvo = (relida as Atual).plano_agendado_id ?? (relida as Atual).plano_id;
    const p = await lerPlanoCompleto(admin, alvo);
    if (!p || p === "erro") return false;
    try { await aoProvedor(p); return true; } catch { return false; }
  };
  const divergiu = "O preço no provedor de pagamento pode estar diferente do plano registrado; confira com quem administra o sistema.";

  if (provedorDaTroca) {
    try {
      await aoProvedor(novo);
    } catch (e) {
      if (!(e instanceof ErroDoProvedor)) throw e;
      if (e.codigo === "pagamento_do_periodo_pendente") {
        return recusa(
          409,
          "pagamento_do_periodo_pendente",
          'A mensalidade de agora ainda não foi paga. Pague em "Pagar agora" e troque de plano depois que o pagamento for confirmado (Pix: minutos; boleto: até 1 dia útil).',
        );
      }
      if (e.transitorio) {
        // A resposta pode ter se perdido com o preço já mudado: não afirme "nada mudou".
        const ok = await reconciliar();
        return recusa(503, "provedor_indisponivel", ok
          ? "O provedor de pagamento não respondeu. A troca não foi feita; tente de novo."
          : `O provedor de pagamento não respondeu e não foi possível confirmar a troca. ${divergiu}`);
      }
      return recusa(502, "provedor_recusou", "O provedor de pagamento recusou a troca.");
    }
  } else if (!emTeste) {
    return recusa(409, "state_conflict", "A assinatura ainda não foi criada no provedor. Conclua o pagamento antes de trocar.");
  }

  const campos = emTeste
    ? {
        plano_id: novo.id,
        plano_agendado_id: null,
        updated_at: agora.toISOString(),
        // O link em aberto sem assinatura já foi recusado acima; o que sobra sai junto, e o
        // próximo "Assinar" parte do plano gravado. Com a assinatura já no provedor (o Asaas a
        // cria no Assinar), o provedor acabou de pôr o preço novo na fatura aberta: o link é o
        // mesmo e fica.
        ...(atual.checkout_url && !provedorDaTroca ? { checkout_url: null, checkout_expira_em: null } : {}),
      }
    : { plano_agendado_id: novo.id === atual.plano_id ? null : novo.id, updated_at: agora.toISOString() };
  let pedido = admin.from("cobranca_assinaturas").update(campos).eq("organization_id", orgId).eq("plano_id", atual.plano_id);
  pedido = atual.plano_agendado_id ? pedido.eq("plano_agendado_id", atual.plano_agendado_id) : pedido.is("plano_agendado_id", null);
  pedido = atual.provedor ? pedido.eq("provedor", atual.provedor) : pedido.is("provedor", null);
  // No teste grátis, o link (ou a reserva dele) gravado depois da leitura faz esta troca perder.
  if (emTeste) {
    pedido = atual.checkout_expira_em ? pedido.eq("checkout_expira_em", atual.checkout_expira_em) : pedido.is("checkout_expira_em", null);
  }
  const { data: gravada, error: erroDaGravacao } = await pedido.select("organization_id").maybeSingle();
  if (erroDaGravacao || !gravada) {
    // O provedor já aceitou o preço novo e o banco não o registrou: desfaz no provedor.
    const desfeito = !provedorDaTroca || (await reconciliar());
    const aviso = desfeito ? "" : ` ${divergiu}`;
    return erroDaGravacao
      ? recusa(500, "internal_error", `Não foi possível trocar o plano.${aviso}`)
      : recusa(409, "state_conflict", `A assinatura mudou enquanto você trocava o plano. Recarregue e tente de novo.${aviso}`);
  }

  return emTeste
    ? { ok: true, changed: true, quando: "imediato", planoId: novo.id, planoAgendadoId: null, valeAPartirDe: null, de: atual.plano_id }
    : {
        ok: true, changed: true, quando: "agendado", planoId: atual.plano_id,
        planoAgendadoId: novo.id === atual.plano_id ? null : novo.id, valeAPartirDe: atual.proximo_vencimento, de: atual.plano_id,
      };
}
