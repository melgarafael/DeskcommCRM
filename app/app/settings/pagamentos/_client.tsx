"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EstadoDoGatewayParaTela } from "@/lib/pagamentos/gateway-da-organizacao";
import {
  ehProvedorDePagamento,
  PROVEDORES_DE_PAGAMENTO,
  type ProvedorDePagamento,
} from "@/lib/pagamentos/vocabulario";

/**
 * A tela do gateway de pagamento da ORGANIZAÇÃO (issue #4058).
 *
 * ─── O que esta tela entrega, e o que ela recusa entregar ───────────────────
 *
 * Escolher o provedor, digitar a chave, salvar e desligar. É isso. O MODO
 * (teste/produção) não é um campo: ele é derivado do prefixo da chave no
 * servidor (`modoDaChave`), e aqui só aparece o que VOLTOU da rota. Um campo de
 * modo livre deixaria gravar "produção" com chave de teste e mandar o cliente
 * pagar num link que não cobra — o mesmo defeito que a tela do trunk SIP evita
 * não pedindo o endpoint.
 *
 * ─── A chave digitada vive UM request ───────────────────────────────────────
 *
 * `chave` é estado local, entra no corpo do PUT e é ZERADA no sucesso. A
 * resposta não tem campo de chave (`EstadoDoGatewayParaTela` não tem `apiKey`),
 * então não há o que persistir nem o que reexibir. Depois de salvar, o que a
 * tela mostra é o `last4` que o servidor mandou — quatro caracteres, não a
 * chave. Quem recarrega a página não recebe a chave de volta: ela não existe em
 * claro em lugar nenhum, só o envelope AES-256-GCM no banco.
 *
 * ─── Herdar é um estado NOMEADO, não um vazio ───────────────────────────────
 *
 * Organização sem linha própria — ou com a linha desligada — usa o gateway da
 * instalação. A tela diz isso com todas as letras e NÃO mostra `last4`: a chave
 * herdada não é desta organização, e exibir os últimos dígitos dela aqui seria
 * vazar um pedaço de credencial de outra conta. Quem resolve a herança é o
 * servidor; esta tela só desenha o que ele respondeu.
 */
export interface GatewaySettingsRow {
  organization_id: string;
  provider: string;
  mode: string;
  api_key_last4: string;
  webhook_secret_last4: string | null;
  is_active: boolean;
}

const queryKey = ["pagamentos", "gateway"] as const;

const CAMINHO = "/api/v1/pagamentos/gateway";

interface ErroDaTela {
  codigo: string;
  mensagem: string;
  /** Qual gesto falhou — a frase muda, o código não. */
  acao: "salvar" | "desligar";
}

/**
 * O erro do provedor chega NOMEADO (`invalid_provider_key`,
 * `provider_key_mode_mismatch`, …) e é assim que ele aparece: com o código, ao
 * lado da frase. Sem isto, três causas muito diferentes — chave errada,
 * ambiente trocado, provedor fora do ar — viravam o mesmo "erro ao salvar", e
 * quem estava configurando não tinha por onde começar. A frase vem da rota
 * (que tem o contexto) e passa por `t()` como em todo o resto do produto
 * (`showApiError` faz o mesmo); o código é wire e não se traduz.
 */
function comoErroDaTela(err: unknown, acao: ErroDaTela["acao"]): ErroDaTela {
  if (err instanceof ApiError) return { codigo: err.code, mensagem: err.message, acao };
  return { codigo: "unexpected_error", mensagem: "", acao };
}

