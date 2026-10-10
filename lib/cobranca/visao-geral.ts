/**
 * A VISÃO GERAL DO DONO em /admin/cobranca (spec da cobrança do revendedor
 * §7a, §9, §13 anti-morte). Três perguntas, sem pulso gravado — tudo derivado:
 *   - o que falta até a primeira cobrança de verdade (checklist, com o
 *     próximo passo e onde fazê-lo);
 *   - a cobrança está viva? (último aviso do provedor; última leitura
 *     bem-sucedida = max(relida_em) do MESMO conjunto que o cron relê);
 *   - o que é problema do dono (chave que parou, cobrança dupla, pagamento de
 *     assinatura cancelada, avisos que não acharam empresa).
 * Leitura que falha LANÇA: a tela não diz "tudo certo" do que não leu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { provedorDaInstalacao } from "@/lib/cobranca/configuracao";
import { modoDoProvedor } from "@/lib/cobranca/provedores";
import { baseDeTesteDaCobranca } from "@/lib/cobranca/provedores/base-de-teste";
import { urlDoWebhookDaCobranca } from "@/lib/cobranca/url";
import type { Modo, ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { emailConfigurado } from "@/lib/email/roteador";
import { env } from "@/lib/env";
import { estadoParaTela } from "@/lib/instalacao/config";

export interface DadosDaVisaoGeral {
  provedor: ProvedorDeCobranca | null;
  modo: Modo | null;
  chaveLast4: string | null;
  urlDoWebhook: string | null;
  ultimoAvisoEm: string | null;
  ultimaLeituraEm: string | null;
  compraConcluida: boolean;
  emailPronto: boolean;
  /** Existe plano ativo marcado para o cadastro (sem ele, quem se cadastra não tem teste nem o que assinar). */
  planoDoCadastro: boolean;
  problemas: {
    credencialInvalida: number;
    cobrancaDupla: number;
    pagouCancelada: number;
    avisosComErro: number;
    /** Avisos do provedor recusados por assinatura nas últimas 24 h (segredo trocado à mão, conta errada). */
    avisosRecusados: number;
  };
}

export interface PassoDoChecklist {
  id: "chave" | "plano" | "aviso" | "compra" | "email" | "publicar";
  feito: boolean;
  titulo: string;
  comoFazer: string;
  href: string | null;
}

const CHAVE_DO_PROVEDOR: Record<ProvedorDeCobranca, string> = { stripe: "STRIPE_SECRET_KEY", asaas: "ASAAS_API_KEY" };

