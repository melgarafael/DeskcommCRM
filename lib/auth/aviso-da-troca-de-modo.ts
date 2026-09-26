/**
 * O AVISO DE QUE A TROCA DE MODO AINDA NÃO CHEGOU AO GOTRUE — issue #1668.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O kit só sincroniza `DISABLE_SIGNUP` do Supabase no `install`/`update.sh`
 * (função `sincronizar_signup_mode_do_gotrue`, do #1665). Quem troca o modo em
 * `/admin/cadastro` depois de instalado grava `platform_settings.signup_mode`
 * na hora e a regra do CRM passa a valer imediatamente — mas o GoTrue da VPS
 * continua com o valor antigo até a próxima atualização. Enquanto isso a tela
 * diz "só convite" e o `POST /auth/v1/signup` direto, com a anon key que vai
 * para o navegador, segue aberto (medido na issue #1653: é esse endpoint que o
 * `disable_signup` fecha).
 *
 * ─── Por que é AVISO, e não o conserto ──────────────────────────────────────
 *
 * A regra do `agent.sh` da VPS é avisar, não corrigir — e o conserto de fato
 * mora no kit, não aqui: aplicar a troca é reiniciar o `auth` do Supabase com
 * um `.env` novo, coisa que o CRM (roda DENTRO do container do app) não faz.
 * Então esta pergunta existe só para a tela contar o que sabe, com o comando
 * de quem quer aplicar já.
 *
 * ─── A régua é a do kit, palavra por palavra ────────────────────────────────
 *
 * O `case` da `sincronizar_signup_mode_do_gotrue` manda `so_convite` para
 * `disable_signup=true` e `aberto|com_aprovacao` para `false`. Aqui é o mesmo:
 *   - banco ≠ GoTrue → aviso;
 *   - banco = GoTrue → silêncio. Uma troca `aberto ↔ com_aprovacao` não muda o
 *     GoTrue, e ninguém precisa ouvir falar de atualização por nada;
 *   - `com_aprovacao` espera `false` como o `aberto`, porque o cadastro direto
 *     continua aberto — quem segura ali é a fila de pedidos do CRM.
 *
 * ─── Não deu para ler → NENHUM aviso ────────────────────────────────────────
 *
 * `lerConfigPublicaDoGoTrue` devolve `null` quando a rede, a resposta ou o
 * corpo não dizem nada, e "não sei" não é "divergente". Um aviso FALSO aqui é
 * pior que um aviso ausente: quem é ensinado a desconfiar do alerta ignora o
 * dia em que ele importa. Vale para o prazo também — ver `PRAZO_MS`.
 *
 * ─── O prazo ────────────────────────────────────────────────────────────────
 *
 * Esta leitura acontece no RENDER da página, não no clique de um botão: sem
 * prazo, um GoTrue mudo (pct dropado na firewall, container parado sem RST)
 * seguraria a tela de `/admin/cadastro` por minutos — o fetch daqui não tem
 * sinal de aborto e herda o timeout do cliente HTTP. Quatro segundos é o mesmo
 * tamanho do do irmão `estadoDoProvedorGoogle` (#1652), que também lê este
 * endpoint dentro de um caminho que não pode esperar. Passou do prazo, a
 * resposta é `null`: sem aviso, tela normal.
 */
import { lerConfigPublicaDoGoTrue, type ConfigPublicaDoGoTrue } from "@/lib/auth/convite-no-gotrue";
import type { ModoDeCadastro } from "@/lib/auth/politica-de-cadastro";

/** O `disable_signup` que o GoTrue DEVERIA estar aplicando para este modo. */
export function disableSignupEsperado(modo: ModoDeCadastro): boolean {
  return modo === "so_convite";
}

/** Mesmo tamanho do prazo de `estadoDoProvedorGoogle` (#1652). */
const PRAZO_MS = 4_000;

/**
 * Lê as settings do GoTrue com prazo; o que não vier em `PRAZO_MS` vira
 * `null`, que é o mesmo "não sei" de uma leitura que falhou.
 *
 * O `clearTimeout` vive dentro do `.then`, com o `const` do cronômetro na mesma
 * função: os dois usos compartilham o TIPO que `setTimeout` devolve neste
 * projeto, sem depender de qual das lib types vença no `tsconfig`.
 */
function lerComPrazo(): Promise<ConfigPublicaDoGoTrue | null> {
  return new Promise((resolver) => {
    const relogio = setTimeout(() => resolver(null), PRAZO_MS);
    lerConfigPublicaDoGoTrue().then(
      (config) => {
        clearTimeout(relogio);
        resolver(config);
      },
      () => {
        clearTimeout(relogio);
        resolver(null);
      },
    );
  });
}

/**
 * `/admin/cadastro` precisa contar esta troca? `false` também é a resposta
 * certa quando o GoTrue está igual OU quando não deu para perguntar a ele.
 */
export async function haAvisoDeTrocaDeModo(modo: ModoDeCadastro): Promise<boolean> {
  const config = await lerComPrazo();
  if (config === null) return false;
  return config.disable_signup !== disableSignupEsperado(modo);
}
