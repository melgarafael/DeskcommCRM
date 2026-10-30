"use client";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { roleAtLeast } from "@/lib/auth/types";
import { PAIS_PADRAO, perfilDoPais } from "@/lib/legal/perfil-do-pais";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { contactCreateSchemaDoPais, type ContactCreate } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useDefinirCorDaEtiqueta } from "@/hooks/tags/useDefinirCorDaEtiqueta";
import { AbrirConversaAposSalvar } from "@/components/channels/AbrirConversaAposSalvar";
import type { AlvoDeConversa } from "@/components/channels/SeletorDeCanalParaConversa";
import { EtiquetasDoContato } from "@/components/contacts/EtiquetasDoContato";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  cpf?: string;
  /** As etiquetas do contato novo — o seletor grava esta lista. */
  tags?: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * Nome já digitado por quem chamou, para não redigitar. Quem abre com um termo
   * de busca em mãos passa aqui; o resto continua abrindo vazio.
   *
   * É `defaultValue` do formulário, então só vale na montagem — quem precisa
   * trocar o termo com o diálogo já montado remonta com `key`.
   */
  nomeInicial?: string;
  /**
   * Recebe o contato recém-criado. Existe para quem abriu o diálogo NO MEIO de
   * outro fluxo (marcar um horário, por exemplo) poder seguir com ele já
   * selecionado, em vez de mandar a pessoa procurar de novo o que acabou de criar.
   */
  onCriado?: (contato: Contact) => void;
  /**
   * Só o cadastro que conclui a jornada pode navegar para a conversa. Quem
   * fornece um contato a outro formulário desliga para preservar o rascunho.
   */
  permitirIniciarConversa?: boolean;
}

