"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { FRASE_DO_EXCEDENTE } from "@/components/admin/tenants/CardDeCobranca";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { formatadorDeData } from "@/lib/cobranca/fuso";
import { linkDePagamentoSeguro } from "@/lib/cobranca/link";
import { abrirNoNavegador } from "@/lib/cobranca/navegar";
import type { PlanoParaTroca } from "@/lib/cobranca/painel";
import type { EstadoDaAssinatura } from "@/lib/cobranca/vocabulario";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

export interface PropsDasAcoes {
  estado: EstadoDaAssinatura;
  temProvedor: boolean;
  assinaturasVivas: number;
  linkDePagamento: string | null;
  cancelaNoFim: boolean;
  planosParaTroca: readonly PlanoParaTroca[];
  /** A página recebeu `?voltou=1`: relê uma vez e dá o recado. */
  voltouDoCheckout: boolean;
  /** No hub de conta suspensa: pagar e voltar ao sistema é o único assunto. */
  noHub: boolean;
  /** IANA da empresa; o mesmo dia do painel. Ausente, o padrão. */
  fuso?: string | null;
}

const BASE = "/api/v1/cobranca/assinatura";
/** Código da API → frase do dicionário. Nunca a `message` do servidor, que não é traduzida. */
const FRASE_DO_ERRO: Record<string, string> = {
  rate_limited: "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.",
  provedor_indisponivel: "O provedor de pagamento não respondeu. Nada mudou; tente de novo em alguns minutos.",
  provedor_recusou: "O provedor de pagamento recusou o pedido. Fale com quem administra o sistema.",
  checkout_em_preparo: "Já estamos gerando o seu link de pagamento. Aguarde alguns segundos.",
  checkout_em_aberto: "Há um link de pagamento em aberto com o plano atual. Conclua o pagamento ou aguarde o link expirar para trocar de plano.",
  pagamento_em_andamento: "Você já tem um pagamento em andamento. Use o link para concluir.",
  sem_link_de_pagamento: "Não há cobrança aberta para pagar agora. Atualize o cartão em Gerenciar pagamento: a próxima tentativa sai sozinha.",
  provedor_nao_conectado: "O administrador do sistema ainda não conectou a cobrança.",
  not_found: "Sua empresa não tem plano de cobrança.",
};
const FRASE_GENERICA = "Não foi possível concluir agora. Tente de novo.";
type Leitura = { estado: EstadoDaAssinatura | null; assinaturas_vivas: number; org_operante: boolean };

/**
 * As ações de Plano e cobrança (spec §7b–§7f, §9). Pagar em UM clique é o que
 * recupera a receita: o link da fatura aparece sempre que existe. "Já paguei"
 * relê o provedor na hora — quem pagou volta sozinho, sem esperar ninguém.
 */
