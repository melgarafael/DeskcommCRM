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
import { copyToClipboard } from "@/lib/clipboard";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";

interface AvisoManual {
  url: string;
  segredo: string;
  eventos: string[];
}

/** Um valor que o dono leva para o painel do provedor: à vista e com um botão de copiar. */
function CampoCopiavel({ rotulo, valor, botao }: { rotulo: string; valor: string; botao: string }) {
  const t = useT();
  async function copiar() {
    // O helper também funciona em http://IP (self-host sem HTTPS), onde a API de cópia do navegador não existe.
    if (await copyToClipboard(valor)) toast.success(t("Copiado."));
    else toast.error(t("Não consegui copiar. Selecione o texto e copie à mão."));
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{rotulo}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded-md bg-muted px-2 py-1 text-xs">{valor}</code>
        <Button size="sm" variant="outline" onClick={() => void copiar()}>
          {botao}
        </Button>
      </div>
    </div>
  );
}

/**
 * A Conexão (spec §7a): o dono escolhe o provedor (uma frase diz para que serve
 * cada um), cola a chave, o servidor a testa, registra o aviso de pagamento e
 * guarda cifrado. A tela só vê os 4 últimos. Trocar a chave de teste pela de
 * produção é a PUBLICAÇÃO: pede confirmação dizendo quantas empresas voltam ao
 * teste grátis. Quando o Asaas não registra o aviso pela API, o passo manual
 * (URL, token e eventos) aparece UMA vez: o token não volta a ser mostrado, e
 * quem o perder conecta de novo.
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
  const [escolhido, setEscolhido] = useState<ProvedorDeCobranca>(provedor === "asaas" ? "asaas" : "stripe");
  const [chave, setChave] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [aPublicar, setAPublicar] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [manual, setManual] = useState<AvisoManual | null>(null);
  const asaas = escolhido === "asaas";
  // ponytail: o último segmento é o provedor (`urlDoWebhookDaCobranca`); trocá-lo aqui evita levar o env do servidor à tela.
  const urlDoEscolhido = urlDoWebhook === null ? null : urlDoWebhook.replace(/\/[a-z]+$/, `/${escolhido}`);

  async function conectar(confirmar: boolean) {
    setOcupado(true);
    setErro(null);
    try {
      const { data: r } = await apiClient.post<{ data: { modo: string; webhook: "automatico" | { manual: AvisoManual }; publicadas: number } }>(
        "/api/v1/admin/cobranca/conexao",
        { provedor: escolhido, chave: chave.trim(), ...(confirmar ? { confirmar_publicacao: true } : {}) },
      );
      setChave("");
      setAPublicar(null);
      setManual(r.webhook === "automatico" ? null : r.webhook.manual);
      if (r.webhook === "automatico") {
        toast.success(
          t(r.modo === "producao" ? "Conectado em produção: as próximas cobranças são reais." : "Conectado em modo de teste: nenhum pagamento é real."),
        );
      } else {
        // "Conectado" sozinho faria o dono sair da tela com o aviso por cadastrar.
        toast.warning(t("Conectado. Falta um passo: cadastre o aviso no Asaas (veja abaixo)."));
      }
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
      {urlDoEscolhido === null && (
        // Antes do clique, não depois de um 422: o endereço vem da instalação, fora desta tela.
        <p role="alert" className="rounded-md border p-3 text-sm">
          {asaas
            ? t("O Asaas só avisa pagamentos num endereço https público (ex.: https://crm.example.com). Configure o domínio do sistema com HTTPS e volte aqui.")
            : t("A Stripe só avisa pagamentos num endereço https público (ex.: https://crm.example.com). Configure o domínio do sistema com HTTPS e volte aqui.")}
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
          onChange={(e) => setEscolhido(e.target.value === "asaas" ? "asaas" : "stripe")}
        >
          <option value="stripe">Stripe</option>
          <option value="asaas">Asaas</option>
        </select>
        <ul className="space-y-1 pt-1 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Asaas</span>
            {" — "}
            {t("todo mês o cliente recebe a cobrança e paga por Pix, boleto ou cartão: o jeito que o brasileiro paga. Pede o CPF ou CNPJ. Recomendado se seus clientes estão no Brasil.")}
          </li>
          <li>
            <span className="font-medium text-foreground">Stripe</span>
            {" — "}
            {t("cobra o cartão sozinho todo mês e aceita boleto, mas não tem Pix.")}
          </li>
        </ul>
      </div>
      <div className="space-y-1">
        <Label htmlFor="chave-secreta">{asaas ? t("Chave de API do Asaas") : t("Chave secreta")}</Label>
        <Input
          id="chave-secreta"
          type="password"
          autoComplete="off"
          value={chave}
          onChange={(e) => setChave(e.target.value)}
          placeholder={asaas ? "$aact_hmlg_…" : "sk_test_… / rk_test_…"}
        />
        <p className="text-xs text-muted-foreground">
          {asaas
            ? t("No Asaas: menu Integrações › Chaves de API. Comece pela conta de sandbox do Asaas; troque pela chave de produção quando a compra de teste der certo.")
            : t("Na Stripe: Desenvolvedores › Chaves de API. Comece pela chave de teste; troque pela de produção quando a compra de teste der certo.")}
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
      <Button disabled={ocupado || chave.trim().length < 10 || urlDoEscolhido === null} onClick={() => void conectar(false)}>
        {t("Testar e conectar")}
      </Button>
      {urlDoEscolhido && (
        <p className="text-xs text-muted-foreground">
          {t("Os avisos de pagamento chegam em")} <code>{urlDoEscolhido}</code>
        </p>
      )}
      {manual && (
        <section
          aria-label={t("Falta um passo: cadastre o aviso de pagamento no Asaas")}
          className="space-y-3 rounded-md border bg-warning-bg p-4 text-sm text-warning-fg"
        >
          <h3 className="font-semibold">{t("Falta um passo: cadastre o aviso de pagamento no Asaas")}</h3>
          <p>
            {t("O Asaas não deixou o sistema cadastrar o aviso sozinho. No Asaas, abra Integrações › Webhooks. Se já existir um aviso com o endereço abaixo, edite-o e troque só o token; se não, clique em Adicionar e preencha assim:")}
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t("Nome: Cobrança do sistema")}</li>
            <li>{t("E-mail: o seu (o Asaas avisa por ele se os avisos pararem)")}</li>
            <li>{t("Versão da API: v3")}</li>
            <li>{t("Webhook ativado: Sim")}</li>
            <li>{t("Fila de sincronização ativada: Sim")}</li>
            <li>{t("Tipo de envio: Sequencial")}</li>
          </ul>
          <CampoCopiavel rotulo={t("URL do aviso")} valor={manual.url} botao={t("Copiar URL")} />
          <CampoCopiavel rotulo={t("Token de autenticação")} valor={manual.segredo} botao={t("Copiar token")} />
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("Eventos: marque estes, um por um")}</p>
            <ul className="space-y-0.5 font-mono text-xs">
              {manual.eventos.map((evento) => (
                <li key={evento} data-evento>
                  {evento}
                </li>
              ))}
            </ul>
          </div>
          <p>{t("O token aparece só agora: se sair desta tela sem copiá-lo, conecte de novo para gerar outro.")}</p>
          <p>{t("Quando o primeiro aviso chegar, o passo fica marcado na Visão geral.")}</p>
          <Button variant="outline" onClick={() => setManual(null)}>
            {t("Pronto, já cadastrei")}
          </Button>
        </section>
      )}
    </Card>
  );
}
