"use client";

/**
 * O ARQUIVO DA PRIMEIRA ABORDAGEM NA TELA DA CAMPANHA (#4751).
 *
 * A mídia da abordagem existe no motor desde a #4581 (`midia_da_abordagem` em
 * `lib/prospecting/schema.ts`), mas só dava para configurá-la pela API. Este
 * campo leva para a tela o que a API já aceita, sem mudar o envio:
 *
 * · Escolher: a lista é dos arquivos que JÁ estão no Storage desta organização,
 *   as imagens das respostas rápidas (`message_templates.midias`) — é o mesmo
 *   vocabulário que a configuração grava (caminho, mime e tamanho), preenchido
 *   pela rota de upload que confere os bytes — mais os arquivos enviados AQUI.
 * · Enviar: imagem, vídeo ou PDF vão por `POST /api/v1/prospecting/arquivo`,
 *   que fareja os bytes e aplica `classificarMidiaDaAbordagem` — a MESMA régua
 *   deste componente, do schema e do worker. O descritor que a rota devolve é o
 *   que entra na configuração, sem tradução no meio: o caminho que a tela manda
 *   é o que `prepararMidiaDaAbordagem` assina no envio.
 * · Filtrar pela MESMA régua do envio (`classificarMidiaDaAbordagem`): o que a
 *   lista oferece é o que o schema aceita, e nada que ele recusaria aparece.
 * · Remover: o campo vazio tira a chave da configuração, e a campanha sai só
 *   com texto, como a campanha que nunca teve mídia.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { tamanhoLegivel } from "@/lib/materiais/materiais";
import {
  classificarMidiaDaAbordagem,
  TETO_DIARIO_DE_MIDIA_POR_NUMERO,
  type MidiaDaAbordagem,
  type TipoDeMidiaDaAbordagem,
} from "@/lib/prospecting/midia-da-abordagem";

/** A mesma chave da lista de respostas rápidas: a tela de templates invalida esta. */
const CHAVE_DOS_TEMPLATES = ["message-templates"] as const;

interface TemplateComMidias {
  id: string;
  title: string;
  midias?: MidiaDaAbordagem[] | null;
}

export interface ArquivoOferecido {
  midia: MidiaDaAbordagem;
  /** O título da resposta rápida de onde o arquivo vem. */
  origem: string;
  /** A posição do arquivo dentro da resposta (1, 2, …), para distinguir dois da mesma. */
  posicao: number;
  tipo: TipoDeMidiaDaAbordagem;
}

/**
 * Os arquivos que podem ir numa abordagem, pela régua do envio. Um mesmo
 * caminho aparece uma vez só.
 */
export function arquivosOferecidos(templates: unknown): ArquivoOferecido[] {
  if (!Array.isArray(templates)) return [];
  const vistos = new Set<string>();
  const lista: ArquivoOferecido[] = [];
  for (const template of templates as TemplateComMidias[]) {
    (template.midias ?? []).forEach((midia, indice) => {
      if (!midia?.storage_path || vistos.has(midia.storage_path)) return;
      const classificada = classificarMidiaDaAbordagem(midia);
      if (!classificada.ok) return;
      vistos.add(midia.storage_path);
      lista.push({
        midia: {
          storage_path: midia.storage_path,
          media_mime: midia.media_mime,
          media_size_bytes: midia.media_size_bytes,
        },
        origem: template.title,
        posicao: indice + 1,
        tipo: classificada.tipo,
      });
    });
  }
  return lista;
}

const ROTULO_DO_TIPO: Record<TipoDeMidiaDaAbordagem, string> = {
  image: "Imagem",
  video: "Vídeo",
  document: "PDF",
};

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

