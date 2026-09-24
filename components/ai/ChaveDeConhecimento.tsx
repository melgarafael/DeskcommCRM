"use client";

import { useT } from "@/hooks/i18n/useT";
/**
 * A CHAVE QUE FAZ O MATERIAL VIRAR CONHECIMENTO — dita na tela, resolvida ali.
 *
 * Preparar um material para o agente encontrá-lo exige uma chave da OpenAI. Isso
 * era verdade e não estava escrito em lugar nenhum do caminho: a tela de
 * conhecimento prometia "a indexação começa em instantes", o material subia, e
 * numa instalação sem chave nada acontecia — para sempre, sem erro, sem estado,
 * sem aviso.
 *
 * Duas decisões de UX aqui, e as duas são sobre não criar becos:
 *
 *  1. **O aviso vem ANTES do cadastro**, não depois da falha. Descobrir que
 *     faltava chave DEPOIS de subir um PDF de 8 MB é a pior ordem possível.
 *  2. **Dá para resolver sem sair da tela.** O precedente é o passo "o cérebro
 *     dele" do onboarding, que cola a chave dentro do passo que precisa dela.
 *     Mandar a pessoa para outra aba, cadastrar, e voltar é onde se perde gente.
 *
 * Quando JÁ existe chave, o componente não some: ele diz qual está valendo. Sem
 * isso, "por que ele indexou com a chave errada?" não tem resposta na tela.
 */
