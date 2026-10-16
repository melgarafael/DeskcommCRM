/**
 * A configuração da INSTALAÇÃO: banco primeiro, `.env` como piso.
 *
 * Este é o único módulo que fala com `public.platform_config`. A regra de quem
 * vence e de quando o `.env` promove mora em `config-resolve.ts`, puro e
 * testável sem Postgres.
 *
 * ── Por que NÃO há memo aqui (e a marca tem) ─────────────────────────────────
 *
 * `lib/branding/instalacao.ts` mantém memo de processo com TTL, e o cabeçalho
 * dele documenta o preço: guarda de geração contra a leitura em voo que
 * ressuscita o valor pré-escrita, `"erro"` obrigado a ficar FORA do memo para
 * uma falha de transporte não virar fato por um TTL inteiro, e um bug medido no
 * CI em que a tela negava o logo por 19,6s ATRÁS DE UM TOAST VERDE.
 *
 * Aquele memo se paga porque a marca é lida em `app/layout.tsx` — toda tela,
 * todo render. Credencial não: ela é lida quando alguém vai USAR a credencial
 * (chamar a IA, mandar mensagem), que é caminho de rede, não de render. E o
 * `worker` é um SEGUNDO processo, que nunca veria a invalidação do `app`: com
 * memo, trocar a chave pela tela deixaria o worker usando a antiga até alguém
 * reiniciar o servidor — sem erro e sem aviso, com a tela dizendo "salvo".
 *
 * Então lemos do banco no momento do uso, que é o que `resolveOrgLlmConfig` já
 * faz para a configuração de IA por organização ("trocar modelo/provider é
 * UPDATE na config, sem restart nem deploy"). Se algum dia isto virar hot path,
 * mede-se e resolve-se então — com a evidência na mão, não por antecipação.
 *
 * ── Nada aqui lança ──────────────────────────────────────────────────────────
 *
 * Mesmo contrato do resolvedor da marca: "o banco não falou" degrada para o
 * `.env`, com aviso no log. Uma exceção neste caminho seria 500 na tela onde
 * alguém corrigiria o que quebrou. Falha fechada na AÇÃO (não grava sem cifra),
 * aberta na INFORMAÇÃO (a tela abre e diz o que falta).
 */
import { byteaToBuffer, bufToBytea, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { precisaSemear, resolver, type EstadoDaLinha, type Fonte } from "./config-resolve";

// ⚠️ O nome da tabela é escrito por EXTENSO em cada `.from()`, e não numa
// constante, de propósito. `tests/invariants/on-conflict-aponta-para-constraint-real.test.ts`
// varre cada `onConflict` e resolve a tabela pelo `.from("<literal>")` mais
// próximo acima — `.from(variavel)` fica NÃO-RESOLVIDO e reprova. A varredura
// existe para garantir que todo `onConflict` aponte para uma constraint que
// existe de verdade; uma constante aqui a cega, e o custo de cegá-la é maior que
// o de repetir a string três vezes.

/** O que a linha traz do banco. O envelope só é aberto aqui dentro. */
interface LinhaCrua {
  chave: string;
  valor: string | null;
  ciphertext: string | null;
  iv: string | null;
  tag: string | null;
  last4: string | null;
  eh_segredo: boolean;
  semeado_do_env: boolean;
}

export interface ValorDaInstalacao {
  readonly valor: string | null;
  readonly fonte: Fonte;
}

/**
 * O que a TELA pode ver. Note o que não está aqui: o valor.
 *
 * `lib/crypto/aes_gcm.ts` escreve a regra no topo — o plaintext nunca é logado,
 * persistido em claro nem devolvido em resposta; só o `last4` é exposto. A
 * credencial do Google (0201) já provou que dá para operar assim: quem configura
 * confere pelos últimos quatro caracteres e substitui quando quer trocar.
 */
export interface EstadoParaTela {
  readonly chave: string;
  readonly fonte: Fonte;
  readonly configurado: boolean;
  readonly last4: string | null;
  readonly ehSegredo: boolean;
  /** Preenchido só para knob — segredo nunca devolve valor. */
  readonly valorVisivel: string | null;
}

function doAmbiente(chave: string): string | null {
  const fonte = env as unknown as Record<string, unknown>;
  const bruto = fonte[chave] ?? process.env[chave];
  return typeof bruto === "string" ? bruto : null;
}

function aviso(chave: string, o_que: string, erro: unknown) {
  // Logger estruturado do projeto: nunca o valor, só a chave e o motivo.
  console.warn(
    `[instalacao/config] ${o_que} para "${chave}" — usando o .env. ` +
      `${erro instanceof Error ? erro.message : String(erro)}`,
  );
}

/**
 * Abre o envelope. Devolve `null` — nunca lança — quando a chave de cifra não
 * está configurada ou o envelope não abre.
 *
 * Os dois casos degradam igual de propósito: para quem opera a VPS, "a chave
 * `AI_CRED_AES_KEY` sumiu do `.env`" e "este envelope foi cifrado com outra
 * chave" têm o mesmo remédio — repor a chave certa —, e nenhum dos dois pode
 * derrubar a tela que mostra o problema.
 */
function abrirEnvelope(linha: LinhaCrua): string | null {
  if (!linha.ciphertext || !linha.iv || !linha.tag) return null;
  try {
    return decryptKey({
      ciphertext: byteaToBuffer(linha.ciphertext),
      iv: byteaToBuffer(linha.iv),
      tag: byteaToBuffer(linha.tag),
    });
  } catch (erro) {
    aviso(linha.chave, "o segredo guardado não abriu", erro);
    return null;
  }
}

function emClaro(linha: LinhaCrua): EstadoDaLinha {
  return {
    valor: linha.eh_segredo ? abrirEnvelope(linha) : linha.valor,
    semeadoDoEnv: linha.semeado_do_env,
  };
}

async function lerLinha(chave: string): Promise<LinhaCrua | null | "erro"> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_config")
      .select("chave, valor, ciphertext, iv, tag, last4, eh_segredo, semeado_do_env")
      .eq("chave", chave)
      // Fora da deduplicação de `fetch` do Next dentro de um render: sem o `signal`,
      // uma 2ª leitura do MESMO render, feita depois de uma escrita ter invalidado o
      // memo, recebe a resposta de ANTES dela e a memoiza. O porquê inteiro está em
      // `lerLinha` de `lib/branding/instalacao.ts` (#1218). Nunca é abortado.
      .abortSignal(new AbortController().signal)
      .maybeSingle();
    if (error) {
      // `42P01` é o rollback pela outra ponta: imagem nova sobre schema velho,
      // o que acontece quando o baseline ainda não foi aplicado. Degrada igual.
      aviso(chave, "o banco recusou a leitura", error.message);
      return "erro";
    }
    return (data as LinhaCrua | null) ?? null;
  } catch (erro) {
    aviso(chave, "a leitura do banco falhou", erro);
    return "erro";
  }
}

