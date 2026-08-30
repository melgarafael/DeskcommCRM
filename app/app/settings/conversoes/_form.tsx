"use client";

/**
 * O formulário da conexão com a conta de anúncios.
 *
 * ── Por que o campo do token nasce VAZIO e isso não é um bug ─────────────────
 *
 * A tela nunca recebe o token — `lerEstadoDaConexao` devolve só um booleano.
 * Então o input vazio significa "mantenha o que está gravado", e o placeholder
 * diz isso com todas as letras. Pré-preencher com o valor real o colocaria no
 * HTML de uma página que o browser cacheia, e o segredo passaria a viver em
 * disco de cliente. Mesmo contrato da tela do Google (`/admin/google`).
 *
 * ── O switch pausa; NÃO existe remover ──────────────────────────────────────
 *
 * Desligar interrompe o envio e mantém a credencial gravada — é o que o texto
 * ao lado do switch diz, e é tudo o que esta tela faz. Pausar sem apagar é
 * deliberado: quem só queria parar por uma semana não deveria ter de conseguir
 * um token novo na plataforma, porque o caminho de volta é o passo caro.
 *
 * ⚠️ LACUNA CONHECIDA: remover a conexão não tem superfície. Não há botão de
 * desconectar, e a única saída hoje é DELETE na tabela — o que contraria o
 * invariante 6 da doutrina de restrição de canal, que cobra tela para ver e
 * tela para MUDAR todo estado configurável. Fica registrado aqui em vez de
 * virar comentário que descreve um botão inexistente: até existir, este texto
 * é a única coisa que impede alguém de procurar o botão na tela.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateAdPlatformConnection } from "@/app/actions/settings/updateAdPlatformConnection";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { EstadoDaConexao } from "@/lib/conversoes/estado-da-conexao";

/**
 * Cada recusa vira uma frase que diz O QUE FAZER. `cifra_indisponivel` é a que
 * mais importa acertar: é problema de INSTALAÇÃO, e um texto genérico mandaria o
 * admin do tenant refazer um cadastro que já está certo, para falhar igual.
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

export function FormularioDeConversoes({
  estado,
  idioma,
}: {
  estado: EstadoDaConexao;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [datasetId, setDatasetId] = useState(estado.datasetId ?? "");
  const [token, setToken] = useState("");
  const [codigoDeTeste, setCodigoDeTeste] = useState(estado.testEventCode ?? "");
  const [habilitada, setHabilitada] = useState(estado.habilitada);

  // Ligar sem nunca ter gravado token deixaria a conexão "ativa" e o livro-razão
  // acumulando `credencial_incompleta` — barrar aqui explica antes de acontecer.
  const podeSalvar = datasetId.trim().length >= 5 && (estado.temToken || token.trim().length >= 20);

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const resultado = await updateAdPlatformConnection({
        platform: "meta_ads",
        dataset_id: datasetId.trim(),
        access_token: token.trim() || undefined,
        test_event_code: codigoDeTeste.trim() || null,
        enabled: habilitada,
      });

      if (resultado.ok) {
        setToken("");
        toast.success(t("Conexão salva."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="p-6">
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="dataset_id">{t("Identificador do destino de conversões")}</Label>
          <Input
            id="dataset_id"
            inputMode="numeric"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            placeholder="123456789012345"
          />
          <p className="text-xs text-muted-foreground">
            {t("Só números. Você encontra no gerenciador de anúncios, na fonte de dados que recebe as conversões.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="access_token">{t("Token de acesso")}</Label>
          <Input
            id="access_token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              estado.temToken
                ? t("Gravado. Deixe em branco para manter.")
                : t("Cole o token gerado na plataforma")
            }
          />
          <p className="text-xs text-muted-foreground">
            {t("Guardado criptografado. Ele nunca volta para esta tela depois de salvo.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="test_event_code">{t("Código de teste (opcional)")}</Label>
          <Input
            id="test_event_code"
            value={codigoDeTeste}
            onChange={(e) => setCodigoDeTeste(e.target.value)}
            placeholder="TEST12345"
          />
          <p className="text-xs text-muted-foreground">
            {t("Enquanto preenchido, as vendas vão marcadas como teste e não contam para a otimização. Apague quando terminar de conferir.")}
          </p>
        </div>

        <div className="flex items-center justify-between rounded-md border p-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="enabled">{t("Reportar vendas automaticamente")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("Desligar pausa o envio e mantém a credencial gravada.")}
            </p>
          </div>
          <Switch id="enabled" checked={habilitada} onCheckedChange={setHabilitada} />
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isPending || !podeSalvar}>
            {isPending ? t("Salvando…") : t("Salvar conexão")}
          </Button>
          {!podeSalvar && (
            <span className="text-xs text-muted-foreground">
              {t("Preencha o identificador e o token para poder salvar.")}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
