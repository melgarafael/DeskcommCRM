"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { GrupoDeRespostas, MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { lerRespostaRapida } from "@/lib/inbox/resposta-rapida";
import { useUploadTemplateMedia } from "@/hooks/templates/useUploadTemplateMedia";
import {
  MAXIMO_DE_MIDIAS,
  TAMANHO_MAXIMO_DA_MIDIA,
  TAMANHO_MAXIMO_DO_AUDIO,
  ehMidiaDeAudio,
  midiaDeAudioDe,
  type MidiaDeTemplate,
} from "@/lib/templates/midias";

const TEMPLATES_KEY = ["message-templates"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canShare: boolean;
  template?: MessageTemplate | null;
  /**
   * Os grupos da organização (#3245). Vazio = o recurso não existe para esta
   * empresa, e o campo de grupo NEM APARECE — o "opcional" chega até o
   * formulário: quem nunca criou grupo vê o formulário de sempre.
   */
  grupos?: GrupoDeRespostas[];
}

/** O valor do seletor para "sem grupo" — o Radix não aceita item de valor vazio. */
const SEM_GRUPO = "__sem_grupo__";

interface CreateInput {
  title: string;
  body: string;
  shortcut?: string;
  shared?: boolean;
  /** "Mostrar na barra do Inbox" (#3282) — ausente é ligado. */
  mostrar_na_barra?: boolean;
  /** O grupo (#3245) — `null` é sem grupo, a lista plana. */
  grupo_id?: string | null;
}

interface UpdateInput {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  midias?: MidiaDeTemplate[];
  midias_esperadas: MidiaDeTemplate[];
  /** "Mostrar na barra do Inbox" (#3282). */
  mostrar_na_barra?: boolean;
  /** O grupo (#3245): `null` desvincula. */
  grupo_id?: string | null;
}

/**
 * O FORMULÁRIO DA RESPOSTA RÁPIDA (#3009 sobre a tela da #2526/#2833) — texto,
 * imagem e áudio, cada um OPCIONAL e combinável.
 *
 * ─── O que mudou, e por quê ─────────────────────────────────────────────────
 *
 * Havia um seletor de TIPO ("Texto" ou "Áudio") que era um modo do formulário:
 * no modo texto a mensagem era `required` e não havia campo de áudio; no modo
 * áudio não havia texto nem imagem. O preço disso, medido contra o que a #3009
 * pede: só imagem não existia (o texto era obrigatório) e NENHUMA combinação
 * com áudio existia — texto+áudio, imagem+áudio e texto+imagem+áudio.
 *
 * Agora são três seções independentes, na mesma tela, e o que o operador
 * preencher é o que a resposta leva. O dado não mudou de forma: `body` é o
 * texto e `midias` é a lista de arquivos (imagem OU áudio), como desde a #2526 —
 * o que mudou é que o formulário deixou de impor UM modo.
 *
 * Quem diz se o conjunto é uma resposta rápida válida é `lerRespostaRapida`
 * (`lib/inbox/resposta-rapida.ts`): a MESMA régua que a barra do Inbox desenha
 * e que o envio consulta. Sem ela, três seções independentes permitiriam salvar
 * uma resposta sem nada — o botão que não prepara nada.
 *
 * ─── A ordem das escritas, que continua importando ──────────────────────────
 *
 *   CRIAR    primeiro o template, depois os arquivos: a rota de upload precisa
 *            do id. Falha de confirmação conserva a linha: um upload pode ter
 *            persistido mesmo sem entregar a resposta ao formulário. O diálogo
 *            fecha para que outro clique não crie uma segunda resposta.
 *   EDITAR   o áudio NOVO substitui o antigo pela mesma rota, inclusive no teto
 *            de cinco, sem apagar o que funcionava antes do sucesso. As
 *            imagens sobem DEPOIS do PATCH que remove (o teto de 5 vale a cada
 *            upload — #2526). "Sai" é medido contra o que o FORM conhece, não
 *            contra a prop `template`: no retry depois de um upload que falhou,
 *            o form já sabe que a imagem removida saiu.
 */