/**
 * O valor em vigor para uma chave — o que o código deve chamar em vez de
 * `env.X` quando a chave é configurável pela tela.
 */
export async function valorDaInstalacao(chave: string): Promise<ValorDaInstalacao> {
  const linha = await lerLinha(chave);
  if (linha === "erro") {
    const doEnv = doAmbiente(chave);
    return resolver(null, doEnv);
  }
  return resolver(linha ? emClaro(linha) : null, doAmbiente(chave));
}

/**
 * O estado de uma chave para a tela — sem nunca devolver segredo.
 */
export async function estadoParaTela(
  chave: string,
  ehSegredo: boolean,
): Promise<EstadoParaTela> {
  const linha = await lerLinha(chave);
  const cru = linha === "erro" ? null : linha;
  const { valor, fonte } = resolver(cru ? emClaro(cru) : null, doAmbiente(chave));
  return {
    chave,
    fonte,
    configurado: valor !== null,
    last4: cru?.last4 ?? (valor !== null && ehSegredo ? valor.slice(-4) : null),
    ehSegredo,
    valorVisivel: ehSegredo ? null : valor,
  };
}

export type ResultadoDaEscrita =
  | { ok: true }
  | { ok: false; motivo: "sem_chave_de_cifra" | "banco_recusou"; detalhe: string };

/**
 * Grava pela tela. Zera `semeado_do_env` — a partir daqui o `.env` não
 * sobrescreve mais, inclusive se o valor for apagado depois.
 *
 * Falha FECHADA: sem chave de cifra, não grava e diz por quê. Gravar um segredo
 * em claro porque a cifra não estava disponível seria o pior desfecho possível,
 * e é o que a rota do Google já recusa.
 */
export async function gravarPelaTela(
  chave: string,
  valor: string,
  opcoes: { ehSegredo: boolean; ator: string | null },
): Promise<ResultadoDaEscrita> {
  const linha: Record<string, unknown> = {
    chave,
    eh_segredo: opcoes.ehSegredo,
    semeado_do_env: false,
    updated_by: opcoes.ator,
    updated_at: new Date().toISOString(),
  };

  if (opcoes.ehSegredo) {
    try {
      const envelope = encryptKey(valor);
      linha.ciphertext = bufToBytea(envelope.ciphertext);
      linha.iv = bufToBytea(envelope.iv);
      linha.tag = bufToBytea(envelope.tag);
      linha.last4 = envelope.last4;
      linha.valor = null;
    } catch (erro) {
      return {
        ok: false,
        motivo: "sem_chave_de_cifra",
        detalhe: erro instanceof Error ? erro.message : String(erro),
      };
    }
  } else {
    linha.valor = valor;
    linha.ciphertext = null;
    linha.iv = null;
    linha.tag = null;
    linha.last4 = null;
  }

  try {
    // `upsert` e nunca `update`: a linha pode não existir ainda, e um `update`
    // que casa zero linhas devolve sucesso sem ter escrito nada — armadilha que
    // este projeto já pagou em `organizations`.
    const { error } = await createAdminClient().from("platform_config").upsert(linha, { onConflict: "chave" });
    if (error) return { ok: false, motivo: "banco_recusou", detalhe: error.message };
    return { ok: true };
  } catch (erro) {
    return {
      ok: false,
      motivo: "banco_recusou",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    };
  }
}

/**
 * Volta ao padrão: apaga a linha e deixa o `.env` responder de novo (e poder
 * semear outra vez). É por isso que `delete` está no grant da tabela.
 */
export async function voltarAoAmbiente(chave: string): Promise<ResultadoDaEscrita> {
  try {
    const { error } = await createAdminClient().from("platform_config").delete().eq("chave", chave);
    if (error) return { ok: false, motivo: "banco_recusou", detalhe: error.message };
    return { ok: true };
  } catch (erro) {
    return {
      ok: false,
      motivo: "banco_recusou",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    };
  }
}

/** Reexportado para quem semeia a partir do `.env` na primeira leitura. */
export { precisaSemear };
