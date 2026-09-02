import { AgendaCarregando } from "@/components/agenda/estados";

/**
 * O esqueleto tem a FORMA da grade — sete colunas e a faixa de horas — e não
 * três barras genéricas. É o que o resto do produto faz (o do funil desenha 5
 * colunas × 3 cards), e a razão é de percepção: silhueta certa faz a espera
 * parecer continuação; retângulo genérico faz parecer que a página trocou.
 */
export default function AgendaLoading() {
  return (
    /*
      O MESMO escopo do `page.tsx`. Sem ele o esqueleto aparece sobre o fundo
      escuro e a tela clareia de repente quando os dados chegam — a troca de
      superfície viraria parte da animação de carregar, que é o jeito mais
      barato de fazer uma tela parecer quebrada.
    */
    <div
      data-superficie="clara"
      className="-m-6 flex min-h-[calc(100%+3rem)] flex-col gap-6 bg-bg p-6 text-text"
    >
      <div className="h-14" />
      <AgendaCarregando />
    </div>
  );
}
