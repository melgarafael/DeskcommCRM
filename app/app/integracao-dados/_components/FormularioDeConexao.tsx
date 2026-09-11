"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  atualizarConexao,
  conexoesExternasQueryKey,
  criarConexao,
  type ConexaoExternaRow,
} from "@/hooks/external-db/useConexoesExternas";
import { useT } from "@/hooks/i18n/useT";

const MODOS_TLS = [
  { valor: "require", rotulo: "Obrigatório (padrão)" },
  { valor: "verify-full", rotulo: "Verificar certificado e host" },
  { valor: "verify-ca", rotulo: "Verificar certificado" },
  { valor: "prefer", rotulo: "Preferir TLS" },
  { valor: "disable", rotulo: "Sem TLS (rede local confiável)" },
] as const;

const schema = z.object({
  label: z.string().trim().min(1, "Obrigatório").max(80),
  host: z.string().trim().min(1, "Obrigatório").max(255),
  port: z.coerce.number().int().min(1, "Porta inválida").max(65535, "Porta inválida"),
  database_name: z.string().trim().min(1, "Obrigatório").max(128),
  username: z.string().trim().min(1, "Obrigatório").max(128),
  password: z.string().max(2048),
});

interface Props {
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
  /** Presente = editar; ausente = criar. */
  conexao?: ConexaoExternaRow | null;
}

/**
 * O componente é MONTADO a cada abertura (o pai o renderiza condicionalmente),
 * então os `useState` abaixo já nascem com os valores certos — sem `useEffect`
 * sincronizando estado, que causaria render em cascata e é o anti-padrão que o
 * lint do repo acusa.
 */
export function FormularioDeConexao({ open, onOpenChange, conexao }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const editando = Boolean(conexao);

  const [label, setLabel] = useState(conexao?.label ?? "");
  const [host, setHost] = useState(conexao?.host ?? "");
  const [port, setPort] = useState(String(conexao?.port ?? 5432));
  const [database, setDatabase] = useState(conexao?.database_name ?? "");
  const [username, setUsername] = useState(conexao?.username ?? "");
  // A senha nunca vem do servidor: ela não sai de lá. Em branco ao editar =
  // manter a guardada; vazia é recusada na criação.
  const [password, setPassword] = useState("");
  const [sslMode, setSslMode] = useState<string>(conexao?.ssl_mode ?? "require");
  const [enabled, setEnabled] = useState(conexao?.enabled ?? true);
  const [salvando, setSalvando] = useState(false);
  const [erros, setErros] = useState<Record<string, string | undefined>>({});

  async function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    setErros({});

    const parsed = schema.safeParse({ label, host, port, database_name: database, username, password });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErros({
        label: flat.label?.[0],
        host: flat.host?.[0],
        port: flat.port?.[0],
        database_name: flat.database_name?.[0],
        username: flat.username?.[0],
        password: flat.password?.[0],
      });
      return;
    }

    // Ao editar, senha em branco significa "manter a guardada"; ao criar, a
    // senha é obrigatória. A rota recusa o contrário — barrar aqui explica antes.
    if (!editando && parsed.data.password.length === 0) {
      setErros({ password: t("Informe a senha do banco.") });
      return;
    }

    setSalvando(true);
    try {
      if (editando && conexao) {
        await atualizarConexao(conexao.id, {
          label: parsed.data.label,
          host: parsed.data.host,
          port: parsed.data.port,
          database_name: parsed.data.database_name,
          username: parsed.data.username,
          ssl_mode: sslMode,
          enabled,
          ...(parsed.data.password ? { password: parsed.data.password } : {}),
        });
        toast.success(t("Conexão atualizada."));
      } else {
        await criarConexao({
          label: parsed.data.label,
          host: parsed.data.host,
          port: parsed.data.port,
          database_name: parsed.data.database_name,
          username: parsed.data.username,
          password: parsed.data.password,
          ssl_mode: sslMode,
          enabled,
        });
        toast.success(t("Conexão criada. Use Testar para conferir o acesso."));
      }
      await qc.invalidateQueries({ queryKey: conexoesExternasQueryKey });
      onOpenChange(false);
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editando ? t("Editar conexão") : t("Conectar banco de dados")}</DialogTitle>
          <DialogDescription>
            {t(
              "A senha é cifrada antes de gravar e nunca é mostrada de volta. A conexão é somente leitura e só aceita TLS por padrão.",
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={salvar} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ext-label">{t("Nome da conexão")}</Label>
            <Input
              id="ext-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("Ex: CRM de assinaturas")}
              maxLength={80}
            />
            {erros.label && <p className="text-xs text-destructive">{erros.label}</p>}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="ext-host">{t("Host")}</Label>
              <Input
                id="ext-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="db.exemplo.com"
              />
              {erros.host && <p className="text-xs text-destructive">{erros.host}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ext-port">{t("Porta")}</Label>
              <Input
                id="ext-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
              {erros.port && <p className="text-xs text-destructive">{erros.port}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ext-database">{t("Banco de dados")}</Label>
            <Input
              id="ext-database"
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              placeholder="outro_crm"
            />
            {erros.database_name && (
              <p className="text-xs text-destructive">{erros.database_name}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ext-user">{t("Usuário")}</Label>
              <Input
                id="ext-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
              {erros.username && <p className="text-xs text-destructive">{erros.username}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ext-password">{t("Senha")}</Label>
              <Input
                id="ext-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder={editando ? t("Guardada — preencha só para trocar") : undefined}
              />
              {erros.password && <p className="text-xs text-destructive">{erros.password}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ext-ssl">{t("Segurança da conexão (TLS)")}</Label>
            <Select value={sslMode} onValueChange={setSslMode}>
              <SelectTrigger id="ext-ssl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODOS_TLS.map((m) => (
                  <SelectItem key={m.valor} value={m.valor}>
                    {t(m.rotulo)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="ext-enabled">{t("Conexão ativa")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("Desative para o agente parar de usar esta fonte sem apagar o cadastro.")}
              </p>
            </div>
            <Switch id="ext-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={salvando}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={salvando}>
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
