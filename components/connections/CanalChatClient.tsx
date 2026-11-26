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
import { copyToClipboard } from "@/lib/clipboard";
import { codigoParaColar, linkDireto } from "@/lib/channels/webchat/codigo-para-colar";
import { TETO_ANONIMO_MAXIMO, TETO_ANONIMO_PADRAO } from "@/lib/channels/teto-do-anonimo";
import { useT } from "@/hooks/i18n/useT";

/**
 * Conectar o chat no site (spec 36, F2). Só aparece quando a instalação liga o módulo
 * `canal_webchat` (a aba nem é montada sem isso; ver `ConexoesShell`).
 *
 * Molde: `CanalBotClient`. Sem conexão, a tela pede só os domínios e cria a conexão. Com
 * conexão, mostra aparência, coleta, domínios, o código para colar, a pausa e o giro da chave.
 * A pausa é `config.pausado` (não é o status da conexão): pausado, a janela não abre no site.
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
type FormatoDoChat = "bolha" | "painel" | "embutido" | "pagina";
type PosicaoDoChat = "direita" | "esquerda";

interface Config {
  titulo?: string;
  saudacao?: string;
  cor?: string;
  coleta?: Partial<Record<Campo, ModoDeColeta>>;
  /** Chat pausado pela organização (`metadata.webchat.pausado`). */
  pausado?: boolean;
  /** Formato da janela do chat (`metadata.webchat.formato`). */
  formato?: FormatoDoChat;
  /** Posição da janela do chat (`metadata.webchat.posicao`). */
  posicao?: PosicaoDoChat;
  /** Ajustes da janela (Tarefa 10a). */
  avatar_url?: string;
  auto_abrir_segundos?: number;
  som?: boolean;
  respostas_rapidas?: string[];
  /** Teto de respostas da IA para visitante anônimo (`metadata.webchat.teto_anonimo`).
   * 1 a 200; ausente ou inválido cai no padrão 20. */
  teto_anonimo?: number;
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
  // `staleTime: 0` obriga a ir ao servidor: o padrão do app (30 s, lib/query/client.ts) fazia o
  // fetchQuery devolver o cache de antes da ação, e a tela seguia com a chave antiga depois do giro.
  const carregar = () => qc.fetchQuery({ queryKey: ["canal-chat"], queryFn: buscarEstado, staleTime: 0 });

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
          placeholder="https://www.example.com"
        />
        <p className="text-xs text-muted-foreground">
          {t("Use o endereço completo com https, por exemplo https://www.example.com.")}
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
  const [pausaAberta, setPausaAberta] = useState(false);
  const pausado = estado.config.pausado === true;
  const formatoInicial: FormatoDoChat = estado.config.formato ?? "bolha";
  const posicaoInicial: PosicaoDoChat = estado.config.posicao ?? "direita";
  const [formato, setFormato] = useState<FormatoDoChat>(formatoInicial);
  const [posicao, setPosicao] = useState<PosicaoDoChat>(posicaoInicial);

  // Ajustes da janela (Tarefa 10a): estado inicial vem da configuracao; vazio = "não mudar".
  const avatarInicial = estado.config.avatar_url ?? "";
  const autoAbrirInicial = estado.config.auto_abrir_segundos ?? 0;
  const somInicial = estado.config.som ?? false;
  const respostasInicial = (estado.config.respostas_rapidas ?? []).join("\n");
  const [avatarUrl, setAvatarUrl] = useState(avatarInicial);
  const [autoAbrirSegundos, setAutoAbrirSegundos] = useState(String(autoAbrirInicial));
  const [som, setSom] = useState(somInicial);
  const [respostasRapidas, setRespostasRapidas] = useState(respostasInicial);

  // Uma resposta rápida por linha, aparadas e sem linha vazia. A validação de verdade é do servidor.
  function linhasDeResposta(texto: string): string[] {
    return texto
      .split(/\r?\n/)
      .map((linha) => linha.trim())
      .filter((linha) => linha !== "");
  }
  const tetoPreenchido = estado.config.teto_anonimo !== undefined && Number.isInteger(estado.config.teto_anonimo);
  const [tetoAnonimo, setTetoAnonimo] = useState(
    tetoPreenchido ? String(estado.config.teto_anonimo) : "",
  );

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

  // Formato e posição: campo em branco não acontece (são selects), então vai sempre com o valor atual.
  const formatoValido = ["bolha", "painel", "embutido", "pagina"].includes(formato);
  const posicaoValida = ["direita", "esquerda"].includes(posicao);
  const formatoMudou = formato !== formatoInicial;
  const posicaoMudou = posicao !== posicaoInicial;

  // Ajustes da janela: validação no cliente, mesmas regras do schema. Campo em branco não muda.
  const avatarPreenchido = avatarUrl.trim() !== "";
  const avatarValida = !avatarPreenchido || avatarUrl.trim().startsWith("https://");

  const autoAbrirPreenchido = autoAbrirSegundos.trim() !== "";
  const autoAbrirAtual = autoAbrirPreenchido ? autoAbrirSegundos.trim() : "0";
  let autoAbrirValido = true;
  let autoAbrirParaEnviar: number = 0;
  if (autoAbrirPreenchido) {
    const n = Number(autoAbrirSegundos);
    autoAbrirValido = Number.isInteger(n) && n >= 0 && n <= 120;
    autoAbrirParaEnviar = n;
  }

  const respostasLinhas = linhasDeResposta(respostasRapidas);
  const respostasValidas =
    respostasLinhas.length <= 5 && respostasLinhas.every((linha) => linha.length >= 1 && linha.length <= 80);

  const ajustes: Record<string, unknown> = {};
  // Em branco com avatar salvo = tirar o avatar: vai "" (o schema aceita e a janela trata como sem avatar).
  if (avatarUrl.trim() !== avatarInicial) ajustes.avatar_url = avatarUrl.trim();
  if (autoAbrirAtual !== String(autoAbrirInicial)) {
    ajustes.auto_abrir_segundos = autoAbrirParaEnviar;
  }
  if (som !== somInicial) ajustes.som = som;
  if (respostasRapidas.trim() !== respostasInicial) ajustes.respostas_rapidas = respostasLinhas;

  const ajustesMudou =
    avatarUrl.trim() !== avatarInicial ||
    autoAbrirAtual !== String(autoAbrirInicial) ||
    som !== somInicial ||
    respostasRapidas.trim() !== respostasInicial;

  const ajustesValidos = avatarValida && autoAbrirValido && respostasValidas;
  // Teto do anônimo: inteiro de 1 a 200. Em branco = "não mudar" (vale o salvo, ou 20 se nunca salvo).
  const tetoBruto = tetoAnonimo.trim();
  const tetoNumero = /^[0-9]+$/.test(tetoBruto) ? Number(tetoBruto) : null;
  const tetoValido = tetoBruto === "" || (tetoNumero !== null && tetoNumero >= 1 && tetoNumero <= TETO_ANONIMO_MAXIMO);
  const tetoAtual = tetoPreenchido ? (estado.config.teto_anonimo ?? null) : null;
  const tetoMudou = tetoBruto !== "" && tetoValido && tetoNumero !== tetoAtual;

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
      try {
        const atualizado = await aoMudar();
        aoConcluir?.(atualizado);
      } catch {
        // refetch falhou após PATCH bem-sucedido: não sobrescreve o toast de sucesso
      }
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

  // Pausa e retoma. Só o pausar pede confirmação (no diálogo); o retomar vai direto.
  const alternarPausa = async (novo: boolean) => {
    setOcupado(true);
    try {
      await apiClient.patch(ROTA, { config: { pausado: novo } });
      setPausaAberta(false);
      toast.success(
        novo
          ? t("Chat pausado. A janela não abre até você retomar.")
          : t("Chat retomado. A janela volta a abrir no seu site."),
      );
      await aoMudar();
    } catch (e) {
      toast.error(avisoDeErro(e, t));
    } finally {
      setOcupado(false);
    }
  };

  const copiar = async (texto: string) => {
    if (await copyToClipboard(texto)) {
      toast.success(t("Copiado."));
    } else {
      toast.error(t("Não foi possível copiar. Selecione o texto e copie manualmente."));
    }
  };

  // A origem é a desta página: é o endereço do CRM que o cliente está usando.
  const origem = typeof window === "undefined" ? "" : window.location.origin;
  let codigo = "";
  let link = "";
  let codigoMontado = true;
  try {
    codigo = codigoParaColar(origem, estado.public_key ?? "", {
      formato,
      posicao,
    });
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
        <h4 className="text-sm font-medium">{t("Formato da janela")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("Como a janela aparece para quem visita o seu site.")}
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-formato">{t("Formato")}</Label>
          <select
            id="canal-chat-formato"
            value={formato}
            onChange={(e) => setFormato(e.target.value as FormatoDoChat)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="bolha">{t("Bolha no canto")}</option>
            <option value="painel">{t("Painel na lateral")}</option>
            <option value="embutido">{t("Embutido numa área do site")}</option>
            <option value="pagina">{t("Página inteira")}</option>
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "Mudou o formato? Cole o código novo no seu site (abaixo). Embutido não mostra a bolha: o iframe fica dentro de um elemento da sua página.",
          )}
        </p>
        <div>
          <Button
            onClick={() =>
              salvar({ config: { formato } })
            }
            disabled={ocupado || !formatoMudou || !formatoValido}
          >
            {t("Salvar formato")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("Posição")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("Lado da tela onde a janela fica aberta.")}
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-posicao">{t("Posição")}</Label>
          <select
            id="canal-chat-posicao"
            value={posicao}
            onChange={(e) => setPosicao(e.target.value as PosicaoDoChat)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="direita">{t("Direita")}</option>
            <option value="esquerda">{t("Esquerda")}</option>
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("Vale para bolha, painel e página inteira.")}
        </p>
        <div>
          <Button
            onClick={() =>
              salvar({ config: { posicao } })
            }
            disabled={ocupado || !posicaoMudou || !posicaoValida}
          >
            {t("Salvar posição")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("Ajustes da janela")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("Como a janela se comporta para quem visita o seu site.")}
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-avatar">{t("Avatar")}</Label>
          <Input
            id="canal-chat-avatar"
            value={avatarUrl}
            maxLength={300}
            placeholder="https://example.com/avatar.png"
            onChange={(e) => setAvatarUrl(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("URL da imagem do avatar (somente https).")}
          </p>
          {!avatarValida && avatarPreenchido && (
            <p role="alert" className="text-xs text-destructive">
              {t("Use https:// na URL do avatar.")}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-auto-abrir">{t("Abrir sozinho após (segundos)")}</Label>
          <Input
            id="canal-chat-auto-abrir"
            type="number"
            value={autoAbrirSegundos}
            maxLength={3}
            onChange={(e) => setAutoAbrirSegundos(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("Vazio ou 0 desliga a abertura automática.")}
          </p>
          {!autoAbrirValido && autoAbrirPreenchido && (
            <p role="alert" className="text-xs text-destructive">
              {t("Use um número inteiro de 0 a 120 segundos.")}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-som">{t("Tocar som ao chegar resposta")}</Label>
          <input
            id="canal-chat-som"
            type="checkbox"
            checked={som}
            onChange={(e) => setSom(e.target.checked)}
            className="h-4 w-4 rounded-sm border-input"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-respostas-rapidas">{t("Respostas rápidas do chat")}</Label>
          <Textarea
            id="canal-chat-respostas-rapidas"
            rows={4}
            value={respostasRapidas}
            placeholder="Ex.: Sim"
            onChange={(e) => setRespostasRapidas(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("Uma resposta rápida por linha, até 5, de 1 a 80 caracteres.")}
          </p>
          {!respostasValidas && (
            <p role="alert" className="text-xs text-destructive">
              {t("Use até 5 respostas rápidas, de 1 a 80 caracteres cada.")}
            </p>
          )}
        </div>
        <div>
          <Button
            onClick={() =>
              // Volta com o que o servidor guardou (como "Salvar domínios"): os *Inicial deste render são os de antes.
              salvar({ config: ajustes }, (atualizado) => {
                setAvatarUrl(atualizado.config.avatar_url ?? "");
                setAutoAbrirSegundos(String(atualizado.config.auto_abrir_segundos ?? 0));
                setSom(atualizado.config.som ?? false);
                setRespostasRapidas((atualizado.config.respostas_rapidas ?? []).join("\n"));
              })
            }
            disabled={
              ocupado ||
              !ajustesMudou ||
              !ajustesValidos
            }
          >
            {t("Salvar ajustes")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("Teto de respostas da IA para visitante anônimo")}</h4>
        <p className="text-xs text-muted-foreground">
          {t(
            "Depois desse número a IA para de responder e a conversa fica para a equipe. Quem deixa telefone ou e-mail sai deste limite.",
          )}
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-chat-teto-anonimo">{t("Quantas respostas da IA por conversa")}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="canal-chat-teto-anonimo"
              type="number"
              min={1}
              max={TETO_ANONIMO_MAXIMO}
              value={tetoAnonimo}
              placeholder={String(TETO_ANONIMO_PADRAO)}
              onChange={(e) => setTetoAnonimo(e.target.value)}
              className="w-24 font-mono"
            />
            <span className="text-xs text-muted-foreground">
              {t("Deixe em branco para não mudar.")}
            </span>
          </div>
          {!tetoValido && tetoBruto !== "" && (
            <p role="alert" className="text-xs text-destructive">
              {t("Use um número inteiro de 1 a 200.")}
            </p>
          )}
        </div>
        <div>
          <Button
            onClick={() =>
              salvar({ config: { teto_anonimo: tetoNumero } }, () => {
                setTetoAnonimo(tetoNumero !== null ? String(tetoNumero) : "");
              })
            }
            disabled={ocupado || !tetoMudou || !tetoValido}
          >
            {t("Salvar teto")}
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
            placeholder="https://www.example.com"
            onChange={(e) => setDominios(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("Use o endereço completo com https, por exemplo https://www.example.com.")}
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
            onClick={() => {
              const enviado = listaDominios.join("\n");
              salvar({ allowed_origins: listaDominios }, (atualizado) =>
                setDominios((prev) => (prev === enviado ? atualizado.allowed_origins.join("\n") : prev)),
              );
            }}
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
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium">{t("Disponibilidade")}</h4>
          {pausado && <Badge variant="outline">{t("Pausado")}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "Com o chat pausado, a janela não abre no seu site e ninguém consegue começar uma conversa. As conversas já feitas continuam no Inbox.",
          )}
        </p>
        <div>
          {pausado ? (
            <Button variant="outline" onClick={() => alternarPausa(false)} disabled={ocupado}>
              {t("Retomar o chat")}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setPausaAberta(true)} disabled={ocupado}>
              {t("Pausar o chat")}
            </Button>
          )}
        </div>
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

      <AlertDialog open={pausaAberta} onOpenChange={setPausaAberta}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Pausar o chat?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Enquanto estiver pausado, a janela do chat não abre e quem está conversando vê 'chat indisponível'. As conversas já feitas continuam no Inbox.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <Button onClick={() => alternarPausa(true)} disabled={ocupado}>
              {t("Sim, pausar o chat")}
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
