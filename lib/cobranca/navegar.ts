/** Sai do sistema para a página do provedor (checkout, portal). Um ponto só: o teste troca este módulo. */
export function abrirNoNavegador(url: string): void {
  window.location.assign(url);
}
