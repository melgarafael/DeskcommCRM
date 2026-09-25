"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  salvarConfiguracaoDaInstalacao,
  voltarConfiguracaoAoPadrao,
} from "@/app/actions/admin/salvarConfiguracaoDaInstalacao";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { ChaveDaInstalacao } from "@/lib/instalacao/catalogo";
import type { EstadoParaTela } from "@/lib/instalacao/config";

/**
 * UM CAMPO DE CONFIGURAÇÃO DA INSTALAÇÃO — e o mesmo em toda tela que o mostre.
 *
 * Nasceu dentro de `/admin/configuracao`. Saiu de lá quando a chave do serviço
 * externo de e-mail se mudou para `/admin/email` (DEC-009, opção A): "como o meu
 * servidor manda e-mail" é um assunto só, e estava dividido em duas telas.
 *
 * ⚠️ O QUE ESTE ARQUIVO IMPEDE é a segunda cópia. Duas telas mostrando a mesma
 * linha do banco com dois formulários diferentes é como nasce a divergência que
 * ninguém percebe: uma delas ganha uma correção (o aviso de origem, o estado
 * depois de salvar, o botão de voltar ao padrão) e a outra fica para trás,
 * mostrando ao operador uma verdade que já mudou.
 *
 * A ação do servidor decide a autorização e resolve a chave pelo catálogo —
 * nunca pelo que a tela mandar. Ver `app/actions/admin/salvarConfiguracaoDaInstalacao.ts`.
 */
export interface LinhaDaInstalacao {
  readonly definicao: ChaveDaInstalacao;
  readonly estado: EstadoParaTela;
}

/**
 * De onde o valor em vigor veio. É a pergunta que o operador faz primeiro quando
 * algo não bate — "então de onde está saindo isso?" — e a tela responde sem que
 * ele precise abrir o servidor.
 */
export function Origem({
  fonte,
  idioma,
}: {
  fonte: "banco" | "ambiente" | "ausente";
  idioma: Idioma;
}) {
  const t = (s: string) => traduzir(s, idioma);
  if (fonte === "ausente") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
        {t("Não configurado")}
      </span>
    );
  }
  if (fonte === "banco") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
        {t("Definido aqui nesta tela")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted">
      <span aria-hidden className="size-1.5 rounded-full bg-neutral-400" />
      {t("Vem do arquivo de instalação do servidor")}
    </span>
  );
}

export function CampoEditavel({ linha, idioma }: { linha: LinhaDaInstalacao; idioma: Idioma }) {
  const t = (s: string) => traduzir(s, idioma);
  const [valor, setValor] = useState("");
  const [salvando, comecar] = useTransition();
  const { definicao } = linha;
  // O estado mostrado é LOCAL, inicializado pelo servidor e atualizado pelo
  // corpo da resposta de cada ação.
  //
  // ⚠️ E NÃO HÁ `router.refresh()` DENTRO DA TRANSIÇÃO — é isso que travava.
  // A primeira versão deste conserto aplicava `setEstado(r.estado)` e DEPOIS
  // chamava `router.refresh()` na mesma `startTransition`. O refresh é
  // atropelado pelos prefetches RSC da barra lateral e nunca completa; como
  // está DENTRO da transição, ela fica pendente para sempre — e o React retém o
  // `setEstado` junto até a transição inteira terminar. O retrato da falha no
  // CI mostrava o campo e o botão `[disabled]` (é o `isPending`), com o estado
  // velho na tela: a ação não falhou, ela nunca terminou. `revalidatePath` na
  // própria ação já cuida da coerência da próxima navegação; o refresh aqui não
  // acrescentava nada além da trava.
  const [estado, setEstado] = useState(linha.estado);

  function salvar() {
    comecar(async () => {
      const r = await salvarConfiguracaoDaInstalacao(definicao.chave, valor);
      if (r.ok) {
        setValor("");
        setEstado(r.estado);
        toast.success(t("Pronto, já está valendo."));
      } else {
        toast.error(r.erro);
      }
    });
  }

  function limpar() {
    comecar(async () => {
      const r = await voltarConfiguracaoAoPadrao(definicao.chave);
      if (r.ok) {
        setEstado(r.estado);
        toast.success(t("Voltou para o valor do arquivo de instalação."));
      } else {
        toast.error(r.erro);
      }
    });
  }

  const idCampo = `config-${definicao.chave}`;
  const idAjuda = `${idCampo}-ajuda`;

  return (
    <div className="space-y-2 border-t border-border/60 py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label htmlFor={idCampo} className="text-sm font-medium">
          {t(definicao.rotulo)}
        </Label>
        <Origem fonte={estado.fonte} idioma={idioma} />
      </div>

      <p id={idAjuda} className="text-sm text-text-muted">
        {t(definicao.explicacao)}
      </p>

      {estado.configurado && (
        <p className="text-xs text-text-muted">
          {definicao.natureza === "segredo"
            ? `${t("Guardado, terminando em")} ••••${estado.last4 ?? ""}`
            : `${t("Agora:")} ${estado.valorVisivel}`}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Input
          id={idCampo}
          aria-describedby={idAjuda}
          type={definicao.natureza === "segredo" ? "password" : "text"}
          autoComplete="off"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder={
            estado.configurado ? t("Escreva para substituir") : t("Escreva para configurar")
          }
          className="min-w-0 flex-1"
          disabled={salvando}
        />
        {/*
          ⚠️ IDENTIDADE POR CHAVE, e não "o primeiro Salvar da tela". Este campo
          passou a ser desenhado também em `/admin/email`, que JÁ tem um botão
          "Salvar" — o do servidor SMTP, e ele vem antes no DOM. Um teste (ou um
          leitor de tela) que procure por rótulo pega o vizinho: foi o que
          aconteceu, e o caso reprovou salvando a configuração errada.
        */}
        <Button
          data-testid={`salvar-${definicao.chave}`}
          onClick={salvar}
          disabled={salvando || valor.trim().length === 0}
        >
          {t("Salvar")}
        </Button>
        {estado.fonte === "banco" && (
          <Button
            data-testid={`voltar-${definicao.chave}`}
            variant="outline"
            onClick={limpar}
            disabled={salvando}
          >
            {t("Voltar ao padrão")}
          </Button>
        )}
      </div>
    </div>
  );
}
