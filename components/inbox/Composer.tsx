"use client";
import { useT } from "@/hooks/i18n/useT";
import {
  forwardRef,
  useImperativeHandle,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { PaperPlaneTilt } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { AttachmentPreviewDialog } from "@/components/inbox/composer/AttachmentPreviewDialog";
import { ContactPickerDialog } from "@/components/inbox/composer/ContactPickerDialog";
import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";
import { ReplyReviewPanel } from "@/components/inbox/composer/ReplyReviewPanel";
import { DraftReplyButton } from "@/components/inbox/composer/DraftReplyButton";
import { EmojiButton } from "@/components/inbox/composer/EmojiButton";
import { anexoLevaLegenda, indiceDaLegenda } from "@/components/inbox/media/legenda-do-anexo";
import {
  MentionMenu,
  opcoesDeMencao,
  resolverMencao,
  type OpcaoDeMencao,
} from "@/components/inbox/composer/MentionMenu";
import { resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useCreateNote } from "@/hooks/inbox/useCreateNote";
import { useGruposDeRespostas, useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import { X } from "lucide-react";
import { toast } from "sonner";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia, type DestinoDoUpload } from "@/hooks/inbox/useUploadMedia";
import { useRascunhoAssistido } from "@/hooks/inbox/useRascunhoAssistido";
import { imagemDoClipboard } from "@/lib/inbox/clipboard-image";
import {
  interpolateTemplate,
  motivoDoCuringaLiteral,
  payloadDeUso,
  type TemplateContact,
} from "@/lib/inbox/template-vars";
import {
  type AvisoDeRascunho,
  type MotivoDeRecusa,
} from "@/lib/inbox/rascunho-sugerido";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { avisoDaContinua } from "@/lib/channels/numero-do-atendente";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { mimeDaMidia, type MidiaDeTemplate } from "@/lib/templates/midias";
import { embutirMencoes, podarMencoes, type MencaoEscolhida } from "@/lib/notifications/mentions";
import { cn } from "@/lib/utils";
import { resolveSharedContact } from "@/lib/messaging/contact-card";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import { type Recurso } from "@/lib/inbox/recursos";
import { lerRespostaRapidaGravada } from "@/lib/inbox/resposta-rapida";
import type { Message } from "@/lib/types/messaging";

export interface ComposerHandle {
  focus: () => void;
}

/**
 * O que a tela diz quando o rascunho NÃO vale mais (issue #1611: "a conversa
 * abre sem texto e com aviso").
 *
 * Os quatro motivos são frases separadas de propósito: o atendente precisa
 * saber se o texto expirou, se alguém já usou ou se o link era de outra
 * conversa — e a única coisa que os quatro têm em comum (a conversa abriu sem
 * ele) é justamente o que ele não deve presumir sozinho.
 */
function avisoDeRascunhoIndisponivel(motivo: MotivoDeRecusa, t: (texto: string) => string): string {
  switch (motivo) {
    case "outra_conversa":
      return t("O texto sugerido pertence a outra conversa. A conversa abriu sem ele.");
    case "usado":
      return t("O texto sugerido já foi usado. A conversa abriu sem ele.");
    case "expirado":
      return t("O texto sugerido expirou. A conversa abriu sem ele.");
    case "nao_encontrado":
    default:
      return t("O texto sugerido não foi encontrado. A conversa abriu sem ele.");
  }
}

interface Props {
  conversationId: string;
  initialDraft?: string;
  initialMode?: "reply" | "note";
  onDraftChange?: (text: string, mode: "reply" | "note") => void;
  active?: boolean;
  disabled?: boolean;
  /** Set true when contact is blocked / anonymized — explanation shown. */
  blockedReason?: string | null;
  /**
   * Janela de 24h fechada: barra a RESPOSTA, e só ela.
   *
   * Separado de `blockedReason` porque a nota interna nunca chega ao cliente —
   * a regra da plataforma não a alcança, e barrá-la tira do atendente
   * justamente o lugar onde ele registra por que a conversa esfriou. A primeira
   * versão deste bloqueio usava `blockedReason` e levou a nota junto.
   */
  janelaFechada?: string | null;
  /**
   * A caixa travada até alguém ASSUMIR a conversa (#3012).
   *
   * Entra pela MESMA porta do bloqueio de canal (`isDisabled`), e não por um
   * segundo caminho: o que trava o campo, o envio, o anexo, o emoji, o áudio e
   * a resposta rápida é o de sempre. A diferença é a origem — não é o canal nem
   * o contato, é uma regra da organização que já vem resolvida de fora
   * (`composerBloqueadoAteAssumir`).
   *
   * Trava a caixa INTEIRA, nota interna inclusive. O corte da janela de 24h
   * separa a nota porque aquela regra é sobre o que CHEGA ao cliente; esta é
   * sobre começar o atendimento sem responsável, e uma nota escrita antes de
   * assumir organiza um atendimento que ainda não é de ninguém.
   */
  aguardandoAssumir?: boolean;
  /**
   * A mensagem que esta resposta CITA, quando o atendente escolheu responder
   * "em cima" de uma. `null` = envio solto, o caso comum.
   *
   * Vem de fora e não daqui porque quem escolhe é a lista de mensagens: o
   * composer só precisa mostrar o que foi escolhido e mandá-lo junto.
   */
  respondendo?: Pick<Message, "id" | "body" | "direction" | "type" | "metadata"> | null;
  /** Desfaz a escolha — o `x` da faixa de citação. */
  onCancelarResposta?: () => void;
  /** Nome do contato da conversa, para interpolar {{nome}}/{{primeiro_nome}} do template escolhido. */
  contactName?: string | null;
  /**
   * Rótulo do canal (`contacts.display_name`), fallback quando `contactName`
   * é vazio (issue #2744). Contato criado pela ingestão do canal ainda não tem
   * `name` gravado, e o template não podia mandar `{{nome}}` literal pro cliente.
   */
  contactDisplayName?: string | null;
  /** Contato da conversa — excluído do seletor de cartão compartilhado. */
  currentContactId?: string | null;
  /**
   * Texto sugerido por integração (issue #1611). O texto em si já vem em
   * `initialDraft` (é ele que preenche o campo); aqui vêm o AVISO de origem e o
   * `draft_id` que o consumo usa depois do clique.
   */
  rascunho?: AvisoDeRascunho | null;
  /**
   * O usuário logado (#3282). A barra de recursos lembra o recolhimento POR
   * usuário, e a chave da memória precisa do id. Vem de fora (o `InboxLayout`
   * tem o `user` do `AuthProvider`) para o compositor não ganhar uma dependência
   * de auth só por causa de uma preferência de tela.
   */
  usuarioId?: string | null;
  /**
   * Abre OUTRA conversa do mesmo contato (#3732).
   *
   * A recusa do envio pode dizer que a conversa continua em outra conversa —
   * a do número de quem está respondendo. Sem esta porta a pessoa leria a frase
   * e teria que procurar a conversa na lista; com ela, a caixa de resposta trava
   * e o botão leva direto para lá.
   */
  onAbrirConversa?: (id: string) => void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    conversationId,
    initialDraft = "",
    initialMode = "reply",
    active = true,
    onDraftChange,
    disabled,
    blockedReason,
    janelaFechada,
    aguardandoAssumir = false,
    contactName,
    contactDisplayName,
    currentContactId,
    respondendo,
    onCancelarResposta,
    rascunho = null,
    usuarioId = null,
    onAbrirConversa,
  },
  ref,
) {
  const t = useT();
  const [text, setText] = useState(initialDraft);
  // O aviso some no primeiro ENVIO: depois do clique o rascunho foi usado, e
  // deixar a faixa prometendo texto que já saiu seria mentira de tela.
  const [rascunhoUsado, setRascunhoUsado] = useState(false);
  /**
   * A FILA de anexos (#2526): o "+" escolhe uma, a resposta rápida traz as
   * várias que o operador carregou no template. Uma lista e não um arquivo é o
   * que permite o preview das duas antes de qualquer byte sair.
   *
   * É a MESMA fila que recebe a mídia de um recurso da barra (#2833): o clique
   * do recurso passa pelo `applyTemplate`, e imagem e áudio entram aqui — com
   * prévia e retry — em vez de um caminho próprio que perdia a imagem.
   */
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  /**
   * O ARRASTE DE ARQUIVO POR CIMA DO COMPOSITOR (#3708) — o realce, e o
   * CONTADOR que o sustenta.
   *
   * `arrastandoArquivo` é o que desenha. `arrasteEmCurso` existe porque
   * `dragenter`/`dragleave` disparam também ao passar sobre os FILHOS (o campo,
   * os botões, a faixa de citação): com um booleano solto, cada filho sob o
   * ponteiro apagava o realce e ele piscava o caminho inteiro — o mesmo defeito
   * que o campo de arquivo do card do funil tem hoje. Contar entradas e saídas
   * deixa o realce aceso enquanto o ponteiro estiver dentro, e só apaga quando o
   * contador volta a zero.
   *
   * `useRef` e não estado: o contador não desenha nada. Quem desenha é o
   * booleano, e um contador em estado re-renderizaria a cada filho atravessado.
   */
  const [arrastandoArquivo, setArrastandoArquivo] = useState(false);
  const arrasteEmCurso = useRef(0);
  /**
   * O texto da resposta rápida escolhida, guardado como LEGENDA.
   *
   * `null` no caminho do "+", onde a legenda nasce vazia; com o corpo
   * interpolado quando a escolha veio de um template com imagem — o texto não
   * pode estar nos dois lugares (campo E legenda), senão a mensagem sairia
   * duplicada.
   */
  const [legendaInicial, setLegendaInicial] = useState<string | null>(null);
  /**
   * O modo em que o arquivo foi ESCOLHIDO, congelado na escolha — e não o modo
   * em que o diálogo está aberto agora.
   *
   * Sem isto, um anexo escolhido em "Nota interna" que o operador troque para
   * "Responder" antes de clicar Enviar sairia pela rota de MENSAGEM: o arquivo
   * subiria em `whatsapp-media` e iria para o cliente. É exatamente o defeito
   * que a F3 da #1863 existe para não ter — e um dropdown de dois botões não
   * pode ser a única coisa entre um print interno e o celular da pessoa.
   */
  const [pendingEm, setPendingEm] = useState<"reply" | "note">("reply");
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mode, setMode] = useState<"reply" | "note">(initialMode);
  /**
   * Menção de atendente (#2372) — e o motivo de ser quatro estados.
   *
   * `caret` porque o gatilho `@` é relativo à POSIÇÃO do cursor, não ao fim do
   * texto: `@` no meio da frase tem de abrir a lista ali, e a inserção troca
   * o trecho dali pra frente.
   *
   * `mencoes` é o que foi ESCOLHIDO na lista. O campo mostra o nome
   * (`@Ana Lima`); o id entra só quando o corpo sai da tela (`embutirMencoes`),
   * porque ninguém lê `@[Ana Lima](mencao:2f9c…)` enquanto escreve.
   *
   * `mencaoDispensada` (Esc) e `mencaoIndice` (setas) são o mesmo desenho do
   * slash-menu de sempre, para os dois menus não disputarem a mesma tecla.
   */
  const [caret, setCaret] = useState(initialDraft.length);
  const [mencoes, setMencoes] = useState<MencaoEscolhida[]>([]);
  const [mencaoDispensada, setMencaoDispensada] = useState(false);
  const [mencaoIndice, setMencaoIndice] = useState(0);
  /**
   * A CONVERSA QUE CONTINUA (#3732) — a recusa do envio com destino.
   *
   * Guarda a conversa em que a recusa aconteceu junto com o aviso: o compositor
   * NÃO é remontado ao trocar de conversa sem rascunho (a `key` do
   * `InboxLayout`), e um aviso da conversa anterior travaria a caixa da
   * seguinte. Com o id aqui, a faixa só vale para a conversa que a produziu.
   */
  const [continua, setContinua] = useState<{
    conversationId: string;
    conversaId: string;
    modelo: string;
    nome: string | null;
  } | null>(null);
  const continuaAqui = continua?.conversationId === conversationId ? continua : null;
  useEffect(() => {
    onDraftChange?.(text, mode);
  }, [text, mode, onDraftChange]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const createNote = useCreateNote();
  const templates = useMessageTemplates();
  // Os GRUPOS (#3245) — vazio é o caso de quem nunca criou grupo, e aí a barra
  // e o slash-menu são exatamente os de antes.
  const grupos = useGruposDeRespostas();
  const slash = resolveSlash(text);
  // O Esc/escolha vale só para o `/` em curso: saiu do `/` por QUALQUER caminho
  // (digitado ou escrito pelo `applyTemplate`, inclusive o clique da barra com o
  // campo vazio), o próximo `/` volta a abrir o menu.
  if (menuDismissed && !slash.open) setMenuDismissed(false);
  const menuOpen = mode === "reply" && slash.open && !menuDismissed;

  /**
   * QUAL DAS DUAS FORMAS DA ASSISTÊNCIA APARECE (issue #3027).
   *
   * O `ReplyReviewPanel` era montado SEMPRE em modo resposta — com borda, título
   * "Assistência do agente" e o botão "Sugerir resposta" —, mesmo sem sugestão
   * nenhuma, e comia 2-3 linhas do histórico da conversa em tela de notebook.
   *
   * O sinal de "há sugestão" é o MESMO que o painel já usava para escolher o
   * texto (`sugestaoParaMostrar`): a consulta é uma só, com uma chave só, lida
   * pelos dois (ver `hooks/inbox/useRascunhoAssistido.ts`). Não há um segundo
   * estado para divergir do primeiro.
   *
   * `mode === "reply"`: em nota o compositor não oferece sugestão de resposta, e
   * a consulta nem sai.
   *
   * `!blockedReason`: compositor bloqueado (suporte somente leitura, papel sem
   * escrita) devolve só o aviso, lá embaixo — e antes o painel, que fazia esta
   * consulta, nem chegava a montar. Com a consulta aqui em cima ela sairia mesmo
   * assim, a cada 4s, e o `GET` exige papel `agent`: 403 em loop para quem só lê.
   */
  const { sugestao, invalidar } = useRascunhoAssistido(
    conversationId,
    mode === "reply" && !blockedReason,
  );

  /**
   * O contato da conversa, do jeito que a interpolação e o gate do curinga
   * (#2744) precisam: o `name` do CRM e o `display_name` do canal. Um objeto,
   * um lugar — o `applyTemplate` e a trava leem da MESMA fonte.
   */
  const contato: TemplateContact = {
    name: contactName ?? null,
    displayName: contactDisplayName ?? null,
  };

  // SÓ em nota: a menção é assunto interno, e uma menção no campo de resposta
  // sairia para o cliente como texto solto. A query roda enquanto a lista está
  // aberta — fechou o `@`, não há porque ir buscar os atendentes.
  const gatilho = mode === "note" && !mencaoDispensada ? resolverMencao(text, caret) : null;
  const membros = useAssignableMembers(gatilho !== null);
  const opcoes = gatilho ? opcoesDeMencao(membros.data ?? [], gatilho.query, t) : [];
  const mencaoAberta = gatilho !== null;
  const opcaoAtual = opcoes[mencaoIndice] ?? opcoes[0];

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  // send/createNote fora do disable: o texto some na hora do envio; travar o campo
  // até a API voltar impedia digitar a próxima mensagem com o campo ainda cheio.
  // `aguardandoAssumir` (#3012) entra AQUI, no mesmo lugar: um termo a mais na
  // trava de sempre, nunca um desabilitar paralelo que pudesse divergir dela.
  const isDisabled =
    disabled || !!blockedReason || upload.isPending || aguardandoAssumir || continuaAqui !== null;
  // A janela só alcança o que SAI. Em modo nota o composer segue liberado: a
  // nota interna nunca chega ao cliente, e é onde o atendente registra por que
  // a conversa esfriou — barrá-la tira exatamente o que ainda dá para fazer.
  const respostaBarrada = isDisabled || (mode === "reply" && !!janelaFechada);

  /**
   * O QUE O DROP ACEITA — a MESMA guarda do Ctrl+V e do botão de anexar (#3708).
   *
   * `respostaBarrada` é o `disabled` do `AttachMenu` e a primeira condição do
   * `onPaste`; `pendingFiles.length > 0` é a outra — a colagem também recusa
   * enquanto a prévia está aberta, porque um segundo anexo substituiria em
   * silêncio o que o operador já escolheu. Um `drop` com regra própria seria a
   * forma mais fácil de furar o bloqueio até assumir (#3012): o botão
   * `disabled` não impede um arquivo de ser solto em cima do compositor.
   */
  const aceitaArquivoArrastado = !respostaBarrada && pendingFiles.length === 0;

  /**
   * O RASCUNHO QUE JÁ ESTÁ NO CAMPO (#3354).
   *
   * A barra de respostas rápidas entrega o recurso ao MESMO `applyTemplate` do
   * `/` — e o `applyTemplate` SUBSTITUI o campo (`escreverNoCampo`) ou, com
   * mídia que aceita legenda, o ZERA. Com uma frase escrita, um clique apagava
   * o que o atendente tinha digitado, sem aviso e sem desfazer. Aqui a barra
   * passa a ficar desligada enquanto houver rascunho, e o botão diz por quê.
   *
   * O `/` em curso NÃO conta: o menu só abre quando o campo inteiro é o comando
   * (`resolveSlash`), e o que ele troca é o próprio `/consulta` — quem digitou
   * uma frase jamais chega lá com o menu aberto. É a mesma régua do menu, e não
   * `startsWith("/")`: um rascunho como `/ola, tudo bem?` tem espaço e continua
   * sendo rascunho.
   *
   * Sem o termo `!respostaBarrada` a dica erraria a mão: com a janela de 24h
   * fechada e um texto sugerido por integração (#1611) no campo, ela mandaria
   * apagar um rascunho que o campo travado não deixa apagar. Ali o motivo é
   * outro, e o `title` continua o de sempre.
   */
  const rascunhoNoCampo = !respostaBarrada && text.trim() !== "" && !slash.open;

  /**
   * O curinga literal (#2744, opção A) — um SINAL IRMÃO do `janelaFechada`, e
   * não um termo a mais no `respostaBarrada`.
   *
   * A diferença é o CAMPO: `respostaBarrada` desabilita o `<textarea>` (a janela
   * fechada não tem o que editar), mas o curinga literal PEDE edição — o motivo
   * que a faixa mostra é "edite antes de enviar". Travar o campo aqui seria
   * negar a própria instrução. Então só o ENVIO é barrado; o operador continua
   * digitando, apaga o `{{nome}}` e manda.
   *
   * Só em RESPOSTA: a nota interna nunca chega ao cliente e passa — a mesma
   * fronteira do `janelaFechada`. Contato com nome não entra (o curinga resolve);
   * `{{codigo}}` cru também não (chave desconhecida não é problema de nome).
   */
  const motivoCuringa = mode === "reply" ? motivoDoCuringaLiteral(text, contato) : null;
  // O que trava o ENVIO: o de sempre, mais o curinga. O que trava o CAMPO
  // (`respostaBarrada`) NÃO recebe o curinga — ver acima.
  const envioBarrado = respostaBarrada || !!motivoCuringa;

  /**
   * Escolhe os arquivos e MARCA o modo da escolha (ver `pendingEm`).
   *
   * UMA função para os três gestos — o clique do "+", a imagem colada e o
   * arquivo arrastado (#3708). É por ela que a fila de anexos do #2526 recebe,
   * e é isso que mantém limite de tamanho, tipo aceito, prévia, legenda e retry
   * idênticos nos três: um segundo caminho de upload divergiria no dia em que um
   * dos dois mudasse (foi o que o #3151 já pagou uma vez).
   *
   * Lista e não arquivo solto porque o `drop` pode trazer vários de uma vez e a
   * fila já sabe enviá-los em sequência com a legenda no primeiro que a aceita.
   */
  function escolherArquivos(files: File[]) {
    if (!files.length) return;
    setPendingFiles(files);
    setLegendaInicial(null);
    setPendingEm(mode);
  }

  /** A escolha de UM arquivo — o menu "+" e a imagem colada chamam por aqui. */
  function escolherArquivo(file: File) {
    escolherArquivos([file]);
  }

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  /**
   * Escolhe da lista e escreve o NOME no campo (`@Ana Lima `) — o id entra só
   * na hora de salvar (`embutirMencoes`), porque é o nome que quem digita lê.
   *
   * A posição vem do `gatilho`, não do fim do texto: o `@` pode estar no meio
   * da frase, e o que se troca é do `@` até o cursor.
   */
  function escolherMencao(opcao: OpcaoDeMencao): void {
    const gatilhoAqui = resolverMencao(text, caret);
    if (!gatilhoAqui) return;
    const inserido = `@${opcao.rotulo} `;
    setText(text.slice(0, gatilhoAqui.start) + inserido + text.slice(caret));
    setMencoes((atual) => [...atual, { id: opcao.membro.user_id, nome: opcao.rotulo }]);
    const pos = gatilhoAqui.start + inserido.length;
    setCaret(pos);
    setMencaoIndice(0);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      autoresize();
    });
  }

  function handleSubmit() {
    const legivel = text.trim();
    if (!legivel || (mode === "note" ? isDisabled : envioBarrado)) return;

    // A menção vira token AQUI, na saída do campo (#2372): o que fica no
    // rascunho, no `onDraftChange` e no `restoreOnError` é o nome legível, e
    // o id só viaja no corpo que sai para o banco. Em modo RESPOSTA não há
    // token nenhum — menção é assunto de nota interna, e uma menção no campo
    // de resposta sairia para o cliente.
    // O curinga DIGITADO interpola como o template aplicado (#2891): quem escreve
    // `{{primeiro_nome}}` à mão quer o nome do cliente, não o token cru — e até
    // 14/10/2026 esse texto saía literal para o contato, sem faixa e com o
    // Enviar habilitado. A fonte é a MESMA do `applyTemplate` e da trava: o
    // `contato` montado uma linha acima, e a MESMA `interpolateTemplate`. Só a
    // RESPOSTA passa por aqui: a nota interna não vai ao cliente e continua
    // levando o texto como escrito (fronteira do `janelaFechada`, #2744).
    const corpo =
      mode === "note" ? embutirMencoes(legivel, mencoes) : interpolateTemplate(legivel, contato);

    setText("");
    requestAnimationFrame(() => autoresize());

    // Se a pessoa já começou a próxima resposta, preserve os dois textos.
    const restaurar = (current: string) => (current ? `${legivel}\n${current}` : legivel);
    const restoreOnError = () => {
      setText(restaurar);
      requestAnimationFrame(() => autoresize());
    };
    // As escolhas DESTA nota, guardadas no envio: o campo segue editável
    // durante o envio, e a 1ª tecla poda `mencoes` contra um texto que já não
    // tem o `@Nome` enviado. Sem isto, o retry voltava sem o id e saía como
    // texto puro (com homônimos, avisando os dois).
    const mencoesEnviadas = mencoes;

    if (mode === "note") {
      createNote.mutate(
        { conversation_id: conversationId, body: corpo },
        {
          onError: () => {
            restoreOnError();
            // Na FRENTE das atuais: o texto enviado volta antes do novo, e o
            // `embutirMencoes` pareia ocorrência e escolha por ordem.
            const restaurado = restaurar(taRef.current?.value ?? "");
            setMencoes((atual) =>
              podarMencoes(restaurado, [...mencoesEnviadas, ...atual.filter((m) => !mencoesEnviadas.includes(m))]),
            );
          },
          // Só depois de gravar, e só as escolhas DESTA nota — a lista pode já
          // ter a menção da PRÓXIMA, escolhida enquanto esta ainda estava no ar
          // (`mencoesEnviadas`): zerar tudo apagava a escolha dela, e a nota
          // seguinte sairia como texto puro (com homônimos, avisando os dois).
          onSuccess: () =>
            setMencoes((atual) => atual.filter((m) => !mencoesEnviadas.includes(m))),
        },
      );
      return;
    }
    send.mutate(
      {
        conversation_id: conversationId,
        body: corpo,
        type: "text",
        ...(respondendo ? { reply_to_message_id: respondendo.id } : {}),
      },
      {
        onSuccess: () => {
          // A citação vale para UMA mensagem. Mantê-la depois do envio faria a
          // próxima frase sair citando algo que o atendente já respondeu.
          onCancelarResposta?.();
          consumirRascunhoEnviado();
          // #3732: a trava da conversa que continua cai quando o envio volta a
          // ser aceito (o número mudou, ou alguém mexeu na conversa).
          setContinua(null);
          requestAnimationFrame(() => autoresize());
        },
        // Do upstream, e fica: sem isto o texto some quando o envio falha, e
        // quem escreveu um parágrafo o perde sem ter como recuperá-lo.
        //
        // #3732: e quando a recusa é "esta conversa está no número de outro
        // atendente", a faixa diz PARA ONDE IR e trava a caixa — a frase
        // sozinha mandava transferir uma conversa que já é de quem está aqui.
        onError: (erro) => {
          restoreOnError();
          const aviso = erro instanceof ApiError ? avisoDaContinua(erro.code, erro.details) : null;
          if (aviso) setContinua({ conversationId, ...aviso });
        },
      },
    );
  }

  /**
   * Marca o rascunho como usado — só depois do ENVIO humano dar certo.
   *
   * Fire-and-forget de propósito: o texto já saiu, e a falha do consumo não pode
   * virar erro de envio. O aviso some na mesma hora (estado local), porque a
   * proposta é de uso único: repetir a dica depois do clique seria encher a tela
   * de alguém que já leu.
   */
  function consumirRascunhoEnviado(): void {
    const leitura = rascunho?.leitura;
    if (rascunhoUsado || leitura?.estado !== "sugerido") return;
    setRascunhoUsado(true);
    void apiClient
      .post(`/api/v1/conversations/${conversationId}/drafts/consume`, {
        draft_id: leitura.draftId,
      })
      .catch(() => {
        /* silêncio: ver docstring */
      });
  }

  /**
   * Escreve no campo e poe o cursor no fim — o de sempre, isolado para reuso.
   *
   * `focar: false` existe para quem devolve texto com o diálogo de anexos
   * ABERTO (#3151): o foco pertence ao diálogo, e puxá-lo para o textarea que
   * está atrás dele tiraria do operador o Esc e o Enter da prévia.
   */
  function escreverNoCampo(conteudo: string, focar = true) {
    setText(conteudo);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      if (focar) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = conteudo.length;
      }
      autoresize();
    });
  }

  /**
   * A escolha de um recurso na barra (#2833) — o MESMO caminho do `/`.
   *
   * Não existe plano próprio da barra: o recurso é entregue ao `applyTemplate`,
   * que já separa as duas naturezas — texto cai no campo editável, e mídia
   * (imagem OU áudio) entra na fila de anexos com o corpo como legenda. Era o
   * caminho próprio que perdia a imagem do recurso. Nada é enviado aqui: é o
   * critério central da issue, e o teste o cobre.
   */
  function escolherRecurso(recurso: Recurso) {
    void applyTemplate(recurso);
  }

  /**
   * Baixa os BYTES de uma imagem do template (#2526).
   *
   * Pela própria origem (`/midias/:indice` devolve o corpo, não um 302): o
   * compositor precisa do `Blob` para montar o `File` que o envio de mídia
   * consome, e um redirect cruzaria a origem dependendo do CORS do bucket —
   * que, em self-host, é do operador e não nosso.
   */
  async function arquivoDaMidia(
    templateId: string,
    midia: MidiaDeTemplate,
    indice: number,
  ): Promise<File> {
    const res = await fetch(`/api/v1/message-templates/${templateId}/midias/${indice}`);
    if (!res.ok) throw new ApiError(res.status, "midia_indisponivel", undefined, "", "");
    const blob = await res.blob();
    const nome = midia.storage_path.split("/").pop() ?? `imagem-${indice + 1}`;
    // O tipo sai do CAMINHO (que a rota de upload escolheu pelos bytes), não
    // do `media_mime` da linha, que é texto livre gravado pelo PATCH.
    return new File([blob], nome, { type: mimeDaMidia(midia.storage_path) });
  }

  /**
   * Escolhe a resposta rápida (#2526) — e é o MESMO caminho da barra de recursos
   * (#2833): o `/` e a barra entregam o recurso AQUI, um caminho só.
   *
   * SÓ TEXTO continua sendo o de sempre, byte por byte: o corpo interpolado
   * vai para o campo. Com IMAGEM, o texto sai como legenda da primeira imagem
   * e as imagens entram na fila de anexos — texto + mídia numa única mensagem
   * editável, que é o que a issue pede e o que o envio de mídia já faz. Nada
   * aqui cria caminho de envio novo: a saída é o `useUploadMedia` +
   * `useSendMessage` de sempre, então canal, janela, opt-out, limite e retry
   * continuam valendo exatamente como estão.
   *
   * Baixar os bytes NA ESCOLHA (e não na hora de enviar) é o que permite
   * preview: sem o Blob não há o que mostrar, e o operador só poderia aprovar
   * às cegas.
   *
   * COMBINAÇÕES (#3009) não abriram caminho nenhum: imagem e áudio entram na
   * MESMA fila, na ordem gravada, e o texto vira legenda do primeiro anexo que
   * a aceita (imagem sim, áudio não — #3151). Era o que faltava para existir
   * texto+áudio e imagem+áudio: o áudio deixou de ser um modo do cadastro, e
   * não precisou de transporte próprio aqui.
   */
  async function applyTemplate(template: Recurso) {
    // A RÉGUA, antes de qualquer efeito (#3009): uma resposta rápida sem
    // conteúdo nenhum (corpo em branco e nenhuma mídia) escreveria string vazia
    // no campo e deixaria o operador achando que escolheu algo. O motivo é da
    // régua — o mesmo que a barra mostra no `title` do botão e que o cadastro
    // recusa ao salvar; aqui ele vira aviso, porque o clique não pode acontecer
    // e sair em silêncio.
    const leitura = lerRespostaRapidaGravada(template);
    if (!leitura.ok) {
      setMenuDismissed(true);
      toast.error(t(leitura.motivo));
      return;
    }

    const payload = payloadDeUso(template, contato);
    setMenuDismissed(true);

    // O contato sem `name` NEM `display_name` (#2744): o `{{nome}}` sobrevive
    // literal no corpo e iria pro cliente como `{{nome}}`. O toast é o primeiro
    // aviso; a faixa persistente (mais abaixo) é o que fica, porque o operador
    // precisa editar antes de mandar.
    if (motivoDoCuringaLiteral(template.body, contato)) {
      toast.warning(
        t("Contato sem nome no CRM: {{nome}}/{{primeiro_nome}} ficaram literais no texto. Edite antes de enviar."),
      );
    }

    // `respostaBarrada` cobre a resposta barrada (janela fechada, canal
    // bloqueado) — enfileirar um upload que o dispatcher vai recusar deixaria
    // arquivo órfão no bucket. O texto segue no campo, como sempre esteve.
    if (!payload.midias.length || respostaBarrada) {
      escreverNoCampo(payload.texto);
      return;
    }

    try {
      const arquivos = await Promise.all(
        payload.midias.map((midia, indice) => arquivoDaMidia(template.id, midia, indice)),
      );
      setPendingEm("reply");
      setPendingFiles(arquivos);
      // Áudio NÃO leva legenda em nenhum adaptador de canal
      // (#3151): sem anexo na fila que a
      // leve, o corpo volta para o CAMPO em vez de virar legenda de um áudio
      // que a descarta — o texto continua na tela, para o operador mandar como
      // mensagem. Com anexo que a leve (imagem, vídeo, documento), o texto sai
      // do campo e vira a legenda dele, como sempre.
      if (arquivos.some(anexoLevaLegenda)) {
        setLegendaInicial(payload.texto);
        setText("");
      } else {
        setLegendaInicial(null);
        // Sem foco: o diálogo de prévia está abrindo POR CIMA do campo.
        escreverNoCampo(payload.texto, false);
      }
    } catch (erro) {
      // Sem os bytes não há prévia nem envio. O caminho honesto é o de texto,
      // com o aviso de que a imagem não veio — sumir em silêncio seria entregar
      // metade do template sem ninguém perceber.
      showApiError(erro);
      escreverNoCampo(payload.texto);
    }
  }

  /**
   * A FILA de anexos (#2526) — e ela é um laço, não um tiro.
   *
   * Cada arquivo sobe pelo `useUploadMedia` e sai pelo `useSendMessage` /
   * `useCreateNote` de sempre; só o PRIMEIRO anexo que ACEITA legenda leva o
   * texto — o mesmo contrato de "texto + mídia numa mensagem" que o envio de
   * mídia já pratica. Não é sempre o índice 0 (#3151): numa fila [áudio,
   * imagem] o texto iria com o áudio e o canal o descartaria em silêncio.
   * A recursão entra pelo `onSuccess`, então uma falha INTERROMPE a fila e o
   * diálogo fica aberto para o retry — como já ficava no caminho de um arquivo.
   */
  function enviarAnexos(caption: string, indice = 0): void {
    const arquivo = pendingFiles[indice];
    if (!arquivo) {
      setPendingFiles([]);
      setLegendaInicial(null);
      return;
    }
    const destino: DestinoDoUpload = pendingEm === "note" ? "nota" : "mensagem";
    // `-1` (fila só de áudio) não casa com índice nenhum: a legenda não sai com
    // anexo algum, em vez de sair com um áudio que a descarta.
    const indiceLegenda = indiceDaLegenda(pendingFiles);
    const legenda =
      destino === "nota" ? caption : indice === indiceLegenda ? caption || undefined : undefined;
    void upload
      .mutateAsync({ conversationId, file: arquivo, destino })
      .then((uploaded) => {
        // Cada arquivo que SAIU deixa a fila, e a legenda com ele: se o
        // próximo falhar, o retry do diálogo recomeça do que falhou, sem
        // reenviar o que já foi nem repetir o texto (#2526, critério "falha
        // no envio da mídia não causa duplicação do texto"). Zerar a
        // `legendaInicial` é o que faz o diálogo repor a legenda VAZIA quando
        // a fila encolhe.
        const proximo = () => {
          setPendingFiles((fila) => fila.slice(1));
          setLegendaInicial(null);
          enviarAnexos(caption, indice + 1);
        };
        if (destino === "nota") {
          createNote.mutate(
            {
              conversation_id: conversationId,
              body: legenda ?? "",
              anexo: {
                storage_path: uploaded.storage_path,
                media_mime: uploaded.media_mime,
                media_size_bytes: uploaded.media_size_bytes,
              },
            },
            { onSuccess: proximo },
          );
          return;
        }
        send.mutate(
          {
            conversation_id: conversationId,
            type: uploaded.kind,
            body: legenda,
            media_storage_path: uploaded.storage_path,
            media_mime: uploaded.media_mime,
            media_size_bytes: uploaded.media_size_bytes,
          },
          { onSuccess: proximo },
        );
      })
      .catch(() => {
        // toast já disparado pelo onError de useUploadMedia; diálogo fica aberto p/ retry
      });
  }

  /**
   * Ctrl/Cmd+V com imagem no clipboard cai no MESMO caminho do menu "+":
   * abre o preview com legenda e envia por ali. Nada de atalho paralelo — a
   * validação, o toast de erro e o retry já vivem lá.
   *
   * As DUAS guardas antes de olhar o clipboard não são zelo: com um anexo já em
   * preview a colagem substituiria em silêncio o que o operador escolheu, e
   * desabilitado é desabilitado. Em qualquer um desses casos o Ctrl+V precisa
   * continuar sendo o Ctrl+V de sempre.
   *
   * O MODO saiu da guarda (#1863, F3): "Nota interna" passou a aceitar anexo,
   * e a imagem colada ali vira exatamente o mesmo preview de sempre — com o
   * modo congelado na escolha (`escolherArquivo`), para ela não escapar para o
   * cliente se o operador trocar de aba no meio. `respostaBarrada` já cobre os
   * dois modos: em nota ele é só `isDisabled` (a janela fechada barra a
   * RESPOSTA, e só ela — a nota continua sendo o lugar onde se registra por que
   * a conversa esfriou).
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (respostaBarrada || pendingFiles.length > 0) return;
    const imagem = imagemDoClipboard(e.clipboardData, new Date());
    if (!imagem) return; // colagem de texto segue o caminho normal do browser
    e.preventDefault();
    escolherArquivo(imagem);
  }

  /**
   * O ARRASTE CARREGA ARQUIVO? (#3708)
   *
   * Arrastar texto selecionado, um link ou um trecho de dentro da própria
   * página também dispara `dragenter`/`dragover`/`drop` aqui — sem esta
   * pergunta, soltar uma frase em cima do compositor abriria uma prévia vazia
   * (ou pior, `preventDefault` no `dragover` impediria o `drop` de texto de
   * fazer o que o navegador faria). `types` só lista o que o arraste carrega,
   * nunca o conteúdo: é a checagem certa e a única disponível antes do drop.
   */
  function trazArquivo(e: DragEvent<HTMLElement>): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  /**
   * O `preventDefault` daqui é o que impede o navegador de ABRIR o arquivo —
   * trocando a conversa por um PDF na mesma aba, sem volta. Ele vale MESMO com
   * a caixa bloqueada: navegar para fora do atendimento é pior que recusar o
   * anexo, e a recusa silenciosa já é a regra do botão desabilitado.
   */
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!trazArquivo(e)) return;
    e.preventDefault();
    // O cursor diz o que o drop vai fazer antes de o operador soltar: "copiar"
    // com a caixa livre, "proibido" com ela travada (até assumir, janela
    // fechada, prévia já aberta).
    e.dataTransfer.dropEffect = aceitaArquivoArrastado ? "copy" : "none";
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!trazArquivo(e) || !aceitaArquivoArrastado) return;
    e.preventDefault();
    arrasteEmCurso.current += 1;
    setArrastandoArquivo(true);
  }

  /**
   * `dragleave` sem pergunta de tipo DE PROPÓSITO: alguns navegadores entregam
   * `types` vazio na saída, e um `return` cedo ali deixaria o realce preso na
   * tela. Descontar sempre é seguro — entrar só conta quando houve arquivo, e o
   * piso em zero impede que uma saída a mais (arraste que começou fora daqui)
   * derrube o contador abaixo do que a próxima entrada vai somar.
   */
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    arrasteEmCurso.current = Math.max(0, arrasteEmCurso.current - 1);
    if (arrasteEmCurso.current === 0) setArrastandoArquivo(false);
  }

  /**
   * SOLTOU — e o arquivo cai na MESMA fila de anexos do botão (#3708).
   *
   * Nada de envio aqui: `escolherArquivos` abre a prévia, como o clique, e quem
   * sobe o byte é o `enviarAnexos` de sempre. É o que mantém canal, janela,
   * limite de tamanho e retry iguais aos do "+", e o que faz o drop respeitar
   * `aceitaArquivoArrastado` em vez de furar o bloqueio por uma porta nova.
   *
   * `stopPropagation`: se um dia a tela da conversa também ouvir `drop`, o
   * arquivo solto no campo não pode ser tratado duas vezes — e soltar sobre uma
   * mensagem da lista continua sem anexar em conversa nenhuma.
   */
  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!trazArquivo(e)) return;
    e.preventDefault();
    e.stopPropagation();
    arrasteEmCurso.current = 0;
    setArrastandoArquivo(false);
    if (!aceitaArquivoArrastado) return;
    escolherArquivos(Array.from(e.dataTransfer?.files ?? []));
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && menuOpen) {
      setMenuDismissed(true);
      return;
    }
    // A lista de menções come as teclas ANTES do Enter salvar — a mesma lei
    // do slash-menu: com o menu aberto, Enter escolhe, não envia.
    if (mencaoAberta) {
      if (e.key === "Escape") {
        setMencaoDispensada(true);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMencaoIndice((i) => (opcoes.length ? (i + 1) % opcoes.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMencaoIndice((i) => (opcoes.length ? (i - 1 + opcoes.length) % opcoes.length : 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (opcaoAtual) escolherMencao(opcaoAtual);
        return;
      }
      // Tab só é intercepted quando HÁ o que escolher: sem opção, o Tab tem de
      // continuar Tab — prender o foco num menu vazio é teclado sequestrado.
      if (e.key === "Tab" && opcaoAtual) {
        e.preventDefault();
        escolherMencao(opcaoAtual);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (menuOpen) {
        e.preventDefault(); // deixa o Enter pro menu; não envia /query como mensagem
        return;
      }
      // No toque, a tecla de retorno do teclado virtual QUEBRA LINHA, como no
      // próprio WhatsApp — quem envia é o botão. Ctrl/Cmd+Enter envia sempre
      // (iPad com teclado físico). Lido aqui, no keydown, e não no render: o
      // servidor não sabe o ponteiro, e ler no render faria as duas pontas
      // desenharem coisas diferentes.
      const forcaEnvio = e.ctrlKey || e.metaKey;
      if (!forcaEnvio && window.matchMedia?.("(pointer: coarse)").matches) return;
      e.preventDefault();
      handleSubmit();
    }
  }

  if (blockedReason) {
    return (
      <div className="border-t border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
        {blockedReason}
      </div>
    );
  }

  return (
    <>
      <div
        data-testid="composer"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "relative border-t border-border bg-background px-3 py-2",
          mode === "note" && "border-warning/40 bg-warning-bg",
        )}
      >
        {/* O REALCE DO ARRASTE (#3708) — a única coisa que o operador vê antes
            de soltar o arquivo. Sem ele, o gesto não tem confirmação nenhuma:
            solta, a prévia abre, mas ninguém sabia que aquele espaço aceitava
            arquivo. `pointer-events-none` porque a camada cobre justamente a
            área que precisa receber o `drop`; com eventos, ela interceptaria os
            `dragleave` dos filhos e o contador nunca fecharia. */}
        {arrastandoArquivo && (
          <div
            data-testid="arraste-de-arquivo"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-sm border-2 border-dashed border-primary bg-primary/10 px-3 text-center text-xs font-medium text-primary"
          >
            {t("Solte o arquivo para anexar")}
          </div>
        )}
        {/* A CONVERSA CONTINUA EM OUTRO NÚMERO (#3732) — a faixa que diz PARA
            ONDE IR. Ela nasce da recusa do envio (409 do número de outro
            atendente) e só aparece quando o servidor apontou a conversa que
            continua: a frase de antes mandava transferir uma conversa que já é
            de quem está tentando responder. Com a faixa de pé, a caixa fica
            travada (é o `isDisabled` de sempre) e o botão leva à conversa nova,
            onde a resposta sai. */}
        {continuaAqui && (
          <div
            role="status"
            data-testid="conversa-continua-em-outro-numero"
            className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-warning/40 bg-warning-bg px-3 py-2 text-xs"
          >
            <span>{t(continuaAqui.modelo).replace("{nome}", continuaAqui.nome ?? "")}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAbrirConversa?.(continuaAqui.conversaId)}
            >
              {t("Abrir a conversa")}
            </Button>
          </div>
        )}
        {/* O BLOCO DA ASSISTÊNCIA SÓ COM SUGESTÃO (issue #3027): sem rascunho
            para mostrar, ele não é montado e não ocupa faixa nenhuma; o botão de
            ícone (`DraftReplyButton`), que é o mesmo gesto, fica na linha de
            ações do compositor (ver abaixo). Com sugestão, o bloco aparece
            inteiro, como sempre — e sai quando ela é enviada ou descartada.
            Com o teclado virtual aberto, a sugestão sai da frente (F2): sobram
            ~250px de tela num iPhone, e o fio da conversa vale mais que ela. O
            marcador é da camada da conversa (`useAlturaVisivel`), e o `max-md:`
            mantém o computador intacto. */}
        {mode === "reply" && sugestao && (
          <div className="max-md:group-data-[teclado-aberto]/conversa:hidden">
            <ReplyReviewPanel conversationId={conversationId} disabled={isDisabled} />
          </div>
        )}
        <TemplateMenu
          open={menuOpen}
          query={slash.query}
          templates={templates.data ?? []}
          grupos={grupos.data ?? []}
          onPick={applyTemplate}
          onClose={() => setMenuDismissed(true)}
        />
        {/* A LISTA DE ATENDENTES (#2372) — só em nota, só enquanto o `@` está
            aberto. O MESMO canto do slash-menu, que só existe em resposta: os
            dois nunca aparecem juntos. */}
        <MentionMenu
          open={mencaoAberta}
          opcoes={opcoes}
          indice={opcaoAtual ? opcoes.indexOf(opcaoAtual) : 0}
          onPick={escolherMencao}
        />
        {/* O AVISO DO RASCUNHO SUGERIDO (issue #1611) — acima dos modos, sempre
            que a resposta está liberada. Nada aqui envia: a faixa só diz de onde
            veio o texto que já está no campo (e, quando o rascunho não vale
            mais, por que o campo está vazio). */}
        {rascunho && !rascunhoUsado && mode === "reply" && (
          <div
            data-testid="aviso-rascunho"
            className="mb-1.5 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5 text-xs"
          >
            <p className="min-w-0 flex-1 text-muted-foreground">
              {rascunho.leitura.estado === "sugerido" ? (
                <>
                  {t("Texto sugerido por")}{" "}
                  <span className="font-medium text-foreground">{rascunho.leitura.origem}</span>.{" "}
                  {t("Revise antes de enviar.")}
                </>
              ) : (
                avisoDeRascunhoIndisponivel(rascunho.leitura.motivo, t)
              )}
            </p>
          </div>
        )}
        {/* O AVISO DO CURINGA LITERAL (#2744) — visível e PERSISTENTE, e não só
            o toast que some. Vale para o texto DIGITADO, não só para o modelo
            aplicado: quem escreveu `{{primeiro_nome}}` na mão precisa ver por
            que o botão não manda, junto da borda do compositor. Só em RESPOSTA
            (modo nota passa), e só com o literal sobrevivente — contato com
            nome resolve o curinga e não vê aviso nenhum. */}
        {motivoCuringa && (
          <div
            data-testid="aviso-curinga-literal"
            className="mb-1.5 flex items-start gap-2 rounded-md border-l-2 border-warning bg-warning-bg px-2 py-1.5 text-xs text-warning-fg"
          >
            <p className="min-w-0 flex-1">
              {t("Contato sem nome no CRM: {{nome}}/{{primeiro_nome}} ficaram literais no texto. Edite antes de enviar.")}
            </p>
          </div>
        )}
        {/* O AVISO DO BLOQUEIO ATÉ ASSUMIR (#3012) — a caixa está travada e o
            motivo precisa estar junto dela, não só no botão lá em cima. A saída
            da regra é o "Assumir" do cabeçalho, que continua visível em todos os
            estados; esta faixa só diz o que fazer para voltar a escrever. */}
        {aguardandoAssumir && (
          <div
            data-testid="aviso-assumir"
            className="mb-1.5 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5 text-xs"
          >
            <p className="min-w-0 flex-1 text-muted-foreground">
              {t("Assuma esta conversa para responder.")}
            </p>
          </div>
        )}
        <div className="mb-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "min-h-11 rounded-full px-3 py-1 text-xs font-medium transition-colors lg:min-h-0 lg:px-2.5",
              mode === "reply"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Responder")}
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            className={cn(
              "min-h-11 rounded-full px-3 py-1 text-xs font-medium transition-colors lg:min-h-0 lg:px-2.5",
              mode === "note"
                ? "bg-warning text-warning-fg"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Nota interna")}
          </button>
        </div>
        {/*
          A FAIXA DA CITAÇÃO — o que o atendente escolheu responder.

          Fica ACIMA do campo, como no WhatsApp, e não dentro dele: o texto
          citado pode ter várias linhas, e empurrá-lo para dentro do campo faria
          o que se digita disputar espaço com o que se cita.

          `line-clamp-2` porque o objetivo é reconhecer qual mensagem é, não
          relê-la — ela está logo acima, no fio.
        */}
        {respondendo && mode === "reply" && (
          <div className="mb-1 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-primary">
                {respondendo.direction === "outbound" ? t("Você") : t("Cliente")}
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">
                {respondendo.type === "contact"
                  ? resolveSharedContact(respondendo)?.name || t("Contato")
                  : respondendo.body?.trim() || t("(sem texto)")}
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelarResposta}
              aria-label={t("Cancelar resposta")}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:size-auto lg:p-0.5"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        {/* A BARRA DE RECURSOS (#2833) — um botão por título cadastrado. O clique
            NÃO envia: entrega o recurso ao MESMO `applyTemplate` que o `/` usa.
            Texto cai no campo editável; mídia (imagem OU áudio) entra na fila de
            anexos, com prévia e legenda — não há barra de anexo própria. */}
        {mode === "reply" && (
          <BarraDeRecursos
            recursos={templates.data ?? []}
            grupos={grupos.data ?? []}
            disabled={respostaBarrada || rascunhoNoCampo}
            dica={
              rascunhoNoCampo
                ? t(
                    "A resposta rápida substitui o texto do campo. Envie ou apague o rascunho antes.",
                  )
                : undefined
            }
            onEscolher={escolherRecurso}
            usuarioId={usuarioId}
          />
        )}
        <div className="flex items-end gap-2">
          {/* O "+" existe nos DOIS modos desde a F3 da #1863: em "Nota interna"
              ele abre o mesmo menu, com as DUAS primeiras opções — foto/vídeo e
              documento — porque a nota passou a aceitar anexo. A terceira
              (Contato) some: cartão de contato é `type: "contact"`, uma MENSAGEM
              para o cliente, e nota com cartão de contato não existe. O `disabled`
              continua o de sempre: em modo nota `respostaBarrada` é só
              `isDisabled`, e a janela fechada barra a resposta, não a nota. */}
          <AttachMenu
            disabled={respostaBarrada}
            onPick={escolherArquivo}
            onPickContact={mode === "reply" ? () => setContactPickerOpen(true) : undefined}
          />
          <EmojiButton
            disabled={isDisabled}
            onPick={(emoji) => {
              const ta = taRef.current;
              if (!ta) {
                setText((t) => t + emoji);
                return;
              }
              const start = ta.selectionStart ?? text.length;
              const end = ta.selectionEnd ?? text.length;
              const next = text.slice(0, start) + emoji + text.slice(end);
              setText(next);
              requestAnimationFrame(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = start + emoji.length;
                autoresize();
              });
            }}
          />
          {/*
            O BOTÃO DE ÍCONE DA ASSISTÊNCIA (issue #3027) — "Sugerir resposta",
            o mesmo gesto do bloco, no lugar onde ele NÃO custa faixa nenhuma:
            junto do "+" e do emoji, na linha do campo.

            Os dois nunca aparecem juntos: com sugestão montada, o bloco traz o
            próprio botão de texto; sem sugestão, fica só este ícone. Ninguém
            escolhe entre dois botões iguais.

            O clique gera pelo MESMO `POST /conversations/:id/draft-reply` do
            bloco; o rascunho criado entra pelo `invalidateQueries` da chave
            compartilhada, e é isso que monta o bloco com o texto e as ações. O
            texto NÃO é despejado no campo: quem revisa e decide é o bloco, e ter
            o mesmo texto nos dois lugares diria duas vezes a mesma coisa.
          */}
          {mode === "reply" && !sugestao && (
            <DraftReplyButton
              conversationId={conversationId}
              disabled={isDisabled}
              onDraft={() => {
                void invalidar();
              }}
            />
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const pos = e.target.selectionStart ?? e.target.value.length;
              setCaret(pos);
              setMencaoIndice(0);
              // A escolha que sumiu do texto sai da lista AGORA (#2463): com
              // duas pessoas de mesmo rótulo, a escolha apagada roubava o
              // `@Nome` da próxima e a nota notificava quem não foi mencionado.
              //
              // Só na edição À MÃO, de propósito: o envio limpa o campo sem
              // passar por aqui, e é isso que mantém as menções valendo para o
              // retry depois de uma falha. Quem digita DURANTE o envio poda as
              // escolhas aqui — o `onError` da nota devolve as que foram enviadas.
              setMencoes((atual) => podarMencoes(e.target.value, atual));
              // Sumiu o `@` (apagou, ou o Enter escolheu): o Esc de uma vez
              // não pode travar a lista da PRÓXIMA menção.
              if (!resolverMencao(e.target.value, pos)) setMencaoDispensada(false);
              autoresize();
            }}
            // Seta e clique movem o cursor sem digitar: sem isto o `caret`
            // ficaria parado no fim e a lista abriria onde o texto não está.
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            // O atalho saiu do placeholder e foi para o diálogo de atalhos (`?`)
            // e para o `title` aqui. Dois motivos, nesta ordem: ele some assim
            // que se digita a primeira letra — isto é, some justamente quando
            // você ia quebrar linha —; e, com a coluna do inbox mais estreita
            // depois do conserto do layout, a frase quebrava em duas linhas
            // dentro de um campo de uma linha só.
            //
            // "(só o time vê)" FICA: não é atalho, é consequência. Quem escreve
            // uma nota interna precisa saber que ela não vai para o cliente, e
            // essa informação não pode depender de abrir um diálogo.
            placeholder={
              mode === "note"
                ? t("Escreva uma nota interna… (só o time vê)")
                : t("Escreva uma mensagem…")
            }
            title={
              mode === "note"
                ? t("Enter salva a nota · Shift+Enter quebra linha")
                : t("Enter envia · Shift+Enter quebra linha")
            }
            className={cn(
              // 16px abaixo do `md`: o Safari do iPhone AMPLIA a página ao focar
              // campo com fonte menor, e a conversa sai do quadro. 44px de alvo
              // até o `lg`, como o resto dos botões de toque.
              "max-h-40 min-h-11 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm lg:min-h-9",
              "placeholder:text-muted-foreground focus:ring-1 focus:ring-ring focus:outline-hidden",
            )}
            disabled={mode === "note" ? isDisabled : respostaBarrada}
            aria-label={t("Mensagem")}
          />
          {text.trim() || mode === "note" ? (
            <Button
              type="button"
              size="icon"
              className="shrink-0"
              onClick={handleSubmit}
              disabled={(mode === "note" ? isDisabled : envioBarrado) || !text.trim()}
              aria-label={t("Enviar")}
            >
              <PaperPlaneTilt size={16} weight="fill" aria-hidden />
            </Button>
          ) : (
            active && <AudioRecorder conversationId={conversationId} disabled={respostaBarrada} />
          )}
        </div>
      </div>
      <AttachmentPreviewDialog
        files={pendingFiles}
        legendaInicial={legendaInicial}
        notaInterna={pendingEm === "note"}
        sending={upload.isPending || send.isPending || createNote.isPending}
        onCancel={() => {
          const devolver = legendaInicial;
          setPendingFiles([]);
          setLegendaInicial(null);
          // Cancelar a prévia DEVOLVE o texto ao campo (#2526): ele estava ali
          // como legenda da imagem que não vai sair, e sumir com o que o
          // operador acabou de decidir não enviar seria perder a única cópia do
          // texto escolhido no menu.
          if (devolver) escreverNoCampo(devolver);
        }}
        onRemove={(indice, caption) => {
          const resto = pendingFiles.filter((_, i) => i !== indice);
          // Sobra SEM anexo que leve legenda — fila vazia ou só de áudio — é
          // nada a legendar: o texto volta para o campo, como no cancelar, para
          // o que o operador escreveu não sumir junto com o último anexo que o
          // levaria (#3151). Tirar a imagem de uma fila [imagem, áudio] é
          // exatamente este caminho. Na NOTA o texto é o corpo dela e vale com
          // áudio também: só a fila vazia o devolve.
          if (resto.length === 0 || (pendingEm !== "note" && indiceDaLegenda(resto) === -1)) {
            setPendingFiles(resto);
            setLegendaInicial(null);
            // Sem foco: o diálogo continua ABERTO com o áudio que sobrou.
            if (caption) escreverNoCampo(caption, false);
            return;
          }
          // A legenda editada sobrevive à troca da fila (o diálogo a repõe a
          // partir de `legendaInicial` sempre que a fila muda).
          setLegendaInicial(caption);
          setPendingFiles(resto);
        }}
        onSend={(caption) => {
          // A BIFURCAÇÃO (#1863, F3) — e ela é decidida pelo modo CONGELADO NA
          // ESCOLHA (`pendingEm`), não pelo modo de agora.
          //
          //   reply  → upload em `whatsapp-media` + `useSendMessage`: exatamente
          //            o que era antes, byte por byte. Nada aqui mudou para o
          //            cliente.
          //   note   → upload em `internal-media` + `useCreateNote`, com o trio
          //            como `anexo`. Não existe passo de envio: a nota não é
          //            mensagem, não tem `type`, não tem destino no WhatsApp.
          //
          // O tratamento de erro continua o de sempre: falha de upload mostra o
          // toast do próprio hook e o diálogo fica aberto, nos dois casos.
          enviarAnexos(caption);
        }}
      />
      <ContactPickerDialog
        open={contactPickerOpen}
        onOpenChange={setContactPickerOpen}
        excludeContactId={currentContactId}
        sending={send.isPending}
        onPick={(payload) => {
          send.mutate(
            {
              conversation_id: conversationId,
              type: "contact",
              metadata: payload.contactId
                ? { shared_contact_id: payload.contactId }
                : {
                    shared_contact: {
                      name: payload.name,
                      phone_number: payload.phone_number,
                    },
                  },
            },
            { onSuccess: () => setContactPickerOpen(false) },
          );
        }}
      />
    </>
  );
});
