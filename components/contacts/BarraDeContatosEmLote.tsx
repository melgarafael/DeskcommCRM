"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";
import { Check, PencilSimple, Tag, Users, X } from "@/lib/ui/icons";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

interface Props {
  /** Quantos contatos estão marcados. Zero = a barra não existe. */
  quantidade: number;
  pendente: boolean;
  onAdicionarEtiqueta: (tag: string) => void;
  onRemoverEtiqueta: (tag: string) => void;
  /**
   * Ausente = o item "Mudar responsável" não aparece. A rota de carteira é
   * ≥manager (`requireRole("manager")`), mais alta que o piso da barra
   * (`contact.update`, agent): oferecê-lo a um agent era um controle que
   * devolve 403 em todo item.
   */
  onMudarResponsavel?: (donoUserId: string) => void;
  onPreencherCampo: (chave: string, valor: string) => void;
  onLimpar: () => void;
}

/**
 * A barra de ações do lote da tela de Contatos (#2484, fatia F3).
 *
 * Ela SÓ EXISTE com seleção: `quantidade === 0` devolve `null`. Uma barra
 * permanente ocuparia a linha estreita acima da tabela ensinando o olho a
 * ignorá-la — e é justamente a área onde moram as ações de risco.
 *
 * As ações são as três que têm caminho por CONTATO único: etiqueta (adicionar
 * / remover), responsável (carteira) e campo personalizado. "Mover card" e
 * "marcar sempre humano" ficaram fora por medição — a primeira é endereçada
 * por NEGÓCIO, a segunda só é gravada pelo motor de atendimento — e a barra
 * não promete o que a API não entrega.
 *
 * A organização NÃO passa por aqui: a rota de lote lê a org da sessão. Esta
 * barra só escolhe a ação e os ids já marcados.
 */
