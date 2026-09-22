# WaCalls com funcionário de voz no Inbox

## Fatos verificados

* O transporte de chamadas do WaCalls usa um `RTCDataChannel` chamado `pcm`, com áudio PCM16 mono em 16 kHz nos dois sentidos.
* A configuração de voz dos funcionários usa uma sessão privada e efêmera do ElevenLabs Agents.
* Antes desta mudança, os dois recursos existiam separados. O Inbox oferecia apenas a chamada conduzida por uma pessoa.

## Decisão

A ligação com IA deve preparar e validar a sessão privada do funcionário antes de discar. Depois disso, o navegador faz somente a ponte em memória entre o PCM do WaCalls e o WebSocket da voz. Se a ponte falhar depois da discagem, a chamada é encerrada para não deixar o contato em silêncio.

## Proteções

* A conversa e o funcionário são sempre limitados à organização autenticada.
* O botão só aparece com WaCalls configurado, pareado e contato com telefone.
* O operador mantém o controle explícito de encerramento, mas o microfone humano não é aberto durante a condução pela IA.
* Testes cobrem conversão PCM, ping e pong, formatos de áudio, visibilidade do botão e preservação das ações do cabeçalho.
