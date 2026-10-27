"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { documentoDoPagador, exigeDocumento } from "@/lib/cobranca/documento";
import { linkDePagamentoSeguro } from "@/lib/cobranca/link";
import { abrirNoNavegador } from "@/lib/cobranca/navegar";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { useT } from "@/lib/i18n/IdiomaProvider";

const BASE = "/api/v1/cobranca/assinatura";
type Props = {
  temIntencao: boolean;
  automatico: boolean;
  provedor: ProvedorDeCobranca | null;
  clienteExiste: boolean;
  documentoInicial: string | null;
  voltou: boolean;
};

/** Só POST autenticado prepara pagamento; GET/preview não chama o provedor. */
export function ContinuarPagamento(p: Props) {
  const t = useT();
  const router = useRouter();
  const [documento, setDocumento] = useState(p.documentoInicial ?? "");
  const [ocupado, setOcupado] = useState(false);
  const [recado, setRecado] = useState<string | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const emVoo = useRef(false);
  const iniciou = useRef(false);
  const montado = useRef(true);
  const pedeDocumento = exigeDocumento(p.provedor, p.clienteExiste);
  const normalizado = documentoDoPagador(documento);
  const erroDocumento = documento.trim() !== "" && normalizado === null;

  const abrirPagamento = useCallback((url: string) => {
    const segura = linkDePagamentoSeguro(url);
    if (!segura) throw new Error("link_invalido");
    // Voltar do Asaas mostra a continuação; não redireciona de novo em laço.
    window.history.replaceState(window.history.state, "", "/cobranca/contratar?retomar=1");
    setLink(segura);
    abrirNoNavegador(segura);
  }, []);

  const preparar = useCallback(async (pelaIntencao: boolean) => {
    if (emVoo.current || !p.provedor || (pedeDocumento && normalizado === null)) return;
    emVoo.current = true;
    setOcupado(true); setFalhou(false); setRecado(t("Preparando seu pagamento…"));
    try {
      const { data } = await apiClient.post<{ data: { url: string } }>(`${BASE}/checkout`, {
        volta: "contratacao",
        ...(pelaIntencao ? { continuar_cadastro: true } : {}),
        ...(pedeDocumento ? { documento: normalizado } : {}),
      }, { timeoutMs: 90_000 });
      if (montado.current) abrirPagamento(data.url);
    } catch (e) {
      if (!montado.current) return;
      if (e instanceof ApiError && e.code === "pagamento_em_andamento") {
        const existente = linkDePagamentoSeguro(e.details?.link_de_pagamento as string | undefined);
        if (existente) { abrirPagamento(existente); return; }
      }
      setFalhou(true);
      setRecado(t(e instanceof ApiError ? e.message : "Não foi possível preparar seu pagamento. Tente novamente."));
    } finally {
      emVoo.current = false;
      if (montado.current) setOcupado(false);
    }
  }, [abrirPagamento, normalizado, p.provedor, pedeDocumento, t]);

  const conferir = useCallback(async () => {
    if (emVoo.current) return;
    emVoo.current = true; setOcupado(true); setFalhou(false); setRecado(t("Confirmando seu pagamento…"));
    try {
      const { data } = await apiClient.post<{ data: { estado: string | null; org_operante: boolean } }>(`${BASE}/sincronizar`, {});
      if (!montado.current) return;
      if (data.estado === "ativa" && data.org_operante) {
        router.replace("/onboarding/welcome");
        router.refresh();
        return;
      }
      setRecado(t("Ainda não identificamos a confirmação do pagamento. Você pode retomar o pagamento ou conferir novamente em instantes."));
      router.refresh();
    } catch (e) {
      if (montado.current) {
        setFalhou(true);
        setRecado(t(e instanceof ApiError ? e.message : "Não foi possível conferir o pagamento. Tente novamente."));
      }
    } finally {
      emVoo.current = false;
      if (montado.current) setOcupado(false);
    }
  }, [router, t]);

  useEffect(() => {
    montado.current = true;
    let cancelado = false;
    // Inicia o efeito externo depois da montagem; o cleanup também cancela a
    // primeira passagem do StrictMode antes de qualquer POST.
    queueMicrotask(() => {
      if (cancelado || iniciou.current) return;
      iniciou.current = true;
      if (p.voltou) void conferir();
      else if (p.automatico && (!pedeDocumento || documentoDoPagador(p.documentoInicial ?? "") !== null)) void preparar(true);
    });
    return () => { cancelado = true; montado.current = false; };
  }, [conferir, p.automatico, p.documentoInicial, p.voltou, pedeDocumento, preparar]);

  return (
    <div className="space-y-4">
      {!p.temIntencao && <p className="text-sm">{t("Confira o plano e o período acima antes de continuar para o pagamento.")}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void preparar(false); }} className="space-y-4">
        {pedeDocumento && (
          <div className="space-y-2">
            <Label htmlFor="documento-da-contratacao">{t("CPF ou CNPJ de quem paga")}</Label>
            <Input id="documento-da-contratacao" autoComplete="off" maxLength={32} value={documento}
              onChange={(e) => setDocumento(e.target.value)} aria-invalid={erroDocumento}
              aria-describedby="documento-da-contratacao-ajuda" disabled={ocupado} />
            <p id="documento-da-contratacao-ajuda" className="text-sm text-muted-foreground">
              {t(erroDocumento ? "Confira o CPF ou CNPJ: os dígitos não batem." : "Necessário para emitir a cobrança no Asaas. O documento vai ao provedor e não fica guardado neste sistema.")}
            </p>
          </div>
        )}
        {!p.provedor ? (
          <p role="alert">{t("A cobrança ainda não está disponível. Fale com quem administra o sistema; seu plano está preservado.")}</p>
        ) : (
          <Button className="w-full" type="submit" disabled={ocupado || (pedeDocumento && normalizado === null)}>
            {t(ocupado ? "Aguarde…" : falhou ? "Tentar novamente" : "Continuar para pagamento")}
          </Button>
        )}
      </form>
      {link && <Button asChild variant="outline"><a href={link}>{t("Retomar pagamento")}</a></Button>}
      {(p.clienteExiste || link || p.voltou) && (
        <Button type="button" variant="outline" disabled={ocupado} onClick={() => void conferir()}>{t("Já paguei: conferir pagamento")}</Button>
      )}
      {recado && <p role={falhou ? "alert" : "status"} aria-live="polite" className="text-sm">{recado}</p>}
      {p.provedor === "asaas" && <p className="text-sm text-muted-foreground">{t("Pagamento processado pelo Asaas. Escolha entre as formas disponíveis na fatura; as próximas cobranças seguem as condições apresentadas pelo provedor.")}</p>}
    </div>
  );
}
