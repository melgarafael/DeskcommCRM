"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  definirConteudoNaTelaBloqueada,
  type ErroTelaBloqueada,
} from "@/app/actions/settings/definirConteudoNaTelaBloqueada";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { CONTEUDOS_NA_TELA_BLOQUEADA, type ConteudoNaTelaBloqueada } from "@/lib/schemas/settings";

const OPCOES: Record<ConteudoNaTelaBloqueada, { titulo: string; explicacao: string }> = {
  oculto: {
    titulo: "Esconder tudo",
    explicacao: "O aviso diz só que chegou algo. Nem o nome do cliente nem a mensagem aparecem.",
  },
  nome: {
    titulo: "Mostrar quem mandou (recomendado)",
    explicacao: "Aparecem o nome e a foto do cliente, mas não o que ele escreveu.",
  },
  nome_e_previa: {
    titulo: "Mostrar quem mandou e a mensagem",
    explicacao: "Aparecem o nome, a foto e o começo da mensagem.",
  },
};

const ERROS: Record<ErroTelaBloqueada, string> = {
  invalido: "Opção inválida.",
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um administrador pode mudar essa regra.",
  mfa: "Confirme a verificação em duas etapas nesta sessão.",
  falha: "Não consegui salvar essa mudança agora.",
};

export function EscolhaDaTelaBloqueada({
  valorInicial,
  podeEditar,
}: {
  valorInicial: ConteudoNaTelaBloqueada;
  podeEditar: boolean;
}) {
  const t = useT();
  const [valor, setValor] = React.useState(valorInicial);
  const [salvando, startTransition] = React.useTransition();

  function escolher(novo: ConteudoNaTelaBloqueada) {
    const anterior = valor;
    setValor(novo);
    startTransition(async () => {
      const r = await definirConteudoNaTelaBloqueada(novo);
      if (r.ok) {
        toast.success(t("Salvo"));
      } else {
        setValor(anterior);
        toast.error(t(ERROS[r.erro]));
      }
    });
  }

  return (
    <Card className="p-4" data-testid="tela-bloqueada">
      <h2 className="text-base font-semibold">{t("O que os avisos mostram fora do app")}</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        {t(
          "Vale para o celular bloqueado e para as notificações do computador, para toda a empresa. Só administradores podem mudar.",
        )}
      </p>
      <fieldset className="space-y-3" disabled={!podeEditar || salvando}>
        <legend className="sr-only">{t("O que os avisos mostram fora do app")}</legend>
        {CONTEUDOS_NA_TELA_BLOQUEADA.map((opcao) => (
          <label key={opcao} className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="radio"
              name="tela-bloqueada"
              value={opcao}
              checked={valor === opcao}
              onChange={() => escolher(opcao)}
              className="mt-1"
              data-testid={`tela-bloqueada-${opcao}`}
            />
            <span>
              <span className="block font-medium">{t(OPCOES[opcao].titulo)}</span>
              <span className="block text-muted-foreground">{t(OPCOES[opcao].explicacao)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {!podeEditar ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("Quem decide é um administrador.")}</p>
      ) : null}
    </Card>
  );
}
