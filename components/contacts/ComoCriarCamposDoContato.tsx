"use client";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";

/** Onde os campos do contato se criam: a tela "Etapas do funil" (`lib/navigation/catalogo.ts`). */
export const TELA_DOS_CAMPOS_DO_CONTATO = "/app/settings/tenant/pipelines";

/**
 * A CAIXA "CAMPOS PERSONALIZADOS" QUANDO AINDA NÃO HÁ CAMPO (#4744).
 *
 * A ficha do contato só mostrava a caixa com campo já criado, e o lugar de criar
 * é o editor do FUNIL PADRÃO, atrás de "CRM › Ver tudo em CRM": com zero campos,
 * nada na tela dizia que existia esse lugar. Quem instalou chegou a perguntar se
 * o CRM só servia a quem tem os dados "batendo certinho com os campos".
 *
 * O que a frase precisa dizer, e por quê:
 *   • QUAL funil — o nome vem do banco. Só o padrão tem o seletor "Este campo
 *     pertence a:" (`PipelineEditor`, `ehFunilPadrao`); com vários funis, sem o
 *     nome a pessoa abre o errado e não acha o seletor.
 *   • escolher "Contato" — o campo novo nasce do NEGÓCIO. Sem trocar, ele vai
 *     para o card e a ficha continua vazia.
 *   • OUTRA ABA — esta caixa mora dentro de um formulário aberto; navegar na
 *     mesma aba apagaria em silêncio o que já foi digitado.
 *
 * A frase é montada em pedaços porque `t()` não interpola: cada pedaço tem a
 * sua linha no dicionário, e o espanhol mantém os espaços na mesma ordem.
 *
 * Quem decide QUANDO aparece é o diálogo (papel, funil lido, nenhum campo).
 */
export function ComoCriarCamposDoContato({ nomeDoFunil }: { nomeDoFunil: string }) {
  const t = useT();
  return (
    <div
      className="space-y-1 rounded-md border border-dashed border-border p-3"
      data-testid="como-criar-campos-do-contato"
    >
      <h3 className="text-sm font-medium">{t("Campos personalizados")}</h3>
      <p className="text-xs text-muted-foreground">
        {t("Você pode criar campos do contato na tela Etapas do funil: no funil")}{" "}
        <strong className="font-medium text-foreground">{nomeDoFunil}</strong>
        {t(
          ", clique em “Editar vocabulário e campos deste funil” e em “Adicionar campo”. Em “Este campo pertence a:”, troque para “Contato” e salve.",
        )}{" "}
        <Link
          href={TELA_DOS_CAMPOS_DO_CONTATO}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground underline underline-offset-2"
          data-testid="link-criar-campos-do-contato"
        >
          {t("Abrir Etapas do funil em outra aba")}
        </Link>
      </p>
    </div>
  );
}
