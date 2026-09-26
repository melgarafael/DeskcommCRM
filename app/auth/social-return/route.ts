import { marcaDaSaida } from "@/lib/branding/saida";
import { respostaDePonte } from "@/lib/auth/ponte-de-volta";

// Uma navegação externa de OAuth omite cookies de sessão sob SameSite=Strict.
// Entregar um documento estático same-origin antes de redirecionar para a tela
// autenticada restaura o envio normal dos cookies na navegação seguinte — a
// ponte mora em `lib/auth/ponte-de-volta.ts`, com o mesmo mecanismo que a volta
// da entrada com Google passou a usar (issue #1646).
// Esta página não realiza vínculos e não confia em parâmetros da query: só a
// PRESENÇA de `error`/`connected` escolhe entre destinos fixos, para a tela de
// Redes sociais dizer se a autorização deu certo ou falhou. Nenhum valor da
// query (nem o `connect_token`) é refletido.
const BASE = "/app/connections?aba=sociais";

function destino(params: URLSearchParams): string {
  if (params.has("error")) return `${BASE}&error=1`;
  if (params.has("connected")) return `${BASE}&connected=1`;
  return BASE;
}

export async function GET(request: Request) {
  const target = destino(new URL(request.url).searchParams);
  const marca = await marcaDaSaida(null);
  return respostaDePonte(target, marca.nome, "Voltando para suas conexões…");
}
