"use client";
import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { pt as ptBR } from "date-fns/locale";

import { Robot, Gear } from "@/lib/ui/icons";
import { autorNaTela, mudadoPorAgente } from "@/lib/operacao/autoria";
import { cn } from "@/lib/utils";

/**
 * Quem mexeu nesta configuração por último — ao lado do estado que ele mudou.
 *
 * ⚠️ EXISTE PORQUE O ESTADO SOZINHO PAROU DE RESPONDER A PERGUNTA CERTA. Enquanto
 * só uma pessoa `manager+` podia ligar uma regra automática, quem olhava a tela
 * era, por construção, quem tinha ligado. Com o assistente ligando regra que roda
 * sozinha, "Ativa" deixou de dizer o suficiente: falta **fui eu ou foi ele?**
 * (doutrina do sistema vivo, invariante 3 — o log existe no `api_audit_log` e
 * nenhuma tela de configuração o lê, então é log morto).
 *
 * ⚠️ SÓ FALA QUANDO NÃO FOI UMA PESSOA, e isso foi medido (ver
 * `lib/operacao/autoria.ts`): com o funil já usado, o selo de humano ocupava 7 de
 * 8 linhas e afogava a única que importava. Mudança feita por gente é confirmação
 * do que a própria pessoa acabou de fazer; repeti-la em toda linha destrói a
 * notícia que esta peça existe para dar.
 *
 * ⚠️ E O SELO LEVA A ALGUM LUGAR. A doutrina (invariante 5) exige que todo dado
 * na tela responda "por que estou vendo isto **e o que faço a seguir**". A
 * primeira versão respondia só a metade: dizia ao dono que o assistente mexeu e
 * o deixava sem saída — um susto sem caminho. Agora é um link para o histórico,
 * onde a mudança está registrada com o que foi alterado e quando.
 */
export function SeloDeAutoria({
  kind,
  em,
  className,
}: {
  kind: string | null;
  em: string | null;
  className?: string;
}) {
  const texto = autorNaTela(kind);
  if (!texto) return null;

  const doAgente = mudadoPorAgente(kind);
  const Icone = doAgente ? Robot : Gear;
  const quando = em
    ? ` ${formatDistanceToNowStrict(new Date(em), { addSuffix: true, locale: ptBR })}`
    : "";

  return (
    <Link
      href="/app/audit"
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-sm text-xs underline-offset-2 hover:underline",
        doAgente ? "font-medium text-accent" : "text-muted-foreground",
        className,
      )}
      data-autoria={kind ?? "desconhecida"}
      title="Ver no histórico o que foi alterado"
    >
      <Icone className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {texto}
        {quando} — ver o que mudou
      </span>
    </Link>
  );
}
