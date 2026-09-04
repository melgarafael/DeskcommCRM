---
impacto: nada_mudou
secao: corrigido
titulo: O painel de IA para de avisar que um modelo não enxerga imagens quando ele enxerga
---

Duas informações erradas no painel de provedores, e as duas faziam quem opera
tomar decisão contra o que o sistema realmente faz.

**A primeira:** o painel avisava que um modelo "não enxerga imagens" e que fotos
e comprovantes do cliente seriam ignorados — sobre modelos que enxergam, e num
sistema onde a leitura estava funcionando. Na mesma instalação em que o aviso
aparecia, o print que o cliente enviou virou descrição correta para o atendente.

O painel lia uma tabela de catálogo; o atendimento lia outra coisa. Agora os
dois respondem pela mesma fonte, e o painel não pode mais discordar do que
acontece de verdade. Onde o sistema não conhece o modelo — o seu, ou um de um
serviço próprio —, o catálogo continua sendo a resposta, e a falta de informação
continua sendo dita como falta de informação, não como "não funciona".

**A segunda:** quem usa a OpenRouter tinha o problema INVERTIDO — e ele é pior,
porque não tem sintoma. Ali o sistema não sabia dizer se um modelo enxerga: ele
olhava só o começo do nome. Como `openai/gpt-4o` enxerga e `openai/gpt-3.5-turbo`
não, e os dois começam igual, um palpite pelo começo do nome erra metade das
vezes — e a OpenRouter já informa a resposta certa, modelo por modelo, quando o
catálogo é sincronizado na instalação.

O efeito prático era duplo. O painel deixava de avisar quando o aviso era
verdadeiro, então quem opera achava que o comprovante do cliente estava sendo
lido e não estava. E o atendimento chegava a enviar a imagem para um modelo que
não a aceita, o que fazia a resposta daquela mensagem falhar. Agora, quando a
OpenRouter informa a capacidade, é ela que vale — e quando não informa, o
sistema volta a dizer que não sabe, em vez de afirmar.

**A terceira:** o ponto "Ouvir o áudio do cliente" mostrava um modelo de
conversa, com "usando o padrão da organização" — ao lado do próprio texto do
ponto, que diz que a transcrição usa o padrão da OpenAI. A mesma tela afirmava
duas coisas incompatíveis, e modelo de conversa não transcreve áudio.

Agora ele mostra o que de fato transcreve. Trocar o modelo de conversa nunca
mudou nada ali; o que muda é a tela parar de sugerir que mudaria.

Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
nova, nenhum passo de atualização. O que muda é que o painel volta a descrever
o sistema que está rodando.
