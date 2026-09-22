"use client";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";
import {
  ROTULO_DO_STATUS,
  type ItemDoPedido,
  type PedidoComercial,
  type StatusDoPedido,
} from "@/lib/schemas/pedidos";

/** Bloco do cliente pronto para o impresso (montado no servidor). */
export interface ClienteImpresso {
  nome: string;
  fantasia: string | null;
  rotuloDocumento: string;
  documento: string | null;
  ie: string | null;
  endereco: string | null;
  bairro: string | null;
  cep: string | null;
  cidade: string | null;
  uf: string | null;
  fone: string | null;
  email: string | null;
}

export interface ItemImpresso extends ItemDoPedido {
  unidade: string;
}

/** Preço líquido: tabela × (1 − desconto), com round igual ao backend. */
function precoLiquido(it: ItemImpresso): number {
  return Math.round(it.preco_unit_cents * (1 - Number(it.desconto_pct ?? 0) / 100));
}

/** Botão de impressão (só na tela — some no papel). */
function BotaoImprimir() {
  const t = useT();
  return (
    <div className="mb-4 flex gap-2 print:hidden">
      <Button onClick={() => window.print()}>{t("Imprimir")}</Button>
      <p className="self-center text-sm text-muted-foreground">
        {t("Confira a prévia abaixo antes de imprimir.")}
      </p>
    </div>
  );
}

function CampoCliente({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor?.trim()) return null;
  return (
    <p className="text-[13px] leading-snug">
      <span className="text-muted-foreground">{rotulo}: </span>
      <span className="font-medium">{valor}</span>
    </p>
  );
}

