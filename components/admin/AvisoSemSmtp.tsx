"use client";
import Link from "next/link";
import { Warning } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/**
 * O SINAL PERSISTENTE DE "SEM SMTP" NO PAINEL DO ADMIN (#2755, item 3).
 *
 * ─── Por que aqui, e não numa tela ──────────────────────────────────────────
 *
 * A pergunta do item 3 é "onde quem administra VÊ que a instalação não manda
 * e-mail". A resposta só pode ser um lugar por onde TODAS as telas passam: quem
 * está em /admin/tenants não vai abrir /admin/email só para conferir. Esse
 * denominador comum é o `AdminShell`, irmão do `PlatformModeBanner`, que já é
 * a tarja persistente do topo em todas as larguras (ver a medição no
 * `PlatformModeBanner.tsx`).
 *
 * ─── Por que `sticky`, e por que logo abaixo do banner de modo plataforma ───
 *
 * "Persistente" no pedido é o oposto de toast: o aviso tem de continuar ali
 * enquanto o operador resolve o resto. `sticky top-10` (2,5rem = os 40px da
 * tarja acima) o mantém visível na rolagem sem empilhar em cima do banner, que
 * já é `top-0 z-40`. Sem `backdrop-blur` (anti-pattern nº 5) e com os tokens de
 * `warning` — os mesmos do `Badge variant="warning"` —, que existem nos dois
 * temas com contraste aferido, como no `PlatformModeBanner`.
 *
 * ─── Quem decide exibir é o LAYOUT, não este componente ─────────────────────
 *
 * Este componente só desenha; quem lê o estado e passa `semSmtp` é
 * `app/admin/(protected)/layout.tsx` — a leitura não se
 * repete em cada tela nem em cada componente. Onde isso aparece MEDIDO:
 * `layout.tsx` já roda no servidor para todo `/admin/*` e já consulta o banco
 * para os módulos ligados; a leitura de SMTP entra no MESMO `Promise.all`.
 */
export function AvisoSemSmtp() {
  const t = useT();
  return (
    <div role="status" aria-label={t("Aviso: sem SMTP na instalação")} className="sticky top-10 z-30 w-full bg-bg">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/35 bg-warning-bg px-4 py-2 text-sm text-warning-fg">
        <span className="flex items-center gap-2">
          <Warning size={18} weight="fill" aria-hidden />
          <span className="font-semibold tracking-tight">{t("Sem SMTP configurado")}</span>
        </span>
        <span className="opacity-80">
          {t("Convites, recuperação de senha e avisos por e-mail não saem por SMTP até configurá-lo aqui.")}
        </span>
        <Link
          href="/admin/email"
          className="rounded-md px-2 py-1 font-medium underline underline-offset-2"
        >
          {t("Configurar em /admin/email")}
        </Link>
      </div>
    </div>
  );
}
