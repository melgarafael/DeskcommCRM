"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useCadencias } from "@/hooks/cadencias/useCadencias";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { todosOsPassos } from "@/lib/cadencias/arvore";
import type { Cadencia, StatusDaCadencia } from "@/lib/cadencias/tipos";
import { EnvelopeSimple, GitBranch, Info, Plus, Trash, WhatsappLogo } from "@/lib/ui/icons";

const VARIANTE: Record<StatusDaCadencia, "success" | "warning" | "neutral"> = {
  ativa: "success",
  pausada: "warning",
  rascunho: "neutral",
};
const ROTULO: Record<StatusDaCadencia, string> = {
  ativa: "Ativa",
  pausada: "Pausada",
  rascunho: "Rascunho",
};

export function ListaDeCadencias() {
  const t = useT();
  const idioma = useTagDeIdioma();
  const router = useRouter();
  const { lista, criar, excluir, carregando } = useCadencias();
  const [novaAberta, setNovaAberta] = useState(false);
  const [paraExcluir, setParaExcluir] = useState<Cadencia | null>(null);

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Cadências")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Sequências de e-mail por segmento: o lead entra pela tag, recebe os e-mails no ritmo certo e sai sozinho quando responde.")}
          </p>
        </div>
        <Button onClick={() => setNovaAberta(true)} data-testid="nova-cadencia">
          <Plus size={14} aria-hidden className="mr-2" /> {t("Nova cadência")}
        </Button>
      </header>

      <div className="flex gap-2 rounded-md border border-info/30 bg-info-bg p-3 text-xs text-info-fg">
        <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>
          {t("A cadência já fica salva no CRM. O envio de e-mail ainda não está ligado — os leads inscritos esperam na fila.")}
        </span>
      </div>

      {carregando ? (
        <Skeleton className="h-40" />
      ) : lista.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-10 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <EnvelopeSimple size={24} aria-hidden />
          </span>
          <p className="font-medium">{t("Nenhuma cadência ainda")}</p>
          <p className="max-w-md text-sm text-text-muted">
            {t("Crie uma cadência para cada segmento que você prospecta — por exemplo, papel e celulose.")}
          </p>
          <Button className="mt-2" onClick={() => setNovaAberta(true)}>
            <Plus size={14} aria-hidden className="mr-2" /> {t("Nova cadência")}
          </Button>
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {lista.map((c) => {
            const passos = todosOsPassos(c.passos);
            const emails = passos.filter((p) => p.tipo === "email").length;
            const ramos = passos.filter((p) => p.tipo === "ramo").length;
            const wpp = passos.filter((p) => p.tipo === "whatsapp").length;
            return (
              <div
                key={c.id}
                className="flex flex-col gap-2 p-4 transition-colors hover:bg-surface-elevated sm:flex-row sm:items-center sm:justify-between"
              >
                <Link href={`/app/cadencias/${c.id}`} className="min-w-0 flex-1">
                  <p className="truncate font-medium">{c.nome}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    {c.configuracao.tagDoSegmento ? (
                      <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-xs text-accent">
                        {c.configuracao.tagDoSegmento}
                      </span>
                    ) : (
                      <span className="text-xs text-warning-fg">{t("Sem tag de segmento")}</span>
                    )}
                    <span className="flex items-center gap-1">
                      <EnvelopeSimple size={14} aria-hidden /> {emails} {t(emails === 1 ? "e-mail" : "e-mails")}
                    </span>
                    {ramos > 0 && (
                      <span className="flex items-center gap-1">
                        <GitBranch size={14} aria-hidden /> {ramos} {t(ramos === 1 ? "ramificação" : "ramificações")}
                      </span>
                    )}
                    {wpp > 0 && (
                      <span className="flex items-center gap-1">
                        <WhatsappLogo size={14} aria-hidden /> {wpp} WhatsApp
                      </span>
                    )}
                  </p>
                </Link>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    {t("Editada em")}{" "}
                    {new Date(c.atualizadaEm).toLocaleDateString(idioma, { day: "2-digit", month: "2-digit" })}
                  </span>
                  <Badge variant={VARIANTE[c.status]}>{t(ROTULO[c.status])}</Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("Excluir cadência")}
                    onClick={() => setParaExcluir(c)}
                  >
                    <Trash size={16} aria-hidden />
                  </Button>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <NovaCadenciaDialog
        aberto={novaAberta}
        onFechar={() => setNovaAberta(false)}
        onCriar={async (nome, tag) => {
          try {
            const nova = await criar(nome, tag);
            router.push(`/app/cadencias/${nova.id}`);
          } catch (erro) {
            toast.error(erro instanceof Error ? erro.message : t("Não foi possível criar a cadência."));
          }
        }}
      />

      <AlertDialog open={paraExcluir !== null} onOpenChange={(o) => !o && setParaExcluir(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Excluir esta cadência?")}</AlertDialogTitle>
            <AlertDialogDescription>{paraExcluir?.nome}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (paraExcluir) {
                  try {
                    await excluir(paraExcluir.id);
                  } catch (erro) {
                    toast.error(erro instanceof Error ? erro.message : t("Não foi possível excluir a cadência."));
                  }
                }
                setParaExcluir(null);
              }}
            >
              {t("Excluir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NovaCadenciaDialog({
  aberto,
  onFechar,
  onCriar,
}: {
  aberto: boolean;
  onFechar: () => void;
  onCriar: (nome: string, tag: string) => void;
}) {
  const t = useT();
  const [nome, setNome] = useState("");
  const [tag, setTag] = useState("");
  const tagFormatada = tag
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onFechar()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!nome.trim()) return;
            onCriar(nome.trim(), tagFormatada);
            setNome("");
            setTag("");
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{t("Nova cadência")}</DialogTitle>
            <DialogDescription>
              {t("Dê um nome e diga qual segmento ela atende. Os passos você monta em seguida.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="nome-nova">{t("Nome")}</Label>
            <Input
              id="nome-nova"
              autoFocus
              value={nome}
              placeholder={t("Ex.: Papel e celulose — primeira abordagem")}
              onChange={(e) => setNome(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tag-nova">{t("Segmento (tag)")}</Label>
            <Input
              id="tag-nova"
              value={tag}
              placeholder={t("Ex.: Papel e celulose")}
              onChange={(e) => setTag(e.target.value)}
            />
            {tagFormatada && (
              <p className="text-xs text-text-muted">
                {t("Tag:")}{" "}
                <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-accent">{tagFormatada}</span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onFechar}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={!nome.trim()} data-testid="criar-cadencia">
              {t("Criar e montar os passos")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