export function TemplateFormDialog({ open, onOpenChange, canShare, template, grupos = [] }: Props) {
  const t = useT();
  const isEdit = !!template;
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [shortcut, setShortcut] = React.useState("");
  const [shared, setShared] = React.useState(false);
  /**
   * "Mostrar na barra do Inbox" (#3282). Nasce LIGADO — o default da coluna e o
   * comportamento de quem já usava o produto.
   */
  const [mostrarNaBarra, setMostrarNaBarra] = React.useState(true);
  /** O grupo escolhido (#3245). `SEM_GRUPO` = lista plana, o estado de sempre. */
  const [grupoId, setGrupoId] = React.useState<string>(SEM_GRUPO);
  // O arquivo de áudio escolhido NESTA edição; quando null, o recurso continua
  // com o áudio que já tem em `midias` (`audioAtual`).
  const [arquivo, setArquivo] = React.useState<File | null>(null);
  const [removerAudio, setRemoverAudio] = React.useState(false);
  /**
   * A LISTA persistida da resposta rápida e as mudanças ainda pendentes:
   * motivo:
   *
   *  `midiasGravadas` o snapshot completo, atualizado pela resposta de CADA
   *              escrita. Áudio/preview e o próximo CAS leem essa mesma lista.
   *  `removidas` o que o operador tirou NESTA edição: nada sai do bucket antes
   *              do Salvar — cancelar tem de devolver o template inteiro.
   *  `novas`     os arquivos escolhidos, que só sobem no Salvar (a rota gera o
   *              caminho e devolve a lista gravada).
   */
  const [midiasGravadas, setMidiasGravadas] = React.useState<MidiaDeTemplate[]>([]);
  const [removidas, setRemovidas] = React.useState<string[]>([]);
  const [novas, setNovas] = React.useState<File[]>([]);

  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async (input: CreateInput) =>
      apiClient.post<{ data: MessageTemplate }>("/api/v1/message-templates", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const update = useMutation({
    mutationFn: async ({ id, ...input }: UpdateInput) =>
      apiClient.patch<{ data: MessageTemplate & { midias: MidiaDeTemplate[] } }>(`/api/v1/message-templates/${id}`, input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const upload = useUploadTemplateMedia();
  const pending = create.isPending || update.isPending || upload.isPending;

  /** A LISTA da linha, na ordem gravada — a posição é a URL da prévia. */
  const listaDa = midiasGravadas;
  const gravadas = midiasGravadas.filter((m) => !ehMidiaDeAudio(m));
  /** A entrada de áudio do recurso editado, se houver (#2833). */
  const audioAtual = midiaDeAudioDe(listaDa);

  const urlsNovas = React.useMemo(() => novas.map((file) => URL.createObjectURL(file)), [novas]);
  React.useEffect(
    () => () => {
      for (const url of urlsNovas) URL.revokeObjectURL(url);
    },
    [urlsNovas],
  );

  React.useEffect(() => {
    if (!open) return;
    setTitle(template?.title ?? "");
    setBody(template?.body ?? "");
    setShortcut(template?.shortcut ?? "");
    setShared(template ? template.owner_user_id === null : false);
    // Ausente = ligado: linha anterior à coluna (e template recém-criado) aparece.
    setMostrarNaBarra(template ? template.mostrar_na_barra !== false : true);
    setGrupoId(template?.grupo_id ?? SEM_GRUPO);
    setArquivo(null);
    setRemoverAudio(false);
    setMidiasGravadas((template?.midias ?? []) as MidiaDeTemplate[]);
    setRemovidas([]);
    setNovas([]);
  }, [open, template]);

  const mantidas = gravadas.filter((m) => !removidas.includes(m.storage_path));
  const outrosAudios = midiasGravadas.filter((m) => ehMidiaDeAudio(m) && m.storage_path !== audioAtual?.storage_path);
  const audiosFinais = outrosAudios.length + (arquivo || (audioAtual && !removerAudio) ? 1 : 0);
  /**
   * O TETO DE 5 MÍDIAS (#2526) conta TUDO o que a resposta leva. Desde a #3009 o
   * áudio é uma mídia como as imagens, não um modo à parte: 5 imagens + 1 áudio
   * estouraria o CHECK do banco, e a tela tem de dizer isso ANTES do upload.
   * Áudio escolhido para TROCAR o atual ocupa uma vaga, não duas.
   */
  const total = mantidas.length + novas.length + audiosFinais;
  const estourou = total > MAXIMO_DE_MIDIAS;

  /**
   * O preview da mídia JÁ gravada sai da própria rota de leitura. O índice é a
   * POSIÇÃO na linha — inclusive quando há uma entrada de áudio antes das
   * imagens: `gravadas` filtra o áudio, mas a rota serve por posição na lista
   * do banco.
   */
  function urlDaGravada(midia: MidiaDeTemplate): string {
    const indice = listaDa.findIndex((m) => m.storage_path === midia.storage_path);
    return `/api/v1/message-templates/${template?.id}/midias/${indice}`;
  }

  function escolherArquivos(lista: FileList | null) {
    if (!lista) return;
    const aceitas: File[] = [];
    for (const file of Array.from(lista)) {
      // A MESMA régua da rota (que confere pela ASSINATURA dos bytes): aqui é
      // só o aviso honesto antes do upload, não a autorização.
      if (!/^image\/(jpeg|png)$/.test(file.type)) {
        toast.error(t("A imagem precisa ser JPG ou PNG."));
        continue;
      }
      if (file.size > TAMANHO_MAXIMO_DA_MIDIA) {
        toast.error(t("A imagem precisa ter até 5 MB."));
        continue;
      }
      aceitas.push(file);
    }
    if (aceitas.length) setNovas((atual) => [...atual, ...aceitas]);
  }

  function escolherAudio(lista: FileList | null) {
    const file = lista?.[0] ?? null;
    if (!file) {
      setArquivo(null);
      return;
    }
    // Aviso antes do upload; quem decide é a rota, pelos bytes. O teto é o do
    // ÁUDIO (16 MB), não o da imagem.
    if (!/^audio\//.test(file.type)) {
      toast.error(t("O arquivo precisa ser de áudio."));
      return;
    }
    // M4A (o padrão do gravador do iPhone e do Mac) e WebM a rota recusa com
    // 415. Recusar AQUI, antes de o template existir, é o que impede a criação
    // de deixar uma resposta rápida sem o conteúdo que o operador escolheu.
    if (/^audio\/(mp4|x-m4a|m4a|webm)$/.test(file.type)) {
      toast.error(t("O áudio precisa ser OGG, MP3, AAC, AMR ou WAV."));
      return;
    }
    if (file.size > TAMANHO_MAXIMO_DO_AUDIO) {
      toast.error(t("O áudio precisa ter até 16 MB."));
      return;
    }
    setArquivo(file);
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    /**
     * A RÉGUA, ANTES DE QUALQUER ESCRITA (#3009). As três seções são opcionais,
     * então o formulário pode chegar aqui sem conteúdo nenhum — e salvar isso
     * criaria o botão que não prepara nada na barra do Inbox. A contagem sai dos
     * CAMPOS (no cadastro o template ainda não existe; um arquivo escolhido
     * ainda é `File`) e a pergunta é a mesma que a barra e o envio fazem.
     */
    const leitura = lerRespostaRapida({
      texto: body,
      imagens: mantidas.length + novas.length,
      audios: audiosFinais,
    });
    if (!leitura.ok) {
      toast.error(t(leitura.motivo));
      return;
    }

    try {
      if (isEdit) {
        let persistidas = midiasGravadas;
        const receberLista = (lista: MidiaDeTemplate[]) => {
          persistidas = lista;
          setMidiasGravadas(lista);
        };
        let audioPendente = arquivo;
        // A troca é uma única escrita da lista pela rota de upload, mesmo no
        // teto5. Recusa anterior à escrita conserva a versão anterior; perda
        // da confirmação exige recarregar, sem apagar objetos por hipótese.
        if (audioPendente && audioAtual) {
          receberLista(await upload.mutateAsync({
            templateId: template.id,
            file: audioPendente,
            midiasEsperadas: persistidas,
            substituirAudio: audioAtual.storage_path,
          }));
          setArquivo(null);
          setRemoverAudio(false);
          audioPendente = null;
        }

        const listaFinal = persistidas.filter((m) =>
          !removidas.includes(m.storage_path) &&
          !(removerAudio && !arquivo && m.storage_path === audioAtual?.storage_path),
        );
        const resposta = await update.mutateAsync({
          id: template.id,
          title,
          body,
          shortcut: shortcut.trim() || null,
          mostrar_na_barra: mostrarNaBarra,
          grupo_id: grupoId === SEM_GRUPO ? null : grupoId,
          midias_esperadas: persistidas,
          ...(listaFinal.length !== persistidas.length ? { midias: listaFinal } : {}),
        });
        receberLista(resposta.data.midias);
        setRemovidas([]);
        setRemoverAudio(false);

        // Sem áudio anterior, o PATCH pode abrir a vaga de uma imagem removida.
        if (audioPendente) {
          receberLista(await upload.mutateAsync({
            templateId: template.id, file: audioPendente, midiasEsperadas: persistidas,
          }));
          setArquivo(null);
        }

        // Cada upload usa a resposta do anterior, inclusive no retry parcial.
        for (const file of novas) {
          receberLista(await upload.mutateAsync({
            templateId: template.id, file, midiasEsperadas: persistidas,
          }));
          setNovas((atual) => atual.filter((f) => f !== file));
        }
        toast.success(t("Resposta rápida atualizada."));
      } else {
        const criado = await create.mutateAsync({
          title,
          body,
          shortcut: shortcut.trim() || undefined,
          shared: canShare ? shared : false,
          mostrar_na_barra: mostrarNaBarra,
          grupo_id: grupoId === SEM_GRUPO ? null : grupoId,
        });
        // A partir daqui o template JÁ existe: deixar o diálogo aberto faria o
        // próximo clique criar um segundo. O `finally` fecha mesmo quando o
        // upload falha — a mídia que não subiu entra pela edição, que é onde
        // ela aparece de qualquer forma.
        const subir = [...novas, ...(arquivo ? [arquivo] : [])];
        let persistidas = criado.data.midias ?? [];
        try {
          for (const file of subir) {
            persistidas = await upload.mutateAsync({
              templateId: criado.data.id, file, midiasEsperadas: persistidas,
            });
          }
        } catch (erro) {
          toast.error(t("A resposta já foi criada. Confira a lista antes de tentar novamente."));
          throw erro;
        } finally {
          // Ausência de confirmação não prova ausência de conteúdo. Inclusive
          // um 409 pode ter preservado a mídia de outro escritor. Sem rollback
          // atômico comprovado, conservar é preferível a apagar essa referência.
          qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
          onOpenChange(false);
        }
        toast.success(t("Resposta rápida criada."));
      }
      onOpenChange(false);
    } catch {
      /* erro já mostrado pelo showApiError */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t("Editar resposta rápida") : t("Nova resposta rápida")}</DialogTitle>
          <DialogDescription>
            {t("Respostas rápidas: o texto cai no campo editável do Inbox; a imagem e o áudio entram na fila de anexos, com prévia, e você revisa antes de enviar.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tpl-title">{t("Título")}</Label>
            <Input
              id="tpl-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("Saudação inicial")}
              minLength={1}
              maxLength={80}
              required
            />
          </div>
          {/*
            TEXTO (#3009) — deixou de ser obrigatório. Era ele que impedia a
            resposta de SÓ IMAGEM, um dos formatos que a issue pede.
          */}
          <div className="space-y-2">
            <Label htmlFor="tpl-body">{t("Mensagem")}</Label>
            <Textarea
              id="tpl-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("Oi {{primeiro_nome}}, tudo bem?")}
              maxLength={4096}
              rows={5}
            />
            <p className="text-xs text-muted-foreground">
              {t("Texto, imagem e áudio são opcionais: preencha o que a resposta leva.")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("Use")} {"{{primeiro_nome}}"} {t("e")} {"{{nome}}"} {t("para personalizar.")}
            </p>
              <p className="text-xs text-muted-foreground">
                {t('Para não depender do dado, ponha um texto de reserva: {{primeiro_nome|"aluno"}}.')}
              </p>
          </div>
          {/*
            AS IMAGENS (#2526) — o operador carrega as dele, sem depender do
            catálogo de produtos. Prévia e remoção existem porque a aprovação é
            dele: o que entra na conversa tem de ser o que ele viu aqui.
          */}
          <div className="space-y-2">
            <Label htmlFor="tpl-midias">{t("Imagens (opcional)")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("JPG ou PNG, até 5 MB por imagem. A imagem vai junto com o texto.")}
            </p>
            {(mantidas.length > 0 || novas.length > 0) && (
              <ul className="flex flex-wrap gap-2">
                {mantidas.map((midia) => (
                  <li key={midia.storage_path} className="relative">
                    <img
                      src={urlDaGravada(midia)}
                      alt={t("Imagem da resposta rápida")}
                      className="size-16 rounded-md border border-border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setRemovidas((atual) => [...atual, midia.storage_path])}
                      aria-label={t("Remover imagem")}
                      className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
                {novas.map((file, i) => (
                  <li key={`${file.name}-${i}`} className="relative">
                    <img
                      src={urlsNovas[i]}
                      alt={t("Prévia da imagem")}
                      className="size-16 rounded-md border border-border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setNovas((atual) => atual.filter((_, j) => j !== i))}
                      aria-label={t("Remover imagem")}
                      className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <Input
                id="tpl-midias"
                type="file"
                accept="image/jpeg,image/png"
                multiple
                className="sr-only"
                onChange={(e) => {
                  escolherArquivos(e.target.files);
                  // Sem isto, escolher o MESMO arquivo duas vezes seguidas não
                  // disparava `change` — e a segunda escolha some em silêncio.
                  e.target.value = "";
                }}
              />
              <Label
                htmlFor="tpl-midias"
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-muted"
              >
                {t("Adicionar imagem")}
              </Label>
              {estourou && (
                <p className="text-xs text-destructive">
                  {t("Cada resposta rápida tem no máximo 5 mídias.")}
                </p>
              )}
            </div>
          </div>
          {/*
            O ÁUDIO (#2833) deixou de ser um MODO e virou uma seção ao lado das
            outras (#3009): era o modo que impedia texto+áudio, imagem+áudio e
            texto+imagem+áudio, e é o mesmo arquivo de antes — uma entrada de
            `midias`, gravada pela MESMA rota das imagens.
          */}
          <div className="space-y-2">
            <Label htmlFor="tpl-audio">{t("Arquivo de áudio")}</Label>
            <Input
              id="tpl-audio"
              type="file"
              accept=".ogg,.opus,.mp3,.aac,.amr,.wav"
              onChange={(e) => escolherAudio(e.target.files)}
            />
            {/* A prévia do áudio ATUAL sai da mesma rota das imagens (por
                posição): é o arquivo que o recurso já tem em `midias`. */}
            {audioAtual && !arquivo && !removerAudio && (
              <audio
                controls
                preload="none"
                src={urlDaGravada(audioAtual)}
                className="h-9 w-full"
                aria-label={t("Áudio da resposta rápida")}
              />
            )}
            {audioAtual && !arquivo && (
              <Button type="button" variant="ghost" size="sm" disabled={pending}
                onClick={() => setRemoverAudio((atual) => !atual)}>
                {removerAudio ? t("Desfazer remoção do áudio") : t("Remover áudio")}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              {removerAudio && !arquivo
                ? t("O áudio será removido ao salvar.")
                : audioAtual && !arquivo
                  ? t("Áudio carregado nesta edição. Escolha outro arquivo para substituir.")
                  : t("O áudio fica na biblioteca e entra no Inbox na fila de anexos, como o `/`.")}
            </p>
          </div>
          {/* O GRUPO (#3245) — campo só existe quando a organização tem grupo.
              Sem grupo cadastrado, o formulário é o de sempre: o "opcional"
              vale também para o desenho, não só para o dado. */}
          {grupos.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="tpl-grupo">{t("Grupo (opcional)")}</Label>
              <Select value={grupoId} onValueChange={setGrupoId}>
                <SelectTrigger id="tpl-grupo">
                  <SelectValue placeholder={t("Sem grupo")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_GRUPO}>{t("Sem grupo")}</SelectItem>
                  {grupos.map((grupo) => (
                    <SelectItem key={grupo.id} value={grupo.id}>
                      {grupo.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("Organize as respostas por etapa da venda. Sem grupo, ela continua na lista de sempre.")}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="tpl-shortcut">{t("Atalho (opcional)")}</Label>
            <Input
              id="tpl-shortcut"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              placeholder={t("oi")}
              maxLength={40}
            />
          </div>
          {canShare && (
            <div className="flex items-center gap-2">
              <Switch
                id="tpl-shared"
                checked={shared}
                onCheckedChange={setShared}
                disabled={isEdit}
              />
              <Label htmlFor="tpl-shared">{t("Compartilhar com a equipe")}</Label>
            </div>
          )}
          {/*
            "MOSTRAR NA BARRA DO INBOX" (#3282) — o liga/desliga por resposta
            rápida. Nasce LIGADO (default da coluna e da tela): quem já usava o
            produto continua vendo tudo na barra. Desmarcado, o botão sai da
            barra e a resposta CONTINUA no atalho `/` — a dica abaixo diz isso,
            porque a confusão natural é achar que apagar da barra apaga a resposta.
          */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Switch
                id="tpl-na-barra"
                checked={mostrarNaBarra}
                onCheckedChange={setMostrarNaBarra}
              />
              <Label htmlFor="tpl-na-barra">{t("Mostrar na barra do Inbox")}</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Desmarcado, a resposta sai da barra do Inbox e continua no atalho /.")}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pending || estourou}>
              {isEdit ? t("Salvar") : t("Criar resposta rápida")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
