"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

/**
 * A Conexão (spec §7a): o dono cola a chave, o servidor a testa, registra o
 * aviso de pagamento e guarda cifrado. A tela só vê os 4 últimos. Trocar a
 * chave de teste pela de produção é a PUBLICAÇÃO: pede confirmação dizendo
 * quantas empresas voltam ao teste grátis.
 */
export function ConexaoDaCobranca({
  provedor,
  modo,
  last4,
  urlDoWebhook,
}: {
  provedor: string | null;
  modo: string | null;
  last4: string | null;
  urlDoWebhook: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const [escolhido, setEscolhido] = useState(provedor ?? "stripe");
  const [chave, setChave] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [aPublicar, setAPublicar] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function conectar(confirmar: boolean) {
    setOcupado(true);
    setErro(null);
    try {
      const { data: r } = await apiClient.post<{ data: { modo: string; publicadas: number } }>("/api/v1/admin/cobranca/conexao", {
        provedor: escolhido,
        chave: chave.trim(),
        ...(confirmar ? { confirmar_publicacao: true } : {}),
      });
      setChave("");
      setAPublicar(null);
      toast.success(
        t(r.modo === "producao" ? "Conectado em produção: as próximas cobranças são reais." : "Conectado em modo de teste: nenhum pagamento é real."),
      );
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "publicacao_requer_confirmacao") {
        setAPublicar(Number(e.details?.assinaturas_de_teste ?? 0));
      } else if (e instanceof ApiError) {
        setErro(e.message);
      } else {
        showApiError(e);
      }
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card className="max-w-2xl space-y-4 p-6">
      {urlDoWebhook === null && (
        // Antes do clique, não depois de um 422: o endereço vem da instalação, fora desta tela.
        <p role="alert" className="rounded-md border p-3 text-sm">
          {t(
            "A Stripe só avisa pagamentos num endereço https público (ex.: https://crm.example.com). Configure o domínio do sistema com HTTPS e volte aqui.",
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{t("Provedor de pagamento")}</h2>
        {modo && <Badge variant={modo === "producao" ? "success" : "warning"}>{t(modo === "producao" ? "PRODUÇÃO" : "MODO DE TESTE")}</Badge>}
      </div>
      {last4 && (
        <p className="text-sm">
          {t("Chave conectada:")} …{last4}
        </p>
      )}
      <div className="space-y-1">
        <Label htmlFor="provedor">{t("Provedor")}</Label>
        <select
          id="provedor"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={escolhido}
          onChange={(e) => setEscolhido(e.target.value)}
        >
          <option value="stripe">Stripe</option>
          <option value="asaas" disabled>
            {t("Asaas (em breve)")}
          </option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="chave-secreta">{t("Chave secreta")}</Label>
        <Input
          id="chave-secreta"
          type="password"
          autoComplete="off"
          value={chave}
          onChange={(e) => setChave(e.target.value)}
          placeholder="sk_test_… / rk_test_…"
        />
        <p className="text-xs text-muted-foreground">
          {t("Na Stripe: Desenvolvedores › Chaves de API. Comece pela chave de teste; troque pela de produção quando a compra de teste der certo.")}
        </p>
      </div>
      {erro && (
        <p role="alert" className="text-sm text-error-fg">
          {erro}
        </p>
      )}
      {aPublicar !== null && (
        <div role="alert" className="space-y-2 rounded-md border p-3 text-sm">
          <p>
            {(aPublicar === 1 ? t("{n} empresa assinou em modo de teste. Ao publicar, ela volta para o teste grátis e precisa assinar de novo com um cartão de verdade.") : t("{n} empresas assinaram em modo de teste. Ao publicar, elas voltam para o teste grátis e precisam assinar de novo com um cartão de verdade.")).replace(
              "{n}",
              String(aPublicar),
            )}
          </p>
          <Button disabled={ocupado} onClick={() => void conectar(true)}>
            {t("Publicar mesmo assim")}
          </Button>
        </div>
      )}
      <Button disabled={ocupado || chave.trim().length < 10 || urlDoWebhook === null} onClick={() => void conectar(false)}>
        {t("Testar e conectar")}
      </Button>
      {urlDoWebhook && (
        <p className="text-xs text-muted-foreground">
          {t("Os avisos de pagamento chegam em")} <code>{urlDoWebhook}</code>
        </p>
      )}
    </Card>
  );
}