export function ImprimirLoteClient({
  nomeOrganizacao,
  pedidos,
}: {
  nomeOrganizacao: string;
  pedidos: { pedido: PedidoComercial; cliente: ClienteImpresso; itens: ItemImpresso[] }[];
}) {
  const t = useT();
  if (pedidos.length === 0) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">{t("Nenhum pedido selecionado.")}</p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6 print:max-w-none print:space-y-4 print:p-0">
      <BotaoImprimir />
      {pedidos.map(({ pedido: p, cliente: c, itens }, idx) => {
        const status = ROTULO_DO_STATUS[p.status as StatusDoPedido] ?? p.status;
        const qtdItens = itens.length;
        const qtdUnidades = itens.reduce((s, it) => s + (Number(it.quantidade) || 0), 0);
        return (
        <section key={p.id} className="rounded-lg border p-4 print:break-inside-avoid print:rounded-none print:border-0 print:border-b print:p-2">
          <div className="flex items-start justify-between gap-2 border-b-2 border-foreground pb-2">
            <div>
              {nomeOrganizacao && <p className="text-xs font-bold uppercase">{nomeOrganizacao}</p>}
              <h2 className="text-lg font-bold">
                {t("Pedido")} Nº {p.numero}
              </h2>
              <p className="text-sm text-muted-foreground">
                {new Date(p.created_at).toLocaleDateString()} · {numeroDoPedido(p.numero)}
              </p>
            </div>
            <p className="shrink-0 rounded-full border border-border-strong px-3 py-1 text-xs font-medium uppercase tracking-wide">
              {status}
            </p>
          </div>

          <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
            <div>
              <CampoCliente rotulo={t("Cliente")} valor={c.nome} />
              <CampoCliente rotulo={t("Nome fantasia")} valor={c.fantasia} />
              <CampoCliente rotulo={c.rotuloDocumento} valor={c.documento} />
              <CampoCliente rotulo={t("Inscrição estadual")} valor={c.ie} />
              <CampoCliente rotulo={t("Telefone")} valor={c.fone} />
              <CampoCliente rotulo="E-mail" valor={c.email} />
            </div>
            <div>
              <CampoCliente rotulo={t("Endereço")} valor={c.endereco} />
              <CampoCliente rotulo={t("Bairro")} valor={c.bairro} />
              <CampoCliente rotulo="CEP" valor={c.cep} />
              <CampoCliente
                rotulo={t("Cidade / Estado")}
                valor={[c.cidade, c.uf].filter(Boolean).join("/") || null}
              />
            </div>
          </div>

          <table className="mt-3 w-full text-[13px]">
            <thead>
              <tr className="border-b-2 border-foreground bg-muted/60 text-left print:bg-transparent">
                <th className="px-1 py-1 font-semibold">#</th>
                <th className="px-1 py-1 font-semibold">{t("Código")}</th>
                <th className="px-1 py-1 font-semibold">{t("Produto")}</th>
                <th className="px-1 py-1 text-right font-semibold">{t("Qtde.")}</th>
                <th className="px-1 py-1 text-center font-semibold">{t("Un.")}</th>
                <th className="px-1 py-1 text-right font-semibold">{t("Desc.")}</th>
                <th className="px-1 py-1 text-right font-semibold">{t("Preço líq.")}</th>
                <th className="px-1 py-1 text-right font-semibold">{t("Subtotal")}</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it, i) => (
                <tr key={it.id} className="border-t">
                  <td className="px-1 py-1 text-muted-foreground">{i + 1}</td>
                  <td className="px-1 py-1 text-muted-foreground">{it.produto_codigo || "—"}</td>
                  <td className="px-1 py-1 font-medium">{it.produto_nome}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{it.quantidade}</td>
                  <td className="px-1 py-1 text-center">{it.unidade || "UN"}</td>
                  <td className="px-1 py-1 text-right tabular-nums">
                    {Number(it.desconto_pct) > 0 ? `${Number(it.desconto_pct)}%` : "—"}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums">{comoMoeda(precoLiquido(it), p.moeda)}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{comoMoeda(it.subtotal_cents, p.moeda)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex justify-end">
            <dl className="w-56 space-y-1 text-[13px] tabular-nums">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t("Subtotal")}</dt>
                <dd>{comoMoeda(p.subtotal_cents, p.moeda)}</dd>
              </div>
              {p.desconto_cents > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t("Desconto")}</dt>
                  <dd>−{comoMoeda(p.desconto_cents, p.moeda)}</dd>
                </div>
              )}
              {p.frete_cents > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t("Frete")}</dt>
                  <dd>+{comoMoeda(p.frete_cents, p.moeda)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t pt-1 text-base font-bold">
                <dt>{t("Valor total")}</dt>
                <dd>{comoMoeda(p.total_cents, p.moeda)}</dd>
              </div>
            </dl>
          </div>
          <p className="mt-1 text-right text-xs text-muted-foreground tabular-nums">
            {qtdItens} {qtdItens === 1 ? t("item") : t("itens")} · {qtdUnidades}{" "}
            {qtdUnidades === 1 ? t("unidade") : t("unidades")}
          </p>

          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
            {p.condicao_pagamento && (
              <p>
                <span className="text-muted-foreground">{t("Condição de pagamento")}: </span>
                {p.condicao_pagamento}
              </p>
            )}
            {p.transportadora_nome && (
              <p>
                <span className="text-muted-foreground">{t("Transportadora")}: </span>
                {p.transportadora_nome}
              </p>
            )}
            {p.previsao_entrega && (
              <p>
                <span className="text-muted-foreground">{t("Previsão de entrega")}: </span>
                {new Date(p.previsao_entrega).toLocaleDateString()}
              </p>
            )}
            {p.endereco_entrega?.trim() && (
              <p>
                <span className="text-muted-foreground">{t("Endereço de entrega")}: </span>
                {p.endereco_entrega.trim()}
              </p>
            )}
            <p>
              <span className="text-muted-foreground">{t("Data de emissão")}: </span>
              {new Date(p.created_at).toLocaleDateString()}
            </p>
          </div>
          {p.observacoes?.trim() && (
            <p className="mt-1 text-[13px]">
              <span className="text-muted-foreground">{t("Informações adicionais")}: </span>
              {p.observacoes.trim()}
            </p>
          )}
          <div className="mt-8 grid grid-cols-2 gap-8 text-center text-xs text-muted-foreground">
            <p className="border-t border-border-strong pt-1">{t("Assinatura do cliente")}</p>
            <p className="border-t border-border-strong pt-1">{t("Assinatura do responsável")}</p>
          </div>
          {idx < pedidos.length - 1 && <div className="hidden print:block print:h-4" />}
        </section>
        );
      })}
    </div>
  );
}
