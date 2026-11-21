"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { codigoParaColar, linkDireto } from "@/lib/channels/webchat/codigo-para-colar";
import { useT } from "@/hooks/i18n/useT";

/**
 * Conectar o chat no site (spec 36, F2). Só aparece quando a instalação liga o módulo
 * `canal_webchat` (a aba nem é montada sem isso; ver `ConexoesShell`).
 *
 * Molde: `CanalBotClient`. Sem conexão, a tela pede só os domínios e cria a conexão. Com
 * conexão, mostra aparência, coleta, domínios, o código para colar e o giro da chave. A pausa
 * do chat entra numa tarefa própria.
 *
 * A chave pública não é segredo (está no código do site), mas não vai para log nem para
 * `console`. Textos de tela passam por `t()`.
 */

const ROTA = "/api/v1/channels/webchat";
const CORES_HEX = /^#[0-9a-fA-F]{6}$/;
/** Mesmo teto do servidor (`MAXIMO_DE_ORIGENS` em `lib/channels/webchat/config.ts`). */
const MAXIMO_DE_DOMINIOS = 20;

type ModoDeColeta = "oculto" | "opcional" | "obrigatorio";
type Campo = "nome" | "telefone" | "email";
const CAMPOS: Campo[] = ["nome", "telefone", "email"];

interface Config {
  titulo?: string;
  saudacao?: string;
  cor?: string;
  coleta?: Partial<Record<Campo, ModoDeColeta>>;
}

interface Estado {
  connected: boolean;
  id: string | null;
  display_name: string | null;
  status: string | null;
  public_key: string | null;
  allowed_origins: string[];
  config: Config;
}

const buscarEstado = async (): Promise<Estado> => (await apiClient.get<{ data: Estado }>(ROTA)).data;

/** Uma origem por linha, aparadas e sem linha vazia. A validação de verdade é do servidor. */
function linhasDeDominio(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter((linha) => linha !== "");
}

function coletaAtual(config: Config): Record<Campo, ModoDeColeta> {
  return {
    nome: config.coleta?.nome ?? "opcional",
    telefone: config.coleta?.telefone ?? "opcional",
    email: config.coleta?.email ?? "opcional",
  };
}

/** 422 do servidor mostra a mensagem dele; o resto vira aviso genérico, sem detalhe técnico. */
function avisoDeErro(e: unknown, t: (s: string) => string): string {
  if (e instanceof ApiError && e.status === 422 && !e.semEnvelope) {
    return t(e.message || "Confira os domínios e a configuração do chat.");
  }
  return t("Não foi possível salvar. Tente de novo.");
}