export function AcoesDaAssinatura(p: PropsDasAcoes) {
  const t = useT();
  const idioma = useIdioma();
  const router = useRouter();
  const link = linkDePagamentoSeguro(p.linkDePagamento);
  const [ocupado, setOcupado] = useState(false);
  const [recado, setRecado] = useState<string | null>(null);
  const [trocando, setTrocando] = useState(false);
  const [novo, setNovo] = useState(p.planosParaTroca[0]?.id ?? "");
  const [cancelando, setCancelando] = useState(false);
  const releu = useRef(false);
  // Falso depois do desmonte: a espera da volta do checkout para, sem setState nem router.
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);
  const dia = (v: string | null) => (v ? formatadorDeData(idioma, p.fuso ?? null, { day: "2-digit", month: "2-digit" }).format(new Date(v)) : "");

  const emDivida = p.estado === "em_atraso" || p.estado === "cancelada";
  const podeAssinar = p.assinaturasVivas === 0 && p.estado !== "ativa";
  // Em atraso com assinatura viva e sem fatura pagável agora (pausada; incobrável
  // sem página): o único caminho é trocar o cartão no portal — e a tela diz isso.
  const soPeloPortal = emDivida && p.temProvedor && p.assinaturasVivas > 0 && !link;
  // "Já paguei" só onde há o que reler: quem nunca assinou (teste que acabou) não pagou nada.
  const podeDizerQuePagou = (emDivida && p.temProvedor) || p.noHub;
  const podeTrocar = p.planosParaTroca.length > 0 && (p.estado === "trial" || p.estado === "ativa") && !p.cancelaNoFim;
  const podeCancelar = p.temProvedor && p.assinaturasVivas > 0 && !p.cancelaNoFim && (p.estado === "ativa" || p.estado === "trial");

  async function agir(acao: () => Promise<void>) {
    setOcupado(true);
    setRecado(null);
    try {
      await acao();
    } catch (e) {
      if (e instanceof ApiError && e.code === "plan_limit_reached") {
        const excedente = (e.details?.excedente ?? {}) as Record<string, number>;
        const passos = (Object.keys(FRASE_DO_EXCEDENTE) as Array<keyof typeof FRASE_DO_EXCEDENTE>)
          .filter((r) => (excedente[r] ?? 0) > 0)
          .map((r) => t(FRASE_DO_EXCEDENTE[r]).replace("{n}", String(excedente[r])));
        setRecado([t("O uso atual não cabe no plano escolhido. Para trocar, primeiro:"), ...passos].join(" "));
      } else if (e instanceof ApiError) {
        setRecado(t(FRASE_DO_ERRO[e.code] ?? FRASE_GENERICA));
      } else {
        showApiError(e);
      }
    } finally {
      if (montado.current) setOcupado(false);
    }
  }

  /** Relê o provedor. `true` = a empresa voltou a operar no hub (e já foi levada ao sistema). */
  async function reler(): Promise<boolean> {
    const { data: r } = await apiClient.post<{ data: Leitura }>(`${BASE}/sincronizar`, {});
    if (!montado.current) return true;
    if (p.noHub && r.org_operante) {
      router.push("/app");
      return true;
    }
    if (r.estado === "ativa") setRecado(t("Pagamento confirmado. Obrigado!"));
    else if (r.estado === "trial" && r.assinaturas_vivas > 0) setRecado(t("Tudo certo: a primeira cobrança sai no fim do teste grátis."));
    else setRecado(t("Ainda não identificamos o pagamento. Se pagou por boleto, a compensação leva até 1 dia útil."));
    router.refresh();
    return false;
  }

  /**
   * A volta do checkout. No hub, quem acabou de pagar não pode ver "suspensa" sem
   * retorno: relê até 3 vezes mais, a cada 30 s, dizendo que está confirmando
   * (o aviso do provedor costuma chegar em segundos; a reconciliação cura o resto).
   */
  async function confirmarNaVolta(): Promise<boolean> {
    for (let tentativa = 0; tentativa < (p.noHub ? 4 : 1); tentativa += 1) {
      if (tentativa > 0) {
        if (!montado.current) return true;
        setRecado(t("Confirmando seu pagamento…"));
        await new Promise((pronto) => setTimeout(pronto, 30_000));
        if (!montado.current) return true;
      }
      if (await reler()) return true;
    }
    return false;
  }

  useEffect(() => {
    if (!p.voltouDoCheckout || releu.current) return;
    releu.current = true;
    void agir(async () => {
      // Tira o ?voltou=1 da barra (recarregar não relê de novo) — salvo se a empresa já voltou e foi levada a /app.
      if (!(await confirmarNaVolta())) router.replace(p.noHub ? "/account-suspended" : "/app/settings/billing");
    });
    // agir/reler são recriadas a cada render; o ref garante uma leitura só.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.voltouDoCheckout]);

  const gerenciar = () =>
    void agir(async () => {
      const { data: r } = await apiClient.post<{ data: { url: string } }>(`${BASE}/gerenciar`, {});
      abrirNoNavegador(r.url);
    });

  return (
    <div className="max-w-xl space-y-3">
      {soPeloPortal && (
        <p className="text-sm">
          {t("Não há cobrança aberta para pagar agora. Atualize o cartão em Gerenciar pagamento: a próxima tentativa sai sozinha.")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {soPeloPortal && (
          <Button disabled={ocupado} onClick={gerenciar}>
            {t("Gerenciar pagamento")}
          </Button>
        )}
        {link && (
          <Button asChild>
            <a href={link} target="_blank" rel="noopener noreferrer">
              {t("Pagar agora")}
            </a>
          </Button>
        )}
        {podeAssinar && (
          <Button
            disabled={ocupado}
            variant={link ? "outline" : "default"}
            onClick={() =>
              void agir(async () => {
                const { data: r } = await apiClient.post<{ data: { url: string } }>(`${BASE}/checkout`, p.noHub ? { volta: "hub" } : {});
                abrirNoNavegador(r.url);
              })
            }
          >
            {t(p.estado === "cancelada" ? "Assinar de novo" : "Assinar")}
          </Button>
        )}
        {podeDizerQuePagou && (
          <Button
            variant="outline"
            disabled={ocupado}
            onClick={() =>
              void agir(async () => {
                await reler();
              })
            }
          >
            {t("Já paguei")}
          </Button>
        )}
        {p.temProvedor && p.assinaturasVivas > 0 && !soPeloPortal && (
          <Button variant="outline" disabled={ocupado} onClick={gerenciar}>
            {t("Gerenciar pagamento")}
          </Button>
        )}
        {podeTrocar && !trocando && (
          <Button variant="outline" disabled={ocupado} onClick={() => setTrocando(true)}>
            {t("Trocar de plano")}
          </Button>
        )}
        {podeCancelar && !cancelando && (
          <Button variant="ghost" disabled={ocupado} onClick={() => setCancelando(true)}>
            {t("Cancelar assinatura")}
          </Button>
        )}
      </div>

      {trocando && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="novo-plano">{t("Novo plano")}</Label>
            <select id="novo-plano" className="h-9 rounded-md border bg-background px-2 text-sm" value={novo} onChange={(e) => setNovo(e.target.value)}>
              {p.planosParaTroca.map((plano) => (
                <option key={plano.id} value={plano.id}>
                  {plano.nome}
                </option>
              ))}
            </select>
          </div>
          <Button
            disabled={ocupado || !novo}
            onClick={() =>
              void agir(async () => {
                const { data: r } = await apiClient.post<{ data: { quando: string; vale_a_partir_de: string | null } }>(`${BASE}/plano`, { plano_id: novo });
                setTrocando(false);
                setRecado(
                  r.quando === "agendado" && r.vale_a_partir_de
                    ? t("O novo plano vale a partir de {data}.").replace("{data}", dia(r.vale_a_partir_de))
                    : t("Plano trocado."),
                );
                router.refresh();
              })
            }
          >
            {t("Confirmar troca")}
          </Button>
        </div>
      )}

      {cancelando && (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>{t("Você mantém o acesso até o fim do período já pago. Não há reembolso proporcional.")}</p>
          <Button
            variant="destructive"
            disabled={ocupado}
            onClick={() =>
              void agir(async () => {
                const { data: r } = await apiClient.post<{ data: { acesso_ate: string | null } }>(`${BASE}/cancelar`, {});
                setCancelando(false);
                setRecado(t("Você mantém o acesso até {data}.").replace("{data}", dia(r.acesso_ate)));
                router.refresh();
              })
            }
          >
            {t("Confirmar cancelamento")}
          </Button>
        </div>
      )}

      {recado && (
        <p role="status" className="text-sm">
          {recado}
        </p>
      )}
    </div>
  );
}
