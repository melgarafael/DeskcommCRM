/**
 * O TEXTO DO AVISO DE CASO — puro, sem `env`, sem client, sem DOM.
 *
 * ## O que ele é
 *
 * A mensagem que chega no WhatsApp da equipe quando a IA abre um caso:
 *
 *     🔔 Acme CRM: novo caso esperando você
 *
 *     Tipo: Pagamento
 *     Assunto: Desconto acima da política
 *     Cliente: Maria
 *     O que o cliente precisa: 15% de desconto no plano anual
 *     Por que a IA travou: a política permite até 10%
 *
 *     Abrir: https://crm.exemplo.com.br/app/ai/cases?caso=<uuid>
 *
 *     Responder aqui não chega ao cliente — abra o link para responder.
 *
 * ## As decisões, cada uma com o motivo
 *
 * **A marca vem de FORA.** Quem resolve é `marcaDaSaida(orgId)`
 * (`lib/branding/saida.ts`), que é `async` e lê o banco — este módulo recebe o
 * nome já resolvido. Saída sem DOM é classe A da doutrina de marca própria: um
 * texto que carimbasse o nome do produto aqui apareceria no WhatsApp de todo
 * cliente de todo revendedor. `tests/unit/branding.test.ts` varre este arquivo.
 *
 * **O idioma é o da ORGANIZAÇÃO, não o de quem está logado.** Ninguém está
 * logado quando o aviso sai: o disparo é do dreno do `event_log`. Toda frase
 * fixa passa por `traduzir(texto, idioma)`, e a chave É o texto em português —
 * o mesmo contrato do dicionário da tela.
 *
 * **PRIMEIRO nome, só.** Decisão do dono (opção A): detalhes sem dado sensível.
 * O sobrenome identifica; o primeiro nome faz a equipe reconhecer de quem se
 * trata sem que a mensagem, se encaminhada, entregue uma pessoa.
 *
 * **Título, resumo e bloqueio passam por `sanitizarTextoDoLead`.** Eles são
 * escritos pelo MODELO a partir do que o lead disse: sem a limpeza, um link de
 * phishing, um CPF ou um telefone escritos pelo cliente sairiam daqui dentro de
 * uma mensagem assinada com a marca da empresa.
 *
 * **Linha sem conteúdo não aparece.** Um `Assunto: ` vazio AFIRMA que há assunto
 * e que ele é nada. A ausência da linha é a verdade disponível.
 *
 * **A última linha não é enfeite.** O número do suporte só RECEBE — o corte da
 * ingestão (`lib/escalacao/numero-interno-de-aviso.ts`) descarta tudo o que
 * chega dele, de propósito. Sem essa linha, a primeira resposta da equipe vai
 * para o vazio e ninguém descobre por quê.
 */
import { tipoDeCasoLabel } from "@/lib/ai/case-copy";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { TETOS_DO_TEXTO_DO_LEAD, sanitizarTextoDoLead } from "./sanitizar-texto-do-lead";

/** O rótulo que a cascata de LGPD grava no nome do contato anonimizado. */
export const ROTULO_DE_ANONIMIZADO = "Cliente Anonimizado";

export interface AvisoDeCaso {
  /** O nome da marca já resolvido por `marcaDaSaida(orgId)`. */
  marca: string;
  /** O idioma da ORGANIZAÇÃO (`organizations.locale`), já normalizado. */
  idioma: Idioma;
  /** `agent_cases.kind` — vocabulário ABERTO, com fallback para "Outro". */
  kind: string | null;
  /** `agent_cases.source`: 'agent' | 'guardrail_autofallback' (aberto em runtime). */
  source: string | null;
  title: string | null;
  summary: string | null;
  blocker: string | null;
  /** `contacts.name` inteiro — o corte para o primeiro nome é feito aqui. */
  nomeDoCliente: string | null;
  /** O link já montado pelo servidor. É o ÚNICO link do texto. */
  link: string | null;
  referencia?: string;
}

/**
 * O primeiro token do nome — exceto no rótulo de anonimizado, que sai inteiro.
 *
 * `Cliente Anonimizado #0b1f7a2e` cortado no primeiro token viraria "Cliente",
 * e aí a equipe leria um aviso sobre alguém chamado Cliente em vez de ver que a
 * pessoa pediu para ser esquecida. A exceção é estreita e olha o PREFIXO do
 * rótulo que a cascata grava — não tenta adivinhar nada além disso.
 */
export function primeiroNome(nome: string | null | undefined): string | null {
  if (typeof nome !== "string") return null;
  const limpo = nome.trim().replace(/\s+/g, " ");
  if (limpo === "") return null;
  if (limpo.startsWith(ROTULO_DE_ANONIMIZADO)) return limpo;
  return limpo.split(" ")[0] ?? null;
}

