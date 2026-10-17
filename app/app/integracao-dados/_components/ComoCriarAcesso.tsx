"use client";

import { useT } from "@/hooks/i18n/useT";
import { Info } from "@/lib/ui/icons";
import { SQL_MYSQL_CRIAR_E_LIBERAR_VIEW, SQL_MYSQL_CRIAR_USUARIO } from "@/lib/external-db/guia-de-acesso";

/**
 * Guia rápido, em linguagem de quem NÃO programa, dentro da janela de conexão: a
 * explicação precisa estar onde a função é usada (padrão do ComoUsar). Só MySQL —
 * os comandos foram medidos num MySQL 8; para PostgreSQL não há comando medido e
 * o guia não aparece.
 */
export function ComoCriarAcesso({ motor }: { motor: "postgres" | "mysql" }) {
  const t = useT();
  if (motor !== "mysql") return null;

  return (
    <details className="group rounded-md border border-border bg-surface p-4" data-testid="como-criar-acesso">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <Info size={16} aria-hidden className="text-accent" />
        {t("Como criar um acesso só de leitura (guia rápido)")}
      </summary>
      <div className="mt-3 space-y-3 text-sm text-text-muted">
        <p>
          {t(
            "Quem administra o banco de dados do cliente executa estes comandos nele. O CRM só precisa de um acesso que leia o que você quiser mostrar ao assistente, e nada além disso.",
          )}
        </p>
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            <p>{t("Crie um usuário novo. Troque a senha por uma forte, que você não use em nenhum outro lugar.")}</p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface p-3 text-xs text-text select-all">
              {SQL_MYSQL_CRIAR_USUARIO}
            </pre>
            <p className="mt-1 text-xs">
              {t("Se você souber o endereço (IP) do servidor do CRM, troque o % por ele: assim só esse servidor consegue entrar.")}
            </p>
          </li>
          <li>
            <p>
              {t(
                "Crie uma view (uma tabela virtual) só com as colunas que o assistente pode ver, e libere somente ela. Troque os nomes em MAIÚSCULAS pelos do seu banco.",
              )}
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface p-3 text-xs text-text select-all">
              {SQL_MYSQL_CRIAR_E_LIBERAR_VIEW}
            </pre>
            <p className="mt-1 text-xs">
              {t("Não libere o banco inteiro: é assim que tabelas como a de senhas ficam de fora.")}
            </p>
          </li>
          <li>
            <p>
              {t(
                "Volte aqui, conecte com esse usuário, clique em Testar e, na conexão criada, marque a view em «O que o assistente pode ver».",
              )}
            </p>
          </li>
        </ol>
      </div>
    </details>
  );
}
