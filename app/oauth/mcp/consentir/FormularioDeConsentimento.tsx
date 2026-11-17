"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/IdiomaProvider";
import type { PedidoDeAutorizacao } from "@/lib/mcp/oauth/esquemas";

interface Props {
  pedido: PedidoDeAutorizacao;
  nomeDoAplicativo: string;
  hostDeVolta: string;
  organizacoes: { id: string; nome: string }[];
  escritaOferecida: boolean;
  email: string;
}

type Acesso = "leitura" | "leitura_e_escrita";

/**
 * A decisão: qual empresa, ler ou ler e alterar, permitir ou cancelar. O POST
 * devolve o endereço de volta do aplicativo (com o código, ou com
 * `access_denied`) e a tela navega até ele.
 */
export function FormularioDeConsentimento({
  pedido,
  nomeDoAplicativo,
  hostDeVolta,
  organizacoes,
  escritaOferecida,
  email,
}: Props) {
  const t = useT();
  const [organizacao, setOrganizacao] = useState(organizacoes[0]!.id);
  const [acesso, setAcesso] = useState<Acesso>(escritaOferecida ? "leitura_e_escrita" : "leitura");
  const [enviando, setEnviando] = useState<"permitir" | "negar" | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function decidir(decisao: "permitir" | "negar") {
    setEnviando(decisao);
    setErro(null);
    try {
      const resp = await fetch("/api/v1/mcp/oauth/consentir", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...pedido, organization_id: organizacao, acesso, decisao }),
      });
      const corpo = (await resp.json().catch(() => null)) as
        | { data?: { redirect_to?: string }; error?: { message?: string } }
        | null;
      const destino = corpo?.data?.redirect_to;
      if (!resp.ok || !destino) {
        setErro(corpo?.error?.message ?? t("Não foi possível concluir a autorização. Tente de novo."));
        setEnviando(null);
        return;
      }
      window.location.assign(destino);
    } catch {
      setErro(t("Não foi possível concluir a autorização. Tente de novo."));
      setEnviando(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">
          {t("Conectar")} <span data-testid="consentimento-nome">{nomeDoAplicativo}</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("Este aplicativo está pedindo acesso aos dados do CRM pela sua conta")} ({email}).
        </p>
        <p className="rounded-md border px-3 py-2 text-sm" data-testid="consentimento-host">
          {t("A autorização será enviada para:")} <strong>{hostDeVolta}</strong>
        </p>
      </div>

      {organizacoes.length > 1 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("Empresa")}</legend>
          {organizacoes.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="organizacao"
                value={o.id}
                checked={organizacao === o.id}
                onChange={() => setOrganizacao(o.id)}
              />
              {o.nome}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm">
          {t("Empresa")}: <strong>{organizacoes[0]!.nome}</strong>
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("O que o aplicativo poderá fazer")}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="acesso"
            value="leitura"
            checked={acesso === "leitura"}
            onChange={() => setAcesso("leitura")}
            className="mt-1"
          />
          <span>
            <strong>{t("Somente ler")}</strong>
            <span className="block text-muted-foreground">{t("Consultar contatos, conversas, negócios e relatórios.")}</span>
          </span>
        </label>
        {escritaOferecida ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="acesso"
              value="leitura_e_escrita"
              checked={acesso === "leitura_e_escrita"}
              onChange={() => setAcesso("leitura_e_escrita")}
              className="mt-1"
            />
            <span>
              <strong>{t("Ler e alterar")}</strong>
              <span className="block text-muted-foreground">
                {t("Também criar e alterar contatos, negócios, agenda, tarefas e automações, como um administrador.")}
              </span>
              <span className="block font-medium" data-testid="consentimento-envio">
                {t("E enviar mensagens de WhatsApp e materiais diretamente aos seus clientes, em nome da empresa.")}
              </span>
            </span>
          </label>
        ) : null}
      </fieldset>

      <p className="text-xs text-muted-foreground">
        {t("Você pode desligar esta conexão quando quiser na tela API Tokens do CRM.")}
      </p>

      {erro ? (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button className="flex-1" disabled={enviando !== null} onClick={() => decidir("permitir")}>
          {enviando === "permitir" ? t("Autorizando…") : t("Permitir")}
        </Button>
        <Button variant="outline" className="flex-1" disabled={enviando !== null} onClick={() => decidir("negar")}>
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );
}