export function ArquivoDaAbordagem({
  valor,
  onChange,
  travado = false,
}: {
  valor: MidiaDaAbordagem | undefined;
  onChange: (midia: MidiaDaAbordagem | undefined) => void;
  /** A campanha já começou: o campo só mostra, e o aviso de risco já está no cartão. */
  travado?: boolean;
}) {
  const t = useT();
  const [enviando, setEnviando] = useState(false);
  const [erroDoEnvio, setErroDoEnvio] = useState<string | null>(null);
  const [enviados, setEnviados] = useState<ArquivoOferecido[]>([]);
  const templates = useQuery({
    queryKey: CHAVE_DOS_TEMPLATES,
    queryFn: async () =>
      apiClient.get<{ data: TemplateComMidias[] }>("/api/v1/message-templates"),
    staleTime: 60_000,
    enabled: !travado,
  });
  /**
   * O que a tela oferece: primeiro o que foi enviado AQUI (o arquivo novo não
   * está em resposta rápida nenhuma), depois as imagens que já moram no CRM.
   */
  const daCasa = arquivosOferecidos(templates.data?.data);
  const oferecidos = [
    ...enviados,
    ...daCasa.filter((o) => !enviados.some((e) => e.midia.storage_path === o.midia.storage_path)),
  ];
  const escolhido = valor
    ? oferecidos.find((o) => o.midia.storage_path === valor.storage_path)
    : undefined;
  const tipoDoValor = valor ? classificarMidiaDaAbordagem(valor) : null;
  const rotulo = (o: ArquivoOferecido) =>
    `${o.origem} · ${t(ROTULO_DO_TIPO[o.tipo])} ${o.posicao} · ${tamanhoLegivel(o.midia.media_size_bytes)}`;

  /**
   * Sobe o arquivo pela rota que confere os BYTES e devolve o descritor que a
   * configuração guarda. O que entra em `onChange` é esse descritor, sem
   * remontar nada: o `storage_path` que o worker assina é o mesmo que veio da
   * rota. Recusa da rota (tipo ou tamanho) aparece como texto, e nada muda na
   * configuração.
   */
  async function enviarArquivo(file: File | undefined) {
    if (!file) return;
    setErroDoEnvio(null);
    setEnviando(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch("/api/v1/prospecting/arquivo", { method: "POST", body: form });
      const json = (await res.json().catch(() => null)) as
        | { data?: { midia: MidiaDaAbordagem; nome: string }; error?: { message?: string } }
        | null;
      if (!res.ok || !json?.data) {
        setErroDoEnvio(json?.error?.message ?? t("Não foi possível enviar o arquivo."));
        return;
      }
      const classificada = classificarMidiaDaAbordagem(json.data.midia);
      if (!classificada.ok) {
        setErroDoEnvio(classificada.motivo);
        return;
      }
      const novo: ArquivoOferecido = {
        midia: json.data.midia,
        origem: json.data.nome,
        posicao: 1,
        tipo: classificada.tipo,
      };
      setEnviados((atuais) => [
        novo,
        ...atuais.filter((o) => o.midia.storage_path !== novo.midia.storage_path),
      ]);
      onChange(json.data.midia);
    } catch {
      setErroDoEnvio(t("Não foi possível enviar o arquivo."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div>
      <Label htmlFor="prospecting-arquivo-da-abordagem">
        {t("Arquivo da primeira abordagem")}
      </Label>
      <select
        id="prospecting-arquivo-da-abordagem"
        className={`${selectClass} mt-1`}
        value={valor?.storage_path ?? ""}
        disabled={travado}
        onChange={(e) => {
          const escolha = oferecidos.find((o) => o.midia.storage_path === e.target.value);
          onChange(escolha ? escolha.midia : undefined);
        }}
      >
        <option value="">{t("Sem arquivo: só texto")}</option>
        {/* Arquivo gravado pela API (vídeo, PDF) ou cuja resposta rápida sumiu da
            lista: aparece como está, para o campo não mentir sobre a configuração. */}
        {valor && !escolhido && (
          <option value={valor.storage_path}>
            {t("Arquivo já configurado")}
            {tipoDoValor?.ok ? ` · ${t(ROTULO_DO_TIPO[tipoDoValor.tipo])}` : ""}
            {` · ${tamanhoLegivel(valor.media_size_bytes)}`}
          </option>
        )}
        {oferecidos.map((o) => (
          <option key={o.midia.storage_path} value={o.midia.storage_path}>
            {rotulo(o)}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-muted-foreground">
        {t(
          "Opcional. O arquivo vai junto da primeira mensagem, igual para todas as empresas da campanha. Aceita imagem (JPG, PNG ou WEBP, até 5 MB), vídeo (MP4, 3GP ou MOV, até 16 MB) ou PDF (até 50 MB).",
        )}
      </p>
      {!travado && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              id="prospecting-arquivo-upload"
              type="file"
              aria-label={t("Enviar um arquivo do computador")}
              accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp,video/quicktime,application/pdf"
              disabled={enviando}
              onChange={(e) => {
                void enviarArquivo(e.target.files?.[0]);
                e.target.value = "";
              }}
              className="text-sm"
            />
            {enviando && (
              <span className="text-xs text-muted-foreground">{t("Enviando o arquivo…")}</span>
            )}
          </div>
          {erroDoEnvio && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {erroDoEnvio}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              "A lista mostra os arquivos que você já tem no CRM; para usar um arquivo novo, envie por aqui mesmo — o tipo é conferido pelos bytes antes de guardar.",
            )}{" "}
            <Link href="/app/templates" className="underline">
              {t("Abrir respostas rápidas")}
            </Link>
          </p>
        </>
      )}
      {valor && !travado && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => onChange(undefined)}
          >
            {t("Remover arquivo")}
          </Button>
          <p role="note" className="mt-3 rounded-md bg-muted/40 p-3 text-sm">
            {t(
              "Atenção: esta campanha manda o mesmo arquivo junto da primeira mensagem. Quando muita gente que não conhece você recebe o mesmo arquivo, aumenta o risco de o WhatsApp bloquear o seu número. Por segurança, cada número manda o arquivo em no máximo {teto} abordagens por dia; depois disso, as abordagens do dia saem só com o texto.",
            ).replace("{teto}", String(TETO_DIARIO_DE_MIDIA_POR_NUMERO))}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              "Não apague o arquivo escolhido, nem a resposta rápida de onde ele vem, enquanto a campanha estiver ativa: sem o arquivo, a campanha pausa.",
            )}
          </p>
        </>
      )}
    </div>
  );
}
