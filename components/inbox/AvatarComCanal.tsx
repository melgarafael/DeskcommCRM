"use client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { channelBrand } from "@/lib/channels/presentation";
import type { ChannelSummary } from "@/hooks/inbox/useConversationsRealtime";
import { cn } from "@/lib/utils";

/** A cor da bolinha por canal (redesign kvgroup, seção 5.5). */
const COR_DO_CANAL: Record<ReturnType<typeof channelBrand>, string> = {
  whatsapp: "bg-[var(--kv-whatsapp)]",
  instagram: "bg-[var(--kv-instagram)]",
  messenger: "bg-[#0866ff]",
  unknown: "bg-text-subtle",
};

const NOME_DO_CANAL: Record<ReturnType<typeof channelBrand>, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  unknown: "Canal",
};

export function iniciaisDoNome(nome: string | null | undefined, reserva: string): string {
  const v = (nome ?? "").trim();
  if (!v) return reserva.slice(0, 2).toUpperCase();
  const partes = v.split(/\s+/).filter(Boolean);
  if (partes.length === 1) return (partes[0] ?? "").slice(0, 2).toUpperCase();
  return ((partes[0]?.[0] ?? "") + (partes[partes.length - 1]?.[0] ?? "")).toUpperCase();
}

/**
 * Avatar do contato com a bolinha do canal no canto inferior direito. O número
 * do canal (o "Entrou por …") vai no `title` da bolinha — saiu da linha do item.
 */
export function AvatarComCanal({
  contato,
  nome,
  reserva,
  canal,
  rotuloDoCanal,
  tamanho = 36,
  className,
}: {
  contato: { id: string; avatar_storage_path?: string | null; is_anonymized?: boolean | null } | null;
  nome: string;
  reserva: string;
  canal: ChannelSummary | null | undefined;
  rotuloDoCanal?: string | null;
  tamanho?: number;
  className?: string;
}) {
  const marca = channelBrand(canal);
  const titulo = rotuloDoCanal ? `${NOME_DO_CANAL[marca]} · ${rotuloDoCanal}` : NOME_DO_CANAL[marca];
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: tamanho, height: tamanho }}>
      <Avatar className="h-full w-full">
        {/* Só monta a <img> quando existe arquivo: sem isso o navegador pediria
            a rota para TODO contato e levaria 404 em cada um sem foto. */}
        {contato?.avatar_storage_path && !contato.is_anonymized ? (
          <AvatarImage src={`/api/v1/contacts/${contato.id}/avatar`} alt="" className="object-cover" />
        ) : null}
        <AvatarFallback className="bg-[var(--kv-surface-2)] text-xs font-medium text-text-muted">
          {iniciaisDoNome(nome, reserva)}
        </AvatarFallback>
      </Avatar>
      <span
        role="img"
        aria-label={titulo}
        title={titulo}
        className={cn(
          "absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-[var(--color-bg)]",
          COR_DO_CANAL[marca],
        )}
      />
    </span>
  );
}
