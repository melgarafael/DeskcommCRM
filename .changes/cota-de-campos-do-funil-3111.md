---
impacto: capacidade_nova
secao: corrigido
titulo: O funil volta a ter os 50 campos do negócio — os campos do contato não ocupam mais essa cota
---
Desde a 1.86 os campos do contato passaram a ser declarados no mesmo funil dos campos do negócio, e os dois disputavam o mesmo teto de 50. Na prática, um funil com 20 campos do negócio e 20 do contato já tinha gasto 40 dos 50 e travava antes de cobrir o negócio — a tela parava de oferecer o botão de acrescentar campo. Agora a cota de 50 é só dos campos do negócio, e os campos do contato ficam fora dela; quem salva o funil volta a poder cadastrar os 50 campos do negócio mesmo com campos do contato declarados. Nada muda para o negócio: 51 campos do negócio continuam sendo recusados, e os campos do contato não entram nessa conta. Vale também para o campo que o cliente cadastra a partir de uma captação, que parava de entrar quando o funil já tinha 50 definições contando as do contato. Você não precisa fazer nada.

Contribuição de @webtecnica, a partir da issue #3111.