export function BarraDeContatosEmLote({
  quantidade,
  pendente,
  onAdicionarEtiqueta,
  onRemoverEtiqueta,
  onMudarResponsavel,
  onPreencherCampo,
  onLimpar,
}: Props) {
  const t = useT();
  /** Um diálogo só para as duas faces da etiqueta: `add` ou `remove`. */
  const [etiquetaAberta, setEtiquetaAberta] = useState<false | "add" | "remove">(false);
  const [tag, setTag] = useState("");
  const [responsavelAberto, setResponsavelAberto] = useState(false);
  const [destino, setDestino] = useState("");
  const [campoAberto, setCampoAberto] = useState(false);
  const [chave, setChave] = useState("");
  const [valor, setValor] = useState("");
  const membros = useAssignableMembers(responsavelAberto);
  const lista = membros.data ?? [];

  if (quantidade === 0) return null;

  const fecharEtiqueta = () => {
    setEtiquetaAberta(false);
    setTag("");
  };
  const confirmarEtiqueta = () => {
    const limpa = tag.trim();
    if (!limpa) return;
    if (etiquetaAberta === "add") onAdicionarEtiqueta(limpa);
    else if (etiquetaAberta === "remove") onRemoverEtiqueta(limpa);
    fecharEtiqueta();
  };
  const fecharResponsavel = () => {
    setResponsavelAberto(false);
    setDestino("");
  };
  const confirmarResponsavel = () => {
    if (!destino || !onMudarResponsavel) return;
    onMudarResponsavel(destino);
    fecharResponsavel();
  };
  const fecharCampo = () => {
    setCampoAberto(false);
    setChave("");
    setValor("");
  };
  const confirmarCampo = () => {
    if (!chave.trim()) return;
    onPreencherCampo(chave.trim(), valor);
    fecharCampo();
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-elevated px-3 py-2"
      role="toolbar"
      aria-label={t("Ações em lote")}
      data-testid="barra-de-contatos-em-lote"
    >
      <span className="mr-1 text-xs font-medium text-foreground">
        {quantidade === 1
          ? t("1 contato selecionado")
          : `${quantidade} ${t("contatos selecionados")}`}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={pendente} data-testid="lote-mais-acoes">
            {t("Mais ações")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("Ações em lote")}</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => setEtiquetaAberta("add")}
            data-testid="lote-adicionar-etiqueta"
          >
            <Tag size={14} className="mr-2" aria-hidden />
            {t("Adicionar etiqueta")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setEtiquetaAberta("remove")}
            data-testid="lote-remover-etiqueta"
          >
            <Tag size={14} className="mr-2" aria-hidden />
            {t("Remover etiqueta")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {onMudarResponsavel && (
            <DropdownMenuItem
              onSelect={() => setResponsavelAberto(true)}
              data-testid="lote-mudar-responsavel"
            >
              <Users size={14} className="mr-2" aria-hidden />
              {t("Mudar responsável")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => setCampoAberto(true)}
            data-testid="lote-preencher-campo"
          >
            <PencilSimple size={14} className="mr-2" aria-hidden />
            {t("Preencher campo personalizado")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="ghost"
        onClick={onLimpar}
        className="ml-auto"
        aria-label={t("Limpar seleção")}
        data-testid="lote-limpar"
      >
        <X size={14} aria-hidden />
      </Button>

      <Dialog
        open={etiquetaAberta !== false}
        onOpenChange={(v) => {
          if (!v) fecharEtiqueta();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {etiquetaAberta === "remove" ? t("Remover etiqueta") : t("Adicionar etiqueta")}
            </DialogTitle>
            <DialogDescription>
              {etiquetaAberta === "remove"
                ? t("A etiqueta sai dos contatos selecionados pelo mesmo caminho da edição individual, com auditoria por contato.")
                : t("A etiqueta entra nos contatos selecionados pelo mesmo caminho da edição individual, com auditoria por contato.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="lote-tag">{t("Etiqueta")}</Label>
            <Input
              id="lote-tag"
              value={tag}
              maxLength={40}
              onChange={(e) => setTag(e.target.value)}
              data-testid="lote-tag-input"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={fecharEtiqueta}>
              {t("Cancelar")}
            </Button>
            <Button
              onClick={confirmarEtiqueta}
              disabled={pendente || tag.trim().length === 0}
              data-testid="lote-tag-confirmar"
            >
              <Check size={14} className="mr-1.5" aria-hidden />
              {etiquetaAberta === "remove" ? t("Remover") : t("Adicionar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={responsavelAberto}
        onOpenChange={(v) => {
          if (!v) fecharResponsavel();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Mudar responsável")}</DialogTitle>
            <DialogDescription>
              {t("Cada contato é posto na carteira pelo mesmo caminho da ficha, e o dono é validado um a um.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="lote-responsavel">{t("Para quem")}</Label>
            <Select value={destino} onValueChange={setDestino}>
              <SelectTrigger id="lote-responsavel">
                <SelectValue placeholder={t("Escolha um atendente")} />
              </SelectTrigger>
              <SelectContent>
                {lista.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {rotuloDoMembro(m, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!membros.isLoading && lista.length === 0 && (
              <p className="text-xs text-text-subtle">{t("Nenhum atendente disponível.")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={fecharResponsavel}>
              {t("Cancelar")}
            </Button>
            <Button
              onClick={confirmarResponsavel}
              disabled={pendente || destino.length === 0}
              data-testid="lote-responsavel-confirmar"
            >
              <Check size={14} className="mr-1.5" aria-hidden />
              {t("Aplicar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={campoAberto}
        onOpenChange={(v) => {
          if (!v) fecharCampo();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Preencher campo personalizado")}</DialogTitle>
            <DialogDescription>
              {t("O campo é gravado no mesmo caminho da edição individual; os outros campos do contato permanecem.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="lote-campo-chave">{t("Campo")}</Label>
              <Input
                id="lote-campo-chave"
                value={chave}
                maxLength={80}
                onChange={(e) => setChave(e.target.value)}
                data-testid="lote-campo-chave"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lote-campo-valor">{t("Valor")}</Label>
              <Input
                id="lote-campo-valor"
                value={valor}
                maxLength={500}
                onChange={(e) => setValor(e.target.value)}
                data-testid="lote-campo-valor"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={fecharCampo}>
              {t("Cancelar")}
            </Button>
            <Button
              onClick={confirmarCampo}
              disabled={pendente || chave.trim().length === 0}
              data-testid="lote-campo-confirmar"
            >
              <Check size={14} className="mr-1.5" aria-hidden />
              {t("Aplicar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
