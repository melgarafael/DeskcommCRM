"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { FRASE_DO_EXCEDENTE } from "@/components/admin/tenants/CardDeCobranca";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { documentoDoPagador, exigeDocumento } from "@/lib/cobranca/documento";
import { formatadorDeData } from "@/lib/cobranca/fuso";
import { linkDePagamentoSeguro } from "@/lib/cobranca/link";
import { calcularAjusteProporcional } from "@/lib/cobranca/prorata";
import { abrirNoNavegador } from "@/lib/cobranca/navegar";
import type { PlanoParaTroca } from "@/lib/cobranca/painel";
import type { EstadoDaAssinatura, ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { formatCents } from "@/lib/money";

export interface PropsDasAcoes {
  estado: EstadoDaAssinatura;
  temProvedor: boolean;
  assinaturasVivas: number;
  linkDePagamento: string | null;
  cancelaNoFim: boolean;
  planosParaTroca: readonly PlanoParaTroca[];
  planoAtual: PlanoParaTroca | null;
  periodoPagoDesde: string | null;
  proximoVencimento: string | null;
  trocaPagamentoUrl: string | null;
  trocaStatus: string | null;
  instanteCalculo: string;
  /** A página recebeu `?voltou=1`: relê uma vez e dá o recado. */
  voltouDoCheckout: boolean;
  /** No hub de conta suspensa: pagar e voltar ao sistema é o único assunto. */
  noHub: boolean;
  /** IANA da empresa; o mesmo dia do painel. Ausente, o padrão. */
  fuso?: string | null;
  /** Quem cobra: o provedor da assinatura; sem ele, o da instalação (D-8). */
  provedor: ProvedorDeCobranca | null;
  /** CNPJ do cadastro, já conferido e sem máscara: pré-preenche o documento que o Asaas exige. */
  documentoDoCadastro: string | null;
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
  documento_invalido: "Confira o CPF ou CNPJ: os dígitos não batem.",
  documento_obrigatorio: "Informe o CPF ou CNPJ de quem paga.",
  documento_recusado: "O provedor de pagamento não aceitou este CPF ou CNPJ. Confira o número ou informe outro documento.",
  pagamento_pendente: "Regularize o pagamento antes de trocar de plano.",
  pagamento_do_periodo_pendente:
    'A mensalidade de agora ainda não foi paga. Pague em "Pagar agora" e troque de plano depois que o pagamento for confirmado (Pix: minutos; boleto: até 1 dia útil).',
  troca_em_preparo: "Estamos preparando o ajuste proporcional. Aguarde alguns segundos e tente novamente.",
  troca_pendente: "Conclua ou aguarde a cobrança proporcional antes de solicitar outra troca de plano.",
  pagamento_nao_registrado: "A cobrança foi iniciada, mas não conseguimos registrar o pagamento. Tente novamente; se houver uma cobrança aberta, fale com o suporte.",
  periodo_indisponivel: "Não foi possível calcular o período pago. Atualize a assinatura e tente novamente.",
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
  const linkDoAjuste = linkDePagamentoSeguro(p.trocaPagamentoUrl);
  const [ocupado, setOcupado] = useState(false);
  const [recado, setRecado] = useState<string | null>(null);
  const [trocando, setTrocando] = useState(false);
  const [novo, setNovo] = useState(p.planosParaTroca[0]?.id ?? "");
  const [cancelando, setCancelando] = useState(false);
  const [documento, setDocumento] = useState(p.documentoDoCadastro ?? "");
  // A fatura do Asaas que o Assinar acabou de gerar: abre numa NOVA aba, por um link
  // que a pessoa clica (popup aberto depois de um await é bloqueado no Safari).
  const [fatura, setFatura] = useState<string | null>(null);
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
  const selecionado = p.planosParaTroca.find((plano) => plano.id === novo) ?? null;
  // A MESMA conta da cobrança (`troca.ts`), mínimo do provedor incluído: abaixo
  // dele a tela diz "na próxima renovação", que é o que o servidor faz.
  const ajusteProporcional = !p.planoAtual || !selecionado
    ? 0
    : calcularAjusteProporcional({
        precoAtualCents: p.planoAtual.preco_cents,
        precoNovoCents: selecionado.preco_cents,
        periodoPagoDesde: p.periodoPagoDesde ? new Date(p.periodoPagoDesde) : null,
        proximoVencimento: p.proximoVencimento ? new Date(p.proximoVencimento) : null,
        agora: new Date(p.instanteCalculo),
      });
  // A moeda é a do plano atual (migration 9332): a troca só oferece planos nela.
  const reais = (centavos: number) => formatCents(centavos, p.planoAtual?.moeda ?? selecionado?.moeda ?? "BRL");
  const dolares = (centavos: number) => new Intl.NumberFormat(idioma, { style: "currency", currency: "USD" }).format(centavos / 100);

  const emDivida = p.estado === "em_atraso" || p.estado === "cancelada";
  const podeAssinar = p.assinaturasVivas === 0 && p.estado !== "ativa";
  // Em atraso com assinatura viva e sem fatura pagável agora (pausada; incobrável
  // sem página): o único caminho é trocar o cartão no portal — e a tela diz isso.
  // O Asaas não tem portal: "gerenciar" seria o link da cobrança, que já é o Pagar agora.
  const temPortal = p.provedor !== "asaas";
  const soPeloPortal = temPortal && emDivida && p.temProvedor && p.assinaturasVivas > 0 && !link;
  // O Asaas só cria o cliente com CPF/CNPJ; quem já é cliente lá (reassinar) não digita de novo.
  const pedeDocumento = exigeDocumento(p.provedor, p.temProvedor);
  const documentoNormalizado = documentoDoPagador(documento);
  const documentoErrado = documento.trim() !== "" && documentoNormalizado === null;
  // A fatura do Asaas não devolve o cliente ao sistema: quem pagou o Pix volta à aba
  // que ficou aberta e relê aqui, sem esperar o cron — também no teste grátis.
  const aguardandoAsaas = p.provedor === "asaas" && (fatura !== null || (p.temProvedor && (p.estado === "trial" || link !== null)));
  // "Já paguei" só onde há o que reler: quem nunca assinou (teste que acabou) não pagou nada.
  const podeDizerQuePagou = (emDivida && p.temProvedor) || p.noHub || aguardandoAsaas || p.trocaPagamentoUrl !== null;
  const podeTrocar = p.planosParaTroca.length > 0 && (p.estado === "trial" || p.estado === "ativa") && !p.cancelaNoFim && p.trocaStatus !== "criando";
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
      {podeAssinar && pedeDocumento && (
        <div className="space-y-1">
          <Label htmlFor="documento-de-quem-paga">{t("CPF ou CNPJ de quem paga")}</Label>
          <Input
            id="documento-de-quem-paga"
            className="max-w-xs"
            autoComplete="off"
            value={documento}
            onChange={(e) => setDocumento(e.target.value)}
            aria-invalid={documentoErrado}
            aria-describedby="documento-de-quem-paga-ajuda"
          />
          <p id="documento-de-quem-paga-ajuda" className="text-xs text-muted-foreground">
            {documentoErrado
              ? t("Confira o CPF ou CNPJ: os dígitos não batem.")
              : t("Vai direto para o Asaas, que emite a cobrança neste documento; não fica guardado neste sistema. Confira antes de assinar: para trocar depois, fale com quem administra o sistema.")}
          </p>
        </div>
      )}
      {fatura && (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>{t("Sua fatura está pronta. Pague por Pix, boleto ou cartão.")}</p>
          <Button asChild>
            <a href={fatura} target="_blank" rel="noopener noreferrer">
              {t("Abrir a fatura")}
            </a>
          </Button>
        </div>
      )}
      {p.provedor === "asaas" && (fatura !== null || link !== null) && (
        <p className="text-xs text-muted-foreground">
          {t("A fatura abre no Asaas, numa nova aba. Depois de pagar, volte aqui e clique em Já paguei: Pix confirma em minutos; boleto, em até 1 dia útil.")}
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
              {/* Asaas em dia: o link é a cobrança seguinte, gerada até 40 dias antes. "Pagar agora" ao lado de "Em dia" leria como dívida. */}
              {p.provedor === "asaas" && p.estado === "ativa" ? t("Adiantar a próxima mensalidade") : t("Pagar agora")}
            </a>
          </Button>
        )}
        {linkDoAjuste && (
          <Button asChild variant="outline">
            <a href={linkDoAjuste} target="_blank" rel="noopener noreferrer">{t("Pagar ajuste do upgrade")}</a>
          </Button>
        )}
        {podeAssinar && (
          <Button
            disabled={ocupado || (pedeDocumento && documentoNormalizado === null)}
            variant={link ? "outline" : "default"}
            onClick={() =>
              void agir(async () => {
                const corpo = {
                  ...(p.noHub ? { volta: "hub" } : {}),
                  ...(pedeDocumento && documentoNormalizado !== null ? { documento: documentoNormalizado } : {}),
                };
                const { data: r } = await apiClient.post<{ data: { url: string } }>(`${BASE}/checkout`, corpo);
                if (p.provedor !== "asaas") return abrirNoNavegador(r.url);
                // O Asaas não devolve o cliente: a fatura vai para uma aba nova e esta fica, com o "Já paguei".
                setFatura(linkDePagamentoSeguro(r.url));
                router.refresh();
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
        {temPortal && p.temProvedor && p.assinaturasVivas > 0 && !soPeloPortal && (
          <Button variant="outline" disabled={ocupado} onClick={gerenciar}>
            {t("Gerenciar pagamento")}
          </Button>
        )}
        {podeTrocar && !trocando && (
          <Button variant="outline" disabled={ocupado} onClick={() => setTrocando(true)}>
            {t("Trocar de plano")}
          </Button>
        )}
        {p.trocaStatus && (
          <p className="basis-full text-sm text-muted-foreground" role="status">
            {t(p.trocaStatus === "criando" ? "Estamos preparando o ajuste proporcional. Aguarde alguns segundos." : "Há um ajuste proporcional esperando pagamento. Escolher outro plano cancela esse ajuste.")}
          </p>
        )}
        {podeCancelar && !cancelando && (
          <Button variant="ghost" disabled={ocupado} onClick={() => setCancelando(true)}>
            {t("Cancelar assinatura")}
          </Button>
        )}
      </div>

      {trocando && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-end gap-2">
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
          </div>
          {p.planoAtual && selecionado && (
            <div className="grid gap-2 text-sm sm:grid-cols-2" aria-live="polite">
              {[p.planoAtual, selecionado].map((plano, i) => (
                <section key={plano.id} className="rounded-md bg-muted/40 p-3">
                  <h3 className="font-medium">{i === 0 ? t("Plano atual") : t("Novo plano")}: {plano.nome}</h3>
                  <p>{reais(plano.preco_cents)} / {plano.intervalo === "ano" ? t("ano") : t("mês")}</p>
                  <ul className="mt-2 space-y-1 text-muted-foreground">
                    <li>{t("Pessoas")}: {plano.max_assentos ?? t("sem limite")}</li>
                    <li>{t("Números conectados")}: {plano.max_canais ?? t("sem limite")}</li>
                    <li>{t("IA por mês")}: {plano.teto_ia_usd_cents === null ? t("sem limite") : dolares(plano.teto_ia_usd_cents)}</li>
                  </ul>
                </section>
              ))}
            </div>
          )}
          {selecionado && selecionado.preco_cents > (p.planoAtual?.preco_cents ?? 0) && (
            <p className="text-sm">
              {ajusteProporcional === null
                ? t("Não foi possível calcular o proporcional com os dados do período pago. Nenhuma troca será realizada.")
                : ajusteProporcional === 0
                  ? `${t("O ajuste proporcional é zero; o novo plano entra na próxima renovação")}: ${dia(p.proximoVencimento)}.`
                  : `${t("Ajuste proporcional estimado para hoje")}: ${reais(ajusteProporcional)}. ${t("A data da próxima renovação permanece")}: ${dia(p.proximoVencimento)}.`}
            </p>
          )}
          {selecionado && p.planoAtual && selecionado.preco_cents <= p.planoAtual.preco_cents && (
            <p className="text-sm text-muted-foreground">{t("O plano escolhido e seus limites passam a valer na próxima renovação. A fatura atual mantém o valor e o vencimento.")}</p>
          )}
          <Button
            disabled={ocupado || !novo}
            onClick={() =>
              void agir(async () => {
                const { data: r } = await apiClient.post<{ data: { quando: string; vale_a_partir_de: string | null; url_pagamento?: string | null } }>(`${BASE}/plano`, { plano_id: novo });
                setTrocando(false);
                if (r.url_pagamento) {
                  if (p.provedor === "asaas") setFatura(linkDePagamentoSeguro(r.url_pagamento));
                  else abrirNoNavegador(r.url_pagamento);
                  setRecado(t("Pague o ajuste proporcional para aplicar o novo plano. Seus limites atuais permanecem até a confirmação."));
                  return;
                }
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
