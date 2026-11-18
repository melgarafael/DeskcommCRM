/** Recusa do provedor de voz sobre a VOZ pedida (id inexistente, voz sem acesso). */
export class ErroDoProvedorDeVoz extends Error {
  constructor(
    public readonly status: number,
    public readonly mensagemDoProvedor: string | null,
  ) {
    super(`synthesis_${status}`);
    this.name = "ErroDoProvedorDeVoz";
  }
}