import { useState } from "react";
import Link from "next/link";
import { KeyRound, CheckCircle2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export type ProvedorDeEmbedding = "google" | "openai";

export interface EstadoDaChave {
  pode_indexar: boolean;
  origem: string | null;
  explicacao: string | null;
  chave_em_uso: string | null;
  avisos: string[];
  credenciais_embedding: Array<{
    id: string;
    provider: string;
    label: string;
    api_key_last4: string | null;
    validated_at: string | null;
    validation_error: string | null;
    is_active: boolean;
  }>;
}

interface Props {
  estado: EstadoDaChave;
  /** Chamado depois de cadastrar uma chave, para a tela recarregar o estado. */
  onChaveCadastrada: () => void;
}

export function ChaveDeConhecimento({ estado, onChaveCadastrada }: Props) {
  const t = useT();
  const [abrindo, setAbrindo] = useState(false);
  const [provedor, setProvedor] = useState<ProvedorDeEmbedding>("google");
  // O rótulo padrão é traduzido porque é o que a pessoa vê preenchido e o que
  // ela grava — não um identificador técnico.
  const [rotulo, setRotulo] = useState(t("Base de conhecimento"));
  const [chave, setChave] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function cadastrar() {
    if (chave.trim().length < 8) {
      toast.error(t("Cole a chave inteira antes de salvar."));
      return;
    }
    setEnviando(true);
    try {
      // A rota do RAG guarda a chave E amarra os dois pontos de embedding a ela
      // — sem isso, o runtime continuaria usando a chave antiga.
      await apiClient.post("/api/v1/ai/rag-embedding", {
        provider: provedor,
        label: rotulo.trim() || t("Base de conhecimento"),
        api_key: chave.trim(),
      });
      toast.success(t("Chave salva. Estamos conferindo com o provedor — leva alguns segundos."));
      setChave("");
      setAbrindo(false);
      // Quem recarrega até a validação voltar é o `refetchInterval` do hook: a
      // resposta do POST vem ANTES da confirmação com o provedor, e chamar isto
      // uma vez só deixaria a tela parada no aviso.
      onChaveCadastrada();
    } catch (err) {
      showApiError(err);
    } finally {
      setEnviando(false);
    }
  }

  // A chave existe e ainda não serve: a validação com o provedor está em curso.
  // Sem dizer isto, a tela repete "falta uma chave" para quem acabou de colar
  // uma — e a pessoa cola outra, achando que errou a primeira.
  const conferindo =
    !estado.pode_indexar &&
    estado.credenciais_embedding.some((c) => c.is_active && !c.validated_at && !c.validation_error);
  const podeIndexar = estado.pode_indexar;

  if (conferindo) {
    return (
      <div
        data-testid="conhecimento-chave-conferindo"
        className="flex items-center gap-2 text-xs text-text-muted"
      >
        <KeyRound className="h-3.5 w-3.5 animate-pulse" aria-hidden />
        <span>{t("Conferindo a chave com o provedor — leva alguns segundos.")}</span>
      </div>
    );
  }

  // O formulário fica disponível SEMPRE — inclusive quando já há uma chave
  // resolvível. É o caso que trouxe esta tela: uma instalação com `OPENAI_API_KEY`
  // sem crédito "tinha chave" (o card dizia "Pronto") e o dono não tinha ONDE
  // cadastrar a do Google. Configurar aqui é ação de primeira classe, não só o
  // remédio para a ausência de chave.
  const formulario = (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>{t("Provedor de embeddings")}</Label>
        <Select
          value={provedor}
          onValueChange={(v) => setProvedor(v as ProvedorDeEmbedding)}
          disabled={enviando}
        >
          <SelectTrigger className="w-64" data-testid="conhecimento-provedor">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="google">{t("Google Gemini (recomendado)")}</SelectItem>
            <SelectItem value="openai">{t("OpenAI")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Button variant="outline" size="sm" asChild>
          <a
            href={
              provedor === "google"
                ? "https://aistudio.google.com/apikey"
                : "https://platform.openai.com/api-keys"
            }
            target="_blank"
            rel="noreferrer"
            data-testid="conhecimento-obter-chave"
          >
            <KeyRound className="mr-2 h-3.5 w-3.5" aria-hidden />
            {provedor === "google"
              ? t("Obter uma chave no Google AI Studio")
              : t("Obter uma chave na OpenAI")}
          </a>
        </Button>
      </div>
      <div className="space-y-1">
        <Label htmlFor="chave-rotulo">{t("Como você quer chamar esta chave")}</Label>
        <Input
          id="chave-rotulo"
          value={rotulo}
          onChange={(e) => setRotulo(e.target.value)}
          disabled={enviando}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="chave-valor">
          {provedor === "google" ? t("Chave do Google AI Studio") : t("Chave da OpenAI")}
        </Label>
        <Input
          id="chave-valor"
          data-testid="conhecimento-chave-input"
          type="password"
          placeholder={provedor === "google" ? "AIza…" : "sk-…"}
          value={chave}
          onChange={(e) => setChave(e.target.value)}
          disabled={enviando}
          autoComplete="off"
        />
        <p className="text-xs text-text-muted">
          {t("Você pega em")}{" "}
          {provedor === "google" ? (
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4"
            >
              aistudio.google.com/apikey
            </a>
          ) : (
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4"
            >
              platform.openai.com/api-keys
            </a>
          )}
          . {t("Ela é guardada cifrada e nunca aparece de volta na tela.")}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={cadastrar}
          disabled={enviando}
          data-testid="conhecimento-chave-salvar"
        >
          {enviando ? t("Salvando…") : t("Salvar chave")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAbrindo(false)} disabled={enviando}>
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );

  if (abrindo) {
    return (
      <Card data-testid="conhecimento-config-chave" className="space-y-3 p-4">
        <h3 className="text-sm font-medium">
          {t("Chave dos embeddings (Base de conhecimento)")}
        </h3>
        <p className="text-xs text-text-muted">
          {t(
            "Depois de trocar o provedor, use “Preparar tudo de novo” no acervo para reindexar o material — a busca usa o mesmo modelo com que o material foi indexado.",
          )}
        </p>
        {formulario}
      </Card>
    );
  }

  if (podeIndexar) {
    return (
      <div
        data-testid="conhecimento-chave-ok"
        className="flex flex-wrap items-center gap-2 text-xs text-text-muted"
      >
        <CheckCircle2 className="h-3.5 w-3.5 text-success-fg" aria-hidden />
        <span>
          {t("Pronto para preparar material.")}{" "}
          {estado.chave_em_uso ? (
            <>
              {t("Usando a chave")}{" "}
              <span className="font-medium text-foreground">{estado.chave_em_uso}</span>.
            </>
          ) : (
            // `explicacao` e `avisos` vêm do servidor, de catálogos fechados
            // (`EXPLICACAO_DA_ORIGEM` em `lib/ai/embeddings/chave.ts`). Passar
            // por um route handler não os tira do alcance do dicionário: a
            // correspondência é por igualdade de string, venha de onde vier.
            estado.explicacao ? t(estado.explicacao) : null
          )}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => setAbrindo(true)}
          data-testid="conhecimento-trocar-chave"
        >
          <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {t("Trocar a chave")}
        </Button>
        {estado.avisos.map((a) => (
          <span key={a} className="w-full text-warning-fg">
            {t(a)}
          </span>
        ))}
      </div>
    );
  }

  return (
    <Card
      data-testid="conhecimento-sem-chave"
      className="space-y-3 border-warning-bg bg-warning-bg/20 p-4"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" aria-hidden />
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {t("Falta uma chave de embeddings para o agente aprender o seu material")}
          </h3>
          <p className="text-xs text-text-muted">
            {t(
              "Preparar um documento para o agente encontrá-lo usa um provedor de embeddings. Escolha OpenAI ou Google Gemini (a chave é gratuita no Google AI Studio). Sem ela você consegue cadastrar o material, mas ele fica esperando — e o agente segue sem saber o que está nele.",
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setAbrindo(true)}
          data-testid="conhecimento-cadastrar-chave"
        >
          <KeyRound className="mr-2 h-3.5 w-3.5" aria-hidden />
          {t("Cadastrar a chave aqui")}
        </Button>
        <span className="text-xs text-text-muted">
          {t("ou veja todas em")}{" "}
          <Link
            href="/app/ai/credentials"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("IA › Credenciais")}
          </Link>
        </span>
      </div>
    </Card>
  );
}
