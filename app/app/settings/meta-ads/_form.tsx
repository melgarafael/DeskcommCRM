"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  disconnectAdInsights,
  updateAdInsightsConnection,
} from "@/app/actions/settings/updateAdInsightsConnection";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * Cada recusa vira uma frase que diz O QUE FAZER — mesma regra do formulário de
 * Conversões. `cifra_indisponivel` é a que mais importa acertar: é problema de
 * INSTALAÇÃO, e um texto genérico mandaria o admin do tenant refazer um cadastro
 * que já está certo, para falhar igual.
 */
const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: algum valor não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  cifra_indisponivel:
    "Esta instalação está sem a chave mestra de criptografia, e o token não foi gravado. Quem instalou o sistema precisa configurá-la — refazer o cadastro aqui não resolve.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export function FormularioDeMetaAds({
  conectada,
  contaPadrao,
  idioma,
}: {
  conectada: boolean;
  contaPadrao: string | null;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [token, setToken] = useState("");
  const [conta, setConta] = useState(contaPadrao ?? "");

  // Na primeira conexão o token é obrigatório — a coluna é NOT NULL (0214) e a
  // Server Action recusa. Barrar aqui explica antes de o clique acontecer, em
  // vez de devolver um erro de validação depois.
  const podeSalvar = conectada || token.trim().length >= 20;

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const resultado = await updateAdInsightsConnection({
        platform: "meta_ads",
        access_token: token.trim() || undefined,
        default_account_id: conta.trim() || null,
      });

      if (resultado.ok) {
        // O campo é limpo no sucesso: deixá-lo preenchido dá a impressão de que
        // a tela guarda o token, e ela nunca o mostra de volta.
        setToken("");
        toast.success(t("Conexão salva."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  function desconectar() {
    startTransition(async () => {
      const resultado = await disconnectAdInsights();
      if (resultado.ok) {
        setToken("");
        setConta("");
        toast.success(t("Conta desconectada."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui desconectar agora."));
    });
  }

  return (
    <Card className="p-6">
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="access_token">{t("Token de acesso")}</Label>
          <Input
            id="access_token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={conectada ? t("Guardado — preencha só para trocar") : "EAA…"}
          />
          <p className="text-xs text-muted-foreground">
            {conectada
              ? t(
                  "Já existe um token guardado. Deixe em branco para mantê-lo, ou cole um novo para substituir.",
                )
              : t("Precisa da permissão ads_read.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="default_account_id">{t("Conta padrão (opcional)")}</Label>
          <Input
            id="default_account_id"
            value={conta}
            onChange={(e) => setConta(e.target.value)}
            placeholder="act_123456789012345"
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "A conta que a tela de Meta Ads abre por padrão. Em branco, ela abre a primeira conta ativa que o token alcançar.",
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isPending || !podeSalvar}>
            {isPending ? t("Salvando…") : t("Salvar")}
          </Button>

          {conectada && (
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={desconectar}
            >
              {t("Desconectar")}
            </Button>
          )}

          {!podeSalvar && (
            <span className="text-sm text-muted-foreground">
              {t("Cole o token para poder salvar.")}
            </span>
          )}
        </div>

        {conectada && (
          <p className="text-xs text-muted-foreground">
            {/*
              Desconectar APAGA a linha — não existe "pausar" nesta feature, e o
              porquê está no cabeçalho da 0214: como nada roda sozinho, um estado
              "conectado mas desligado" teria a mesma consequência visível de não
              estar conectado.
            */}
            {t(
              "Desconectar apaga o token guardado. A tela de Meta Ads volta a pedir uma conexão, e nenhum dado histórico é perdido — nada é armazenado aqui.",
            )}
          </p>
        )}
      </form>
    </Card>
  );
}
