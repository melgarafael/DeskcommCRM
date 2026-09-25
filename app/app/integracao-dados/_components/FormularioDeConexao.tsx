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
import { LIMITE_FILTROS, LIMITE_LINHAS, LIMITE_RESPOSTA_BYTES } from "@/lib/external-db/limites";

const MODOS_TLS = [
  { valor: "require", rotulo: "Obrigatório (padrão)" },
  { valor: "verify-full", rotulo: "Verificar certificado e host" },
  { valor: "verify-ca", rotulo: "Verificar certificado" },
  { valor: "prefer", rotulo: "Preferir TLS" },
  { valor: "disable", rotulo: "Sem TLS (rede local confiável)" },
] as const;

/** O tamanho da resposta é gravado em bytes, mas a tela fala em KB. */
const KB = 1024;
const KB_MIN = Math.ceil(LIMITE_RESPOSTA_BYTES.minimo / KB);
const KB_MAX = Math.floor(LIMITE_RESPOSTA_BYTES.maximo / KB);

const schema = z.object({
  label: z.string().trim().min(1, "Obrigatório").max(80),
  host: z.string().trim().min(1, "Obrigatório").max(255),
  port: z.coerce.number().int().min(1, "Porta inválida").max(65535, "Porta inválida"),
  database_name: z.string().trim().min(1, "Obrigatório").max(128),
  username: z.string().trim().min(1, "Obrigatório").max(128),
  password: z.string().max(2048),
  max_rows: z.coerce
    .number()
    .int()
    .min(LIMITE_LINHAS.minimo, "Fora do limite permitido")
    .max(LIMITE_LINHAS.maximo, "Fora do limite permitido"),
  max_filters: z.coerce
    .number()
    .int()
    .min(LIMITE_FILTROS.minimo, "Fora do limite permitido")
    .max(LIMITE_FILTROS.maximo, "Fora do limite permitido"),
  max_response_kb: z.coerce
    .number()
    .int()
    .min(KB_MIN, "Fora do limite permitido")
    .max(KB_MAX, "Fora do limite permitido"),
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
  const [maxRows, setMaxRows] = useState(String(conexao?.max_rows ?? LIMITE_LINHAS.padrao));
  const [maxFilters, setMaxFilters] = useState(String(conexao?.max_filters ?? LIMITE_FILTROS.padrao));
  const [maxResponseKb, setMaxResponseKb] = useState(
    String(Math.round((conexao?.max_response_bytes ?? LIMITE_RESPOSTA_BYTES.padrao) / KB)),
  );
  const [salvando, setSalvando] = useState(false);
  const [erros, setErros] = useState<Record<string, string | undefined>>({});

  async function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    setErros({});

    const parsed = schema.safeParse({
      label,
      host,
      port,
      database_name: database,
      username,
      password,
      max_rows: maxRows,
      max_filters: maxFilters,
      max_response_kb: maxResponseKb,
    });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErros({
        label: flat.label?.[0],
        host: flat.host?.[0],
        port: flat.port?.[0],
        database_name: flat.database_name?.[0],
        username: flat.username?.[0],
        password: flat.password?.[0],
        max_rows: flat.max_rows?.[0],
        max_filters: flat.max_filters?.[0],
        max_response_kb: flat.max_response_kb?.[0],
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
          max_rows: parsed.data.max_rows,
          max_filters: parsed.data.max_filters,
          max_response_bytes: parsed.data.max_response_kb * KB,
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
          max_rows: parsed.data.max_rows,
          max_filters: parsed.data.max_filters,
          max_response_bytes: parsed.data.max_response_kb * KB,
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
                // `meusistema.com` e não `db.exemplo.com`: a catraca de host de
                // terceiro (tests/unit/branding.test.ts) tem a categoria AMOSTRA
                // fechada, e este domínio já está declarado lá — é a MESMA amostra
                // do campo de webhook. Ensinar o formato não precisa de host novo.
                placeholder="meusistema.com"
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

          <fieldset className="space-y-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">{t("Limites de leitura")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("Quanto o assistente e a grade podem ler desta fonte. Aumente se o seu processo precisar.")}
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ext-max-rows">{t("Linhas por consulta")}</Label>
                <Input
                  id="ext-max-rows"
                  value={maxRows}
                  onChange={(e) => setMaxRows(e.target.value)}
                  inputMode="numeric"
                />
                <p className="text-[11px] text-muted-foreground">
                  {LIMITE_LINHAS.minimo}–{LIMITE_LINHAS.maximo}
                </p>
                {erros.max_rows && <p className="text-xs text-destructive">{erros.max_rows}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="ext-max-filters">{t("Filtros por consulta")}</Label>
                <Input
                  id="ext-max-filters"
                  value={maxFilters}
                  onChange={(e) => setMaxFilters(e.target.value)}
                  inputMode="numeric"
                />
                <p className="text-[11px] text-muted-foreground">
                  {LIMITE_FILTROS.minimo}–{LIMITE_FILTROS.maximo}
                </p>
                {erros.max_filters && <p className="text-xs text-destructive">{erros.max_filters}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="ext-max-response">{t("Resposta para a IA (KB)")}</Label>
                <Input
                  id="ext-max-response"
                  value={maxResponseKb}
                  onChange={(e) => setMaxResponseKb(e.target.value)}
                  inputMode="numeric"
                />
                <p className="text-[11px] text-muted-foreground">
                  {KB_MIN}–{KB_MAX}
                </p>
                {erros.max_response_kb && (
                  <p className="text-xs text-destructive">{erros.max_response_kb}</p>
                )}
              </div>
            </div>
          </fieldset>

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
