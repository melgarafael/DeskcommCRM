"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface RecoveryCodesPanelProps {
  codes: string[];
  onAcknowledge: () => void;
}

/**
 * Prefixo do arquivo baixado, derivado da marca da instalação.
 *
 * Este arquivo fica anos na pasta de downloads do usuário — é o artefato de marca
 * mais duradouro que o produto entrega. Com o nome fixo, o cliente do revendedor
 * baixa um arquivo com a NOSSA marca no nome, e não há atualização que conserte
 * isso depois: o arquivo já está no disco dele.
 *
 * O acento é removido antes de filtrar (senão "Ótima Gestão" perderia o "O"
 * inteiro em vez de virar "otima-gestao"), e uma marca sem nenhum caractere ASCII
 * — nome em outro alfabeto, ou só emoji — cai em "crm", porque `download=""`
 * faz o browser inventar um nome como "download.txt" e o usuário perde o arquivo
 * de vista.
 */
export function prefixoDoArquivo(nome: string): string {
  const slug = nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "crm";
}

/**
 * One-time display of recovery codes. User must check the acknowledgement
 * box before completing setup. Codes are shown in a 2x5 mono grid with copy
 * + download options.
 */
export function RecoveryCodesPanel({ codes, onAcknowledge }: RecoveryCodesPanelProps) {
  const t = useT();
  const [acked, setAcked] = useState(false);
  // A marca vem por PROP do servidor (`lib/branding/contexto.tsx`), não de
  // `branding()`: aquela função lê fontes diferentes no servidor e no navegador,
  // e a divergência é hydration mismatch. Aqui ela só alimenta o nome do arquivo
  // baixado, mas ler a fonte certa não é opcional por o efeito ser pequeno — é o
  // mesmo hook que o resto da casca usa, e uma exceção aqui seria a próxima
  // ocorrência a reabrir o defeito.
  const marca = useMarcaDaInstalacao();

  const handleCopy = async () => {
    const ok = await copyToClipboard(codes.join("\n"));
    if (ok) toast.success(t("Códigos copiados para a área de transferência."));
    else toast.error(t("Não foi possível copiar. Selecione e copie manualmente."));
  };

  const handleDownload = () => {
    const blob = new Blob([codes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${prefixoDoArquivo(marca.name)}-recovery-codes.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(t("Arquivo baixado."));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/40 p-4">
        <p className="mb-3 text-sm text-muted-foreground">
          {t("Salve esses 10 códigos em um local seguro. Cada um pode ser usado")}{" "}
          <strong>{t("uma única vez")}</strong> {t("para entrar caso você perca acesso ao autenticador.")}{" "}
          {t("Eles")} <strong>{t("não serão mostrados novamente")}</strong>.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {codes.map((c, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-background px-3 py-2 text-center font-mono text-sm tracking-widest"
            >
              {c}
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={handleCopy}>
          {t("Copiar todos")}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={handleDownload}>
          {t("Baixar .txt")}
        </Button>
      </div>

      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acked}
          onChange={(e) => setAcked(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded-md border-border"
        />
        <span>{t("Salvei meus códigos em local seguro.")}</span>
      </label>

      <Button
        type="button"
        className={cn("w-full")}
        disabled={!acked}
        onClick={onAcknowledge}
      >
        {t("Concluir")}
      </Button>
    </div>
  );
}