export function NewContactDialog({
  open,
  onOpenChange,
  nomeInicial,
  onCriado,
  permitirIniciarConversa = true,
}: Props) {
  const t = useT();
  const org = useActiveOrg();
  const perfil = perfilDoPais(org?.country);
  const create = useCreateContact();
  /**
   * A CONVERSA A ABRIR DEPOIS DE SALVAR (#3483) — `null` = nada pendente.
   *
   * O trabalho de abrir (canais, claim, Inbox) mora em
   * `AbrirConversaAposSalvar`, montado só quando há alvo: quem abre o diálogo
   * para "só cadastrar" não paga a leitura de canais, e o formulário continua
   * sem depender de router/provider.
   */
  const [conversaAoSavar, setConversaAoSavar] = useState<AlvoDeConversa | null>(null);
  // O MESMO vocabulário de sugestões da ficha (#2732): a chave do react-query é
  // a mesma, então quem já leu na lista de contatos não paga outra requisição.
  const vocabulario = useContactTagVocabulary(org?.orgId ?? null);
  const { definirCor } = useDefinirCorDaEtiqueta();
  // A cor da etiqueta é VOCABULÁRIO e a rota exige manager + MFA: para os outros
  // papéis a paleta nem chega ao campo, como na ficha e no editor do Inbox.
  const podeDefinirCor = roleAtLeast(org?.role, "manager");
  const [serverError, setServerError] = useState<string | null>(null);
  // A etiqueta que o texto AINDA digitado no campo viraria — o mesmo fio do
  // EditContactDialog (#2732): sem ele, quem digita e clica em "Criar contato"
  // sem Enter perde a etiqueta em silêncio.
  const [etiquetaPendente, setEtiquetaPendente] = useState<string | null>(null);

  // O diálogo segue montado entre aberturas e o campo (com o rascunho) desmonta
  // ao fechar; o pendente do pai não pode sobreviver para o próximo contato.
  // Pelo `open`, e não embrulhando o `onOpenChange`: o Cancelar e o pai fecham
  // sem passar por ele. Ajuste no render, não em `useEffect` (o
  // `react-hooks/set-state-in-effect` acusa o efeito como render em cascata).
  const [abertoAntes, setAbertoAntes] = useState(open);
  if (open !== abertoAntes) {
    setAbertoAntes(open);
    if (!open) setEtiquetaPendente(null);
  }

  const form = useForm<FormShape>({
    // `onTouched`: o erro do documento nasce quando a pessoa SAI do campo, não
    // só no clique de "Criar contato" (#3496). Sem validate em nenhum outro
    // campo, nada muda para os demais.
    mode: "onTouched",
    defaultValues: {
      name: nomeInicial ?? "",
      email: "",
      phone_number: "",
      cpf: "",
      tags: [],
    },
  });

  const cpfError = form.formState.errors.cpf;
  const tags = useWatch({ control: form.control, name: "tags" }) ?? [];

  async function onSubmit(values: FormShape) {
    await salvar(values, false);
  }

  /**
   * GRAVAR O CONTATO E, SE PEDIDO, JÁ ABRIR A CONVERSA DELE (#3483).
   *
   * ─── O que a issue pedia ─────────────────────────────────────────────────
   *
   * Quem cadastra e atende ficava na tela de Contatos sem caminho para começar
   * a conversa: tinha de sair, ir ao Inbox, clicar em "Iniciar conversa" e
   * procurar de novo o contato que acabou de criar. O botão "Salvar e iniciar
   * conversa" encurta isso — e, como abre a conversa pelo caminho do Inbox
   * (`open-with-contact` + `claim`), a conversa nasce COM DONO. Em empresa no
   * modo "Só os seus" isso é a diferença entre ver o atendimento e não ver
   * nada (o sintoma do #3479).
   *
   * ─── Por que o contato é gravado ANTES de abrir ──────────────────────────
   *
   * Abrir é o passo secundário: se ele falhar (sem sessão de canal, sem
   * telefone, papel insuficiente), o CADASTRO não pode ser desfeito nem
   * escondido atrás de um erro. O pior desfecho aceitável é "contato salvo,
   * conversa não abriu, e o motivo dito na tela".
   *
   * ─── Sem telefone não há conversa: a tela diz por quê ────────────────────
   *
   * A régua é a do card do funil (`AbrirConversaDoLead`): sem telefone no
   * contato não se abre thread 1:1. O telefone que vale é o que a rota GRAVOU
   * (`contato.phone_number`), não o que foi digitado — o servidor normaliza e
   * pode recusar; perguntar a ele evita uma segunda régua de telefone aqui.
   *
   * ─── Permissão não muda de lado ──────────────────────────────────────────
   *
   * Nada aqui decide quem pode: `open-with-contact` e `claim` exigem papel
   * `agent` no servidor, e quem não tem recebe a recusa de sempre — a tela
   * mostra o erro e não navega. O atalho não abre porta que o Inbox fechava.
   */
  async function salvar(values: FormShape, abrir: boolean) {
    setServerError(null);
    // A MESMA normalização da API (lib/contacts/tag-normalizada): o que a ficha
    // grava é o que o filtro `?tag=` casa (issue #1224).
    const tags = normalizarTags([
      ...(values.tags ?? []),
      ...(etiquetaPendente ? [etiquetaPendente] : []),
    ]);

    const payload: Record<string, unknown> = { source: "manual" };
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    if (values.cpf?.trim()) payload.cpf = values.cpf.trim();
    if (tags.length) payload.tags = tags;

    // A MESMA régua do servidor: a tela que mostra 'Bilhete' não pode
    // recusá-lo como CPF antes de chegar lá.
    const parsed = contactCreateSchemaDoPais(perfil).safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setServerError(first?.message ?? t("Dados inválidos"));
      return;
    }

    let contato: Contact | undefined;
    try {
      const resposta = await create.mutateAsync(parsed.data as ContactCreate);
      // `.data` é o envelope do `ok()`, e dentro dele mora `{ contact, action }`.
      // Entregar `resposta.data` aqui devolveria esse envelope como se fosse o
      // contato: o `id` sairia `undefined` e a marcação ficaria sem ninguém, em
      // silêncio. Quem garante que este caminho não volta a errar é o tipo do
      // hook, ligado ao retorno da rota.
      contato = resposta?.data?.contact;
    } catch {
      // error toast already handled by hook — e nada foi criado, então não há
      // conversa a abrir.
      return;
    }

    toast.success(t("Contato criado"));
    form.reset();
    setEtiquetaPendente(null);
    onOpenChange(false);
    if (!contato) return;
    onCriado?.(contato);
    if (!abrir || !permitirIniciarConversa) return;
    if (!contato.phone_number) {
      toast.info(t("Contato salvo. Cadastre um telefone para abrir a conversa."));
      return;
    }
    setConversaAoSavar({ contact_id: contato.id, phone_number: contato.phone_number });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Novo contato")}</DialogTitle>
          <DialogDescription>
            {t("Preencha pelo menos um identificador (email ou telefone).")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            // O portal mantém a árvore React: o submit deste subcadastro não
            // pode submeter também o negócio ou a marcação ainda em edição.
            event.stopPropagation();
            void form.handleSubmit(onSubmit)(event);
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="name">{t("Nome")}</Label>
            <Input id="name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("Email")}</Label>
            <Input id="email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone_number">
              {perfil.codigo === PAIS_PADRAO
                ? t("Telefone (DDD + número)")
                : t("Telefone (E.164)")}
            </Label>
            <Input
              id="phone_number"
              placeholder={perfil.telefoneExemplo}
              {...form.register("phone_number")}
            />
          </div>
          <div className="space-y-2">
            {/* O documento é o do PAÍS da organização — a API já valida por ele
                (`contactCreateSchemaDoPais`); só a tela escrevia "CPF" em duro. */}
            <Label htmlFor="cpf">
              {perfil.documento.rotulo} ({t("opcional")})
            </Label>
            {/* Validação no CAMPO, não no rodapé (#3496).
                O servidor já recusava o documento pelo perfil do país; a tela
                só avisava depois do clique, com a frase no rodapé do diálogo —
                longe do campo e indistinguível de "não validou". Aqui a mesma
                régua roda no blur (`mode: "onTouched"`), e a mensagem nasce
                embaixo do input. Opcional continua opcional: vazio passa. */}
            <Input
              id="cpf"
              placeholder={perfil.documento.exemplo}
              aria-invalid={cpfError ? true : undefined}
              aria-describedby={cpfError ? "cpf-erro" : undefined}
              {...form.register("cpf", {
                validate: (valor) => {
                  const texto = (valor ?? "").trim();
                  if (texto.length === 0) return true;
                  return perfil.documento.valida(texto) || perfil.documento.mensagemInvalido;
                },
              })}
            />
            {cpfError && (
              <p id="cpf-erro" role="alert" className="text-sm text-error-fg">
                {cpfError.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            {/* Era um campo de texto livre "separadas por vírgula" — o formato
                que a ficha deixou na #2732 e o funil na #2979. Aqui o mesmo
                seletor da ficha: sugere o que já existe, reusa a grafia gravada
                e colore com o tom do vocabulário. */}
            <Label htmlFor="new-tags">{t("Tags")}</Label>
            <EtiquetasDoContato
              inputId="new-tags"
              value={tags}
              onChange={(next) => form.setValue("tags", next, { shouldDirty: true })}
              vocabulario={vocabulario.data}
              disabled={create.isPending}
              onPendente={setEtiquetaPendente}
              onDefinirCor={
                podeDefinirCor ? (tag, cor) => void definirCor(tag, cor) : undefined
              }
            />
          </div>
          {serverError && (
            <p className="text-sm text-error-fg">{serverError}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              {t("Cancelar")}
            </Button>
            {/* O CAMINHO DA #3483: salvar e já cair na conversa do contato.
                `handleSubmit` direto no clique (e não um submit que lê uma
                flag) porque o mesmo formulário tem dois desfechos diferentes —
                a intenção viaja no argumento, não em estado que pode sobrar
                para o próximo cadastro. */}
            {permitirIniciarConversa && (
              <Button
                type="button"
                variant="secondary"
                disabled={create.isPending}
                onClick={form.handleSubmit((values) => void salvar(values, true))}
              >
                {t("Salvar e iniciar conversa")}
              </Button>
            )}
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t("Criando…") : t("Criar contato")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {/* FORA do `DialogContent` de propósito: o cadastro FECHA ao salvar e a
          abertura da conversa (com a escolha de canal, #2382) vem depois.
          Dentro do `DialogContent` ela morreria junto com o formulário que
          acabou de sumir. */}
      {conversaAoSavar && <AbrirConversaAposSalvar alvo={conversaAoSavar} />}
    </Dialog>
  );
}
