"use client";
/**
 * "EXPORTAR CONVERSA" — o botão que faltava para a rota do #1982.
 *
 * ─── O que já existia, e o que faltava ──────────────────────────────────────
 *
 * `GET /api/v1/conversations/[id]/export?formato=pdf` e
 * `lib/conversas/exporta-pdf.ts` estavam prontos e testados: papel mínimo
 * `agent`, teto por pessoa e por organização, 404 para conversa que a RLS não
 * deixa ver, e o `Content-Disposition` com o nome do arquivo. O que não existia
 * era a PORTA — o operador não tinha de onde clicar, e o CHANGELOG declarava
 * exatamente isso. Este componente é a porta, e só ela: nenhuma linha da rota
 * nem do PDF muda por causa dele.
 *
 * ─── Por que `fetch` cru, e não o `apiClient` ───────────────────────────────
 *
 * A resposta NÃO é JSON: é o arquivo. O `apiClient` faz o parse do envelope e
 * lança em não-2xx — os dois comportamentos certos para a API e errados aqui.
 * O `same-origin` das credenciais é o que leva o cookie da sessão, sem o qual a
 * rota responderia 401. É o mesmo desenho de `verPrevia` em
 * `app/app/proposals/[id]/_client.tsx`.
 *
 * ─── O 403 é traduzido AQUI, e de propósito ─────────────────────────────────
 *
 * A rota devolve a recusa no envelope de erro do produto (`error.message`), já
 * traduzida pelo idioma do usuário. Para 403 a frase dela fala do RECURSO
 * ("conversations"); o operador precisa da frase do GESTO ("exportar esta
 * conversa"). Por isso o 403 tem chave própria no dicionário, e os outros
 * códigos aproveitam a mensagem da rota (404, 429) — que já vem no idioma de
 * quem clicou, e cuja régua mora num lugar só.
 *
 * ─── O botão existe DESABILITADO para quem não pode ─────────────────────────
 *
 * `requireRole("agent")` é o gate da rota. `viewer` lê a conversa na Inbox;
 * baixar o histórico inteiro é outro gesto, e a tela não oferece o que a rota
 * recusa com um clique que terminaria em erro — mas também não esconde o
 * recurso, que é o que faz a pessoa achar que ele não existe. Desabilitado +
 * `title` dizendo o porquê é a mesma régua de `podeReservar` no cabeçalho.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { DownloadSimple } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/** A rota, num lugar só: o teste e o componente não podem divergir de string. */
export function rotaDaExportacao(conversationId: string): string {
  return `/api/v1/conversations/${conversationId}/export?formato=pdf`;
}

/**
 * Quem pode exportar — espelho EXATO de `requireRole("agent")` na rota.
 *
 * `is_platform_admin` sem `support` entra: é o mesmo atalho de
 * `podeMarcarPessoal`/`podeReservar` no cabeçalho, e a rota o aceita pela
 * régua de `requireRole`. Exportada para ser medida sem montar o componente.
 */
export function podeExportarConversa(papel: Role | undefined, plataformaAdmin = false): boolean {
  if (plataformaAdmin) return true;
  return papel != null && ROLE_RANK[papel] >= ROLE_RANK.agent;
}

/** O nome que a rota mandou no `Content-Disposition`; sem ele, um nome honesto. */
function nomeDoArquivo(res: Response, conversationId: string): string {
  const cabecalho = res.headers.get("Content-Disposition") ?? "";
  const achado = /filename="([^"]+)"/.exec(cabecalho);
  return achado?.[1] ?? `conversa-${conversationId}.pdf`;
}

/**
 * Da resposta ao arquivo no disco do operador.
 *
 * O `<a download>` sintético é o caminho que não abre aba nem perde o gesto do
 * clique; a URL do blob é revogada depois (uma exportação por clique, mas um
 * operador que exporte dez conversas deixaria dez buffers presos sem isto).
 */
function baixar(blob: Blob, nome: string): void {
  const url = URL.createObjectURL(blob);
  const ancora = document.createElement("a");
  ancora.href = url;
  ancora.download = nome;
  document.body.appendChild(ancora);
  ancora.click();
  ancora.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type Estado = "parado" | "gerando";

interface Props {
  conversationId: string;
  /**
   * `menu` desenha um item do ⋯ em vez de um botão de barra. Os dois têm o mesmo
   * comportamento e o mesmo estado — o que muda é onde caem (o cabeçalho já
   * decidiu que as ações secundárias moram no menu, #3003).
   */
  como?: "barra" | "menu";
}

export function ExportarConversa({ conversationId, como = "barra" }: Props) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const [estado, setEstado] = useState<Estado>("parado");
  const [erro, setErro] = useState<string | null>(null);

  const pode =
    podeExportarConversa(activeOrg?.role, user.is_platform_admin === true && !user.support);
  const gerando = estado === "gerando";
  const rotulo = gerando ? t("Gerando PDF…") : t("Exportar conversa");
  const guia = pode
    ? t("Baixa o histórico desta conversa em PDF, para guardar ou anexar ao caso.")
    : t("Seu perfil não permite exportar o histórico desta conversa.");

  async function exportar() {
    if (!pode || gerando) return;
    setEstado("gerando");
    setErro(null);
    try {
      const res = await fetch(rotaDaExportacao(conversationId), { credentials: "same-origin" });
      if (res.ok) {
        baixar(await res.blob(), nomeDoArquivo(res, conversationId));
        return;
      }
      // O corpo da recusa é o mesmo envelope de erro das outras rotas; quando
      // não é JSON (proxy no meio, 502 sem corpo), sobra a frase genérica.
      const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (res.status === 403) {
        setErro(t("Seu perfil não permite exportar o histórico desta conversa."));
        return;
      }
      setErro(corpo?.error?.message ?? t("Não foi possível exportar a conversa agora."));
    } catch {
      setErro(t("Não foi possível exportar a conversa agora."));
    } finally {
      setEstado("parado");
    }
  }

  const conteudo = (
    <>
      <DownloadSimple size={16} aria-hidden className={como === "menu" ? "mr-2" : undefined} />
      {rotulo}
    </>
  );

  return (
    <>
      {como === "menu" ? (
        <DropdownMenuItem
          data-testid="acao-exportar-conversa"
          disabled={!pode || gerando}
          title={guia}
          // `preventDefault` mantém o menu aberto: o erro tem de ser lido onde o
          // clique começou, e um menu que fecha no clique esconderia a frase.
          onSelect={(e) => {
            e.preventDefault();
            void exportar();
          }}
        >
          {conteudo}
        </DropdownMenuItem>
      ) : (
        <Button
          size="sm"
          variant="outline"
          data-testid="acao-exportar-conversa"
          disabled={!pode || gerando}
          title={guia}
          aria-busy={gerando}
          onClick={() => void exportar()}
        >
          {conteudo}
        </Button>
      )}
      {erro !== null && (
        <p
          role="alert"
          data-testid="erro-ao-exportar"
          className={cn("px-2 py-1 text-xs text-destructive", como === "barra" && "basis-full")}
        >
          {erro}
        </p>
      )}
    </>
  );
}