export function GatewayDaOrganizacaoClient({
  initialRow,
  canWrite,
}: {
  initialRow: GatewaySettingsRow | null;
  canWrite: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<ErroDaTela | null>(null);
  /** Só a chave DIGITADA nesta sessão. Vazia = "manter a que já está gravada". */
  const [chave, setChave] = useState("");
  const [provedorEscolhido, setProvedorEscolhido] = useState<ProvedorDePagamento | null>(null);

  const { data: estado } = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<{ data: EstadoDoGatewayParaTela | null }>(CAMINHO);
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });

  /**
   * O provedor no seletor: o que a pessoa escolheu vence; senão o que o servidor
   * disse estar em vigor (inclusive herdado — é a sugestão mais útil para quem
   * vai configurar o próprio); senão a linha da view, que já veio pronta no
   * primeiro render e evita o campo piscar vazio.
   */
  const provedorNaTela: ProvedorDePagamento | "" =
    provedorEscolhido ??
    estado?.provider ??
    (ehProvedorDePagamento(initialRow?.provider) ? initialRow.provider : "");

  const salvar = useMutation({
    mutationFn: async () => {
      const corpo: Record<string, unknown> = { provider: provedorNaTela, is_active: true };
      // A chave só entra quando foi digitada: ausente = o servidor mantém a já
      // cifrada (é o que permite trocar o modo sem redigitar o segredo).
      if (chave.trim()) corpo.api_key = chave.trim();
      const res = await apiClient.put<{ data: EstadoDoGatewayParaTela }>(CAMINHO, corpo);
      return res.data;
    },
    onSuccess: (novo) => {
      setChave("");
      setProvedorEscolhido(null);
      setErro(null);
      queryClient.setQueryData(queryKey, novo);
    },
    onError: (err) => {
      setErro(comoErroDaTela(err, "salvar"));
      showApiError(err);
    },
  });

  const desligar = useMutation({
    mutationFn: async () => {
      const res = await apiClient.delete<{ data: EstadoDoGatewayParaTela }>(CAMINHO);
      return res.data;
    },
    onSuccess: (novo) => {
      setChave("");
      setProvedorEscolhido(null);
      setErro(null);
      queryClient.setQueryData(queryKey, novo);
    },
    onError: (err) => {
      setErro(comoErroDaTela(err, "desligar"));
      showApiError(err);
    },
  });

  // Campo vazio não vai ao servidor: sem chave nova a rota recusaria com
  // `credential_required` (ou pior, trocaria o provedor e emparelharia a chave
  // antiga com o provedor novo). A tela barra antes, e o botão diz por quê.
  const podeSalvar =
    canWrite && provedorNaTela !== "" && chave.trim().length > 0 && !salvar.isPending;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Gateway em vigor")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {estado === undefined ? (
            <p className="text-muted-foreground">{t("Consultando o gateway em vigor…")}</p>
          ) : estado === null || estado.origem === "nenhuma" ? (
            <p className="text-muted-foreground">
              {t("Nenhum gateway configurado — nem nesta organização, nem na instalação.")}
            </p>
          ) : (
            <>
              <p className="font-medium">
                {estado.origem === "organizacao"
                  ? t("Configurado por esta organização.")
                  : t("Herdado da instalação — nenhuma chave desta organização é usada.")}
              </p>
              <p>
                {t("Provedor")}:{" "}
                {estado.provider === "stripe" ? t("Stripe") : estado.provider === "asaas" ? t("Asaas") : "—"}
                {" · "}
                {t("Modo")}:{" "}
                {estado.modo === "teste" ? t("Teste") : estado.modo === "producao" ? t("Produção") : "—"}
              </p>
              {estado.origem === "organizacao" && estado.apiKeyLast4 ? (
                <p className="text-muted-foreground">
                  {t("Chave")} {t("configurada, termina em")} <code>{estado.apiKeyLast4}</code>
                </p>
              ) : (
                <p className="text-muted-foreground">
                  {t("A configuração herdada não expõe nem os últimos dígitos da chave.")}
                </p>
              )}
              {estado.configurada && !estado.isActive && (
                <p className="text-muted-foreground">
                  {t(
                    "A configuração própria desta organização está desligada; a cobrança volta a usar a da instalação.",
                  )}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Configuração desta organização")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider">{t("Provedor")}</Label>
            <select
              id="provider"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={provedorNaTela}
              disabled={!canWrite}
              onChange={(e) => setProvedorEscolhido(ehProvedorDePagamento(e.target.value) ? e.target.value : null)}
            >
              <option value="">{t("Escolha o provedor")}</option>
              {PROVEDORES_DE_PAGAMENTO.map((p) => (
                <option key={p} value={p}>
                  {p === "stripe" ? t("Stripe") : t("Asaas")}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api_key">
              {t("Chave do provedor")}{" "}
              {estado?.origem === "organizacao" && estado.apiKeyLast4 ? (
                <span className="text-muted-foreground">
                  ({t("configurada, termina em")} {estado.apiKeyLast4})
                </span>
              ) : null}
            </Label>
            <Input
              id="api_key"
              type="password"
              autoComplete="off"
              placeholder={t("Deixe em branco para manter a atual")}
              value={chave}
              disabled={!canWrite}
              onChange={(e) => setChave(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "O modo (teste ou produção) vem da própria chave — não há campo para escolher. A chave desaparece desta tela assim que for salva.",
              )}
            </p>
          </div>

          {erro && (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              <span>
                {erro.acao === "salvar"
                  ? t("O gateway não foi salvo.")
                  : t("O gateway não foi desligado.")}
              </span>
              <code className="rounded-md bg-muted px-1 py-0.5 text-xs">{erro.codigo}</code>
              {erro.mensagem ? <span className="text-muted-foreground">{t(erro.mensagem)}</span> : null}
            </p>
          )}

          {canWrite ? (
            <div className="flex items-center gap-2">
              <Button onClick={() => salvar.mutate()} disabled={!podeSalvar} className="w-fit">
                {salvar.isPending ? t("Salvando...") : t("Salvar")}
              </Button>
              {estado?.origem === "organizacao" && (
                <Button
                  variant="outline"
                  onClick={() => desligar.mutate()}
                  disabled={desligar.isPending}
                  className="w-fit"
                >
                  {desligar.isPending ? t("Desligando...") : t("Desligar")}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("Só administradores da organização alteram o gateway de pagamento.")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