/** Monta a mensagem. Função total: nunca lança, nunca devolve vazio. */
export function montarAvisoDeCaso(aviso: AvisoDeCaso): string {
  const t = (texto: string): string => traduzir(texto, aviso.idioma);
  const failSafe = aviso.source === "guardrail_autofallback";

  const linhas: string[] = [`🔔 ${aviso.marca}: ${t("novo caso esperando você")}`, ""];

  linhas.push(`${t("Tipo")}: ${t(tipoDeCasoLabel(aviso.kind ?? "outro"))}`);

  // No caso de fail-safe o `title` é fixo e genérico (o motor o escreve quando a
  // IA prometeu algo e não pôde cumprir) — a frase própria diz mais do que ele.
  const assunto = failSafe
    ? t("A IA prometeu algo e travou")
    : sanitizarTextoDoLead(aviso.title, TETOS_DO_TEXTO_DO_LEAD.title);
  if (assunto) linhas.push(`${t("Assunto")}: ${assunto}`);

  const cliente = primeiroNome(aviso.nomeDoCliente);
  if (cliente) linhas.push(`${t("Cliente")}: ${cliente}`);

  const precisa = sanitizarTextoDoLead(aviso.summary, TETOS_DO_TEXTO_DO_LEAD.summary);
  if (precisa) {
    // A ETIQUETA é a defesa barata contra phishing no caso de fail-safe: ali o
    // `summary` é a própria frase que a IA ia mandar ao cliente, e sem a
    // etiqueta ela chega à equipe com cara de afirmação do sistema. Declarada
    // como citação, ela volta a ser o que é.
    if (failSafe) linhas.push(t("(resumo escrito pela IA a partir da conversa)"));
    linhas.push(`${t("O que o cliente precisa")}: ${precisa}`);
  }

  const travou = sanitizarTextoDoLead(aviso.blocker, TETOS_DO_TEXTO_DO_LEAD.blocker);
  if (travou) linhas.push(`${t("Por que a IA travou")}: ${travou}`);

  if (aviso.link) {
    linhas.push("", `${t("Abrir")}: ${aviso.link}`, "");
    linhas.push(t("Responder aqui não chega ao cliente — abra o link para responder."));
  } else {
    if (aviso.referencia) linhas.push("", `${t("Caso")}: ${aviso.referencia}`);
    linhas.push(
      "",
      t(
        "Abra Casos no computador onde o sistema está funcionando. Responder aqui não chega ao cliente.",
      ),
    );
  }

  return linhas.join("\n");
}

/** Lembrete mínimo da equipe: identifica o marco e caso, sem ecoar conversa. */
export function montarLembreteDeCaso(entrada: {
  marca: string;
  idioma: Idioma;
  minute: number;
  referencia: string;
}): string {
  const t = (texto: string): string => traduzir(texto, entrada.idioma);
  return [
    `🔔 ${entrada.marca}: ${t("lembrete de caso aguardando a equipe")}`,
    `${t("Tempo de espera")}: ${entrada.minute} ${t("minutos")}`,
    `${t("Caso")}: ${entrada.referencia}`,
    "",
    t(
      "Abra Casos no computador onde o sistema está funcionando. Responder aqui não chega ao cliente.",
    ),
  ].join("\n");
}

/**
 * A MENSAGEM DO BOTÃO "ENVIAR AVISO DE TESTE".
 *
 * Mora aqui, e não na rota, pelo mesmo motivo do texto de cima: **um dono para
 * o que sai sem DOM**. A marca chega resolvida por `marcaDaSaida(orgId)` e o
 * idioma é o da organização — uma mensagem de teste carimbada com o nome do
 * produto apareceria no WhatsApp da equipe de todo cliente de todo revendedor,
 * e `tests/unit/branding.test.ts` varre este arquivo.
 *
 * Ela **NÃO** imita um caso. Repetir "novo caso esperando você" num teste
 * ensinaria a equipe a ler aquele cabeçalho como ruído — e o primeiro caso de
 * verdade seria ignorado. Ela diz o que é, diz o que vai chegar quando for
 * real, e repete a única linha que o teste precisa ensinar: responder ali não
 * chega a ninguém.
 *
 * O link é o da lista de casos e é a razão de o teste exigir endereço público:
 * é ele que prova, no celular de quem recebeu, que o link do aviso abre.
 */
export function montarAvisoDeTeste(entrada: {
  marca: string;
  idioma: Idioma;
  /** O link já montado pelo servidor — a lista de casos desta instalação. */
  link: string | null;
  referencia?: string;
}): string {
  const t = (texto: string): string => traduzir(texto, entrada.idioma);
  return [
    `🔔 ${entrada.marca}: ${t("teste de aviso")}`,
    "",
    t("Se esta mensagem chegou, os avisos de caso estão configurados e funcionando."),
    "",
    entrada.link
      ? t(
          "Quando o atendimento automático travar, chega aqui o tipo do assunto, o primeiro nome do cliente, o que ele precisa e um link para abrir o atendimento.",
        )
      : t(
          "Quando o atendimento automático travar, abra Casos no computador onde o sistema está funcionando.",
        ),
    "",
    ...(entrada.link ? [`${t("Abrir")}: ${entrada.link}`] : []),
    "",
    entrada.link
      ? t("Responder aqui não chega ao cliente — abra o link para responder.")
      : t(
          "Abra Casos no computador onde o sistema está funcionando. Responder aqui não chega ao cliente.",
        ),
  ].join("\n");
}