export async function lerVisaoGeral(admin: SupabaseClient): Promise<DadosDaVisaoGeral> {
  const provedor = await provedorDaInstalacao();
  const chaveDoCatalogo = provedor === null ? null : CHAVE_DO_PROVEDOR[provedor];
  const desde24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const [modo, chave, aviso, conjunto, linhas, avisosComErro, recusados, planoDoCadastro, emailPronto] = await Promise.all([
    provedor === null ? null : modoDoProvedor(provedor),
    chaveDoCatalogo === null ? null : estadoParaTela(chaveDoCatalogo, true),
    provedor === null
      ? { data: null, error: null }
      : admin
          .from("webhook_events_log")
          .select("received_at")
          .eq("provider", provedor)
          // Recusa de assinatura (Task 26) não é "aviso recebido": não marca o passo nem a saúde.
          .eq("valid_signature", true)
          .order("received_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
    admin.rpc("fn_cobranca_reconciliaveis"),
    admin.from("cobranca_assinaturas").select("estado, ultimo_erro, assinaturas_vivas, provedor").not("provedor", "is", null),
    admin
      .from("webhook_events_log")
      .select("id", { count: "exact", head: true })
      .in("provider", ["stripe", "asaas"])
      .eq("valid_signature", true)
      .in("status", ["error", "dead"]),
    admin
      .from("webhook_events_log")
      .select("id", { count: "exact", head: true })
      .in("provider", ["stripe", "asaas"])
      .eq("valid_signature", false)
      .gte("received_at", desde24h),
    admin.from("cobranca_planos").select("id").eq("padrao_no_cadastro", true).is("arquivado_em", null).limit(1).maybeSingle(),
    emailConfigurado(),
  ]);
  if (aviso.error || conjunto.error || linhas.error || avisosComErro.error || recusados.error || planoDoCadastro.error) {
    throw new Error("cobrança: visão geral ilegível");
  }
  const relidas = ((conjunto.data ?? []) as Array<{ relida_em: string | null }>)
    .map((l) => l.relida_em)
    .filter((v): v is string => v !== null)
    .sort();
  const assinaturas = (linhas.data ?? []) as Array<{ estado: string; ultimo_erro: string | null; assinaturas_vivas: number; provedor?: string | null }>;
  return {
    provedor,
    modo,
    chaveLast4: chave?.last4 ?? null,
    urlDoWebhook: urlDoWebhookDaCobranca(env.NEXT_PUBLIC_APP_URL ?? "", provedor ?? "stripe", baseDeTesteDaCobranca() !== null),
    ultimoAvisoEm: (aviso.data as { received_at: string } | null)?.received_at ?? null,
    ultimaLeituraEm: relidas.at(-1) ?? null,
    // Checkout concluído em teste grátis também conta: a Stripe só cobra quando o
    // teste acaba (14 dias por padrão), e o passo não pode ficar desmarcado até lá.
    // No Asaas, NÃO: o Assinar cria a assinatura ACTIVE sem pagamento nenhum, e o
    // clique de quem fechou a fatura sem pagar passaria por compra.
    compraConcluida: assinaturas.some(
      (a) => a.estado === "ativa" || (a.estado === "trial" && a.assinaturas_vivas > 0 && a.provedor !== "asaas"),
    ),
    emailPronto,
    planoDoCadastro: planoDoCadastro.data !== null,
    problemas: {
      credencialInvalida: assinaturas.filter((a) => a.ultimo_erro === "credencial_invalida").length,
      cobrancaDupla: assinaturas.filter((a) => a.assinaturas_vivas > 1).length,
      pagouCancelada: assinaturas.filter((a) => a.ultimo_erro === "pagamento_de_assinatura_cancelada").length,
      avisosComErro: avisosComErro.count ?? 0,
      avisosRecusados: recusados.count ?? 0,
    },
  };
}

export function montarChecklist(d: DadosDaVisaoGeral): PassoDoChecklist[] {
  const asaas = d.provedor === "asaas";
  return [
    {
      id: "chave",
      feito: d.provedor !== null && d.chaveLast4 !== null,
      titulo: "Conecte sua conta do provedor de pagamento",
      comoFazer:
        d.urlDoWebhook === null
          ? "Antes: seu sistema precisa estar num endereço https público (ex.: https://crm.example.com). Configure o domínio com HTTPS e volte aqui."
          : "Na aba Conexão, cole a chave secreta de teste e clique em Testar e conectar.",
      href: "/admin/cobranca?aba=conexao",
    },
    {
      id: "plano",
      feito: d.planoDoCadastro,
      titulo: "Crie um plano e marque o do cadastro",
      comoFazer:
        "Na aba Planos, crie o plano que as empresas vão assinar e clique em Usar no cadastro. Sem ele, quem se cadastra não ganha teste grátis nem tem o que assinar.",
      href: "/admin/cobranca?aba=planos",
    },
    {
      id: "aviso",
      // Prova, não promessa: só o primeiro aviso VÁLIDO marca o passo. Na Stripe, a
      // compra concluída também (sobrevive à poda de 90 dias do arquivo de avisos);
      // no Asaas, não: a releitura do cron ativa sem aviso nenhum, e um aviso
      // cadastrado à mão com o token errado passaria por pronto.
      feito: d.ultimoAvisoEm !== null || (!asaas && d.compraConcluida),
      titulo: "Receba o primeiro aviso de pagamento",
      comoFazer: asaas
        ? "Ele chega sozinho quando alguém assina ou paga. Se, ao conectar, o sistema pediu para cadastrar o aviso à mão no Asaas, confira lá a URL e o token (perdeu o token? Conecte de novo para gerar outro). A compra de teste do passo seguinte dispara o primeiro aviso."
        : "Ele chega sozinho quando alguém paga. Faça a compra de teste do passo seguinte.",
      href: asaas ? "/admin/cobranca?aba=conexao" : null,
    },
    {
      id: "compra",
      feito: d.compraConcluida,
      titulo: "Conclua uma compra de teste",
      comoFazer:
        d.modo === "producao"
          ? "Em produção, faça uma compra real de valor baixo com uma empresa sua e cancele depois — ou pule este passo."
          : asaas
            ? "Crie uma empresa de teste com outro e-mail seu (ex.: voce+teste@example.com), abra o convite numa janela anônima, clique em Assinar em Plano e cobrança informando um CPF válido e, no painel do sandbox do Asaas, confirme o recebimento da cobrança."
            : "Crie uma empresa de teste com outro e-mail seu (ex.: voce+teste@seudominio.com), abra o convite numa janela anônima, clique em Assinar em Plano e cobrança e pague com o cartão 4242 4242 4242 4242 (qualquer validade futura e qualquer CVC).",
      href: "/admin/tenants/new",
    },
    {
      id: "email",
      feito: d.emailPronto,
      titulo: "Configure o envio de e-mail",
      comoFazer: "Sem e-mail, os avisos de atraso só aparecem dentro do sistema.",
      href: "/admin/email",
    },
    {
      id: "publicar",
      feito: d.modo === "producao",
      titulo: "Troque para a chave de produção",
      comoFazer: asaas
        ? "Quando a compra de teste der certo, cole em Conexão a chave de produção do Asaas (começa com $aact_prod_). Até lá, clientes reais NÃO conseguem pagar."
        : "Quando a compra de teste der certo, cole em Conexão a chave de produção (sk_live_ ou rk_live_). Até lá, clientes reais NÃO conseguem pagar.",
      href: "/admin/cobranca?aba=conexao",
    },
  ];
}

/** Última leitura mais velha que `horas` (7 h: o cron relê a cada 6 h). Sem leitura nenhuma, não há o que atrasar. */
export function leituraAtrasada(ultima: string | null, agora: Date, horas: number): boolean {
  return ultima !== null && agora.getTime() - Date.parse(ultima) > horas * 3_600_000;
}