export function CanalChatClient() {
  const t = useT();
  const qc = useQueryClient();
  const { data: estado, isLoading, isError } = useQuery({
    queryKey: ["canal-chat"],
    queryFn: buscarEstado,
  });
  // fetchQuery devolve o estado novo: quem salvou usa esse dado para ressincronizar os campos.
  const carregar = () => qc.fetchQuery({ queryKey: ["canal-chat"], queryFn: buscarEstado });

  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="canal-chat">
        {t("Carregando…")}
      </p>
    );
  }
  if (isError || !estado) {
    return (
      <p role="alert" className="text-xs text-destructive" data-testid="canal-chat">
        {t("Não foi possível carregar o chat no site. Recarregue a página.")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="canal-chat">
      {estado.connected ? <ComConexao estado={estado} aoMudar={carregar} /> : <SemConexao aoAtivar={carregar} />}
    </div>
  );
}

function SemConexao({ aoAtivar }: { aoAtivar: () => Promise<unknown> }) {
  const t = useT();
  const [dominios, setDominios] = useState("");
  const [ocupado, setOcupado] = useState(false);
  // Acima do teto o servidor recusaria; o aviso sai antes, e o botão não envia.
  const acimaDoLimite = linhasDeDominio(dominios).length > MAXIMO_DE_DOMINIOS;

  const ativar = async () => {
    setOcupado(true);
    try {
      await apiClient.post(ROTA, { allowed_origins: linhasDeDominio(dominios) });
      toast.success(t("Chat no site ativado. Cole o código no seu site para ele aparecer."));
      await aoAtivar();
    } catch (e) {
      toast.error(avisoDeErro(e, t));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h3 className="text-sm font-semibold">{t("Chat no site")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Um quadro de conversa no canto do seu site. Quem visita manda uma mensagem e a conversa cai no Inbox, junto com o resto do atendimento.",
          )}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="canal-chat-dominios">{t("Domínios, um por linha")}</Label>
        <Textarea
          id="canal-chat-dominios"
          rows={4}
          value={dominios}
          onChange={(e) => setDominios(e.target.value)}
          placeholder="https://seusite.com.br"
        />
        <p className="text-xs text-muted-foreground">
          {t("Use o endereço completo com https, por exemplo https://seusite.com.br.")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("Sem domínios, o chat não abre no seu site. Ele só abre pelo link direto.")}
        </p>
      </div>

      {acimaDoLimite && (
        <p role="alert" className="text-xs text-destructive">
          {t("Use até 20 domínios.")}
        </p>
      )}
      <div>
        <Button onClick={ativar} disabled={ocupado || acimaDoLimite}>
          {ocupado ? t("Ativando…") : t("Ativar chat no site")}
        </Button>
      </div>
    </Card>
  );
}

function ComConexao({ estado, aoMudar }: { estado: Estado; aoMudar: () => Promise<Estado> }) {
  const t = useT();
  const [titulo, setTitulo] = useState("");
  const [saudacao, setSaudacao] = useState("");
  const [cor, setCor] = useState("");
  const [coleta, setColeta] = useState<Record<Campo, ModoDeColeta>>(() => coletaAtual(estado.config));
  const [dominios, setDominios] = useState(() => estado.allowed_origins.join("\n"));
  const [ocupado, setOcupado] = useState(false);
  const [girarAberto, setGirarAberto] = useState(false);

  // Aparência: campo em branco é "não mudar". Só vai o que foi preenchido.
  const corPreenchida = cor.trim() !== "";
  const corValida = !corPreenchida || CORES_HEX.test(cor.trim());
  const aparencia: Record<string, string> = {};
  if (titulo.trim()) aparencia.titulo = titulo.trim();
  if (saudacao.trim()) aparencia.saudacao = saudacao.trim();
  if (corPreenchida && corValida) aparencia.cor = cor.trim();
  const aparenciaMudou = Object.keys(aparencia).length > 0;

  // Coleta: o servidor troca o objeto `coleta` inteiro, então vai sempre com os três campos.
  const coletaMudou = CAMPOS.some((campo) => coleta[campo] !== coletaAtual(estado.config)[campo]);

  const listaDominios = linhasDeDominio(dominios);
  const dominiosMudaram = listaDominios.join("\n").toLowerCase() !== estado.allowed_origins.join("\n");
  const acimaDoLimite = listaDominios.length > MAXIMO_DE_DOMINIOS;

  // Depois de gravar, a conta é a do servidor (ele deduplica e põe em minúscula): o aoConcluir
  // recebe o estado refeito. Só o salvar mexe nos campos; enquanto o usuário digita, nada muda.
  const salvar = async (corpo: object, aoConcluir?: (atualizado: Estado) => void) => {
    setOcupado(true);
    try {
      await apiClient.patch(ROTA, corpo);
      toast.success(t("Alterações salvas."));
      const atualizado = await aoMudar();
      aoConcluir?.(atualizado);
    } catch (e) {
      toast.error(avisoDeErro(e, t));
    } finally {
      setOcupado(false);
    }
  };

  const girar = async () => {
    setOcupado(true);
    try {
      await apiClient.post(`${ROTA}/girar`, {});
      setGirarAberto(false);
      toast.success(t("Nova chave gerada. Cole o código novo no seu site."));
      await aoMudar();
    } catch {
      toast.error(t("Não foi possível gerar a chave. Tente de novo."));
    } finally {
      setOcupado(false);
    }
  };

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(t("Copiado."));
    } catch {
      toast.error(t("Não foi possível copiar. Selecione o texto e copie manualmente."));
    }
  };

  // A origem é a desta página: é o endereço do CRM que o cliente está usando.
  const origem = typeof window === "undefined" ? "" : window.location.origin;
  let codigo = "";
  let link = "";
  let codigoMontado = true;
  try {
    codigo = codigoParaColar(origem, estado.public_key ?? "");
    link = linkDireto(origem, estado.public_key ?? "");
  } catch {
    codigoMontado = false;
  }

  return (
    <Card className="flex flex-col gap-5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("Chat no site")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Um quadro de conversa no canto do seu site. Quem visita manda uma mensagem e a conversa cai no Inbox, junto com o resto do atendimento.",
            )}
          </p>
        </div>
        <Badge variant="secondary">{t("Conectado")}</Badge>
      </div>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("Aparência")}</h4>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-titulo">{t("Título")}</Label>
          <Input
            id="canal-chat-titulo"
            value={titulo}
            maxLength={60}
            placeholder={estado.config.titulo ?? ""}
            onChange={(e) => setTitulo(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-saudacao">{t("Saudação")}</Label>
          <Textarea
            id="canal-chat-saudacao"
            rows={3}
            maxLength={500}
            value={saudacao}
            placeholder={estado.config.saudacao ?? ""}
            onChange={(e) => setSaudacao(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-cor">{t("Cor")}</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={t("Escolher cor")}
              value={CORES_HEX.test(cor) ? cor : (estado.config.cor ?? "#000000")}
              onChange={(e) => setCor(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-1"
            />
            <Input
              id="canal-chat-cor"
              className="font-mono"
              value={cor}
              placeholder={estado.config.cor ?? "#rrggbb"}
              onChange={(e) => setCor(e.target.value)}
            />
          </div>
          {!corValida && (
            <p role="alert" className="text-xs text-destructive">
              {t("Use o formato #rrggbb, por exemplo #1d4ed8.")}
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("Deixe em branco o que não quer mudar.")}</p>
        <div>
          <Button
            onClick={() =>
              salvar({ config: aparencia }, () => {
                setTitulo("");
                setSaudacao("");
                setCor("");
              })
            }
            disabled={ocupado || !aparenciaMudou || !corValida}
          >
            {t("Salvar aparência")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("Coleta do visitante")}</h4>
        <p className="text-xs text-muted-foreground">{t("Dados que o chat pede antes da primeira mensagem.")}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <SeletorDeColeta
            id="canal-chat-coleta-nome"
            rotulo={t("Nome")}
            valor={coleta.nome}
            onChange={(modo) => setColeta({ ...coleta, nome: modo })}
          />
          <SeletorDeColeta
            id="canal-chat-coleta-telefone"
            rotulo={t("Telefone")}
            valor={coleta.telefone}
            onChange={(modo) => setColeta({ ...coleta, telefone: modo })}
          />
          <SeletorDeColeta
            id="canal-chat-coleta-email"
            rotulo={t("E-mail")}
            valor={coleta.email}
            onChange={(modo) => setColeta({ ...coleta, email: modo })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "Oculto: não pede. Opcional: pede, mas o visitante pode pular. Obrigatório: não deixa a conversa começar sem o dado.",
          )}
        </p>
        <div>
          <Button onClick={() => salvar({ config: { coleta } })} disabled={ocupado || !coletaMudou}>
            {t("Salvar coleta")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("Domínios permitidos")}</h4>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-dominios">{t("Domínios, um por linha")}</Label>
          <Textarea
            id="canal-chat-dominios"
            rows={4}
            value={dominios}
            placeholder="https://seusite.com.br"
            onChange={(e) => setDominios(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("Use o endereço completo com https, por exemplo https://seusite.com.br.")}
          </p>
          {listaDominios.length === 0 && (
            <p role="alert" className="text-xs text-destructive">
              {t("Sem domínios, o chat não abre no seu site. Ele só abre pelo link direto.")}
            </p>
          )}
          {acimaDoLimite && (
            <p role="alert" className="text-xs text-destructive">
              {t("Use até 20 domínios.")}
            </p>
          )}
        </div>
        <div>
          <Button
            onClick={() =>
              salvar({ allowed_origins: listaDominios }, (atualizado) =>
                setDominios(atualizado.allowed_origins.join("\n")),
              )
            }
            disabled={ocupado || !dominiosMudaram || acimaDoLimite}
          >
            {t("Salvar domínios")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("Instalar no site")}</h4>
        {codigoMontado ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="canal-chat-codigo">{t("Código para colar no site")}</Label>
              <Textarea id="canal-chat-codigo" rows={2} readOnly value={codigo} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">
                {t("Cole este código em todas as páginas do seu site. Ele coloca o botão do chat no canto da tela.")}
              </p>
              <div>
                <Button variant="outline" size="sm" onClick={() => copiar(codigo)}>
                  {t("Copiar código")}
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="canal-chat-link">{t("Link direto")}</Label>
              <Input id="canal-chat-link" readOnly value={link} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">
                {t("Abre a conversa numa página própria. Use quando não puder colar o código no site.")}
              </p>
              <div>
                <Button variant="outline" size="sm" onClick={() => copiar(link)}>
                  {t("Copiar link")}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <p role="alert" className="text-xs text-destructive">
            {t("Não foi possível montar o código para este endereço. Abra o CRM pelo endereço principal.")}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("Chave do chat")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("Gere uma chave nova só se achar que o código vazou.")}
        </p>
        <div>
          <Button variant="outline" onClick={() => setGirarAberto(true)} disabled={ocupado}>
            {t("Gerar nova chave")}
          </Button>
        </div>
      </section>

      <AlertDialog open={girarAberto} onOpenChange={setGirarAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Gerar nova chave?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Os sites que ainda têm o código antigo deixam de abrir conversas novas, até você colar o código novo neles. Quem já está conversando segue até a sessão expirar.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <Button onClick={girar} disabled={ocupado}>
              {ocupado ? t("Gerando…") : t("Sim, gerar nova chave")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function SeletorDeColeta({
  id,
  rotulo,
  valor,
  onChange,
}: {
  id: string;
  rotulo: string;
  valor: ModoDeColeta;
  onChange: (modo: ModoDeColeta) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{rotulo}</Label>
      <select
        id={id}
        value={valor}
        onChange={(e) => onChange(e.target.value as ModoDeColeta)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="oculto">{t("Oculto")}</option>
        <option value="opcional">{t("Opcional")}</option>
        <option value="obrigatorio">{t("Obrigatório")}</option>
      </select>
    </div>
  );
}
