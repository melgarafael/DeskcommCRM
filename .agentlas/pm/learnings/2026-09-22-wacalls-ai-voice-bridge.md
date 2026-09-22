# WaCalls com funcionário de voz no Inbox

## Fatos verificados

* O transporte de chamadas do WaCalls usa um `RTCDataChannel` chamado `pcm`, com áudio PCM16 mono em 16 kHz nos dois sentidos.
* A ligação do Inbox usa `gpt-realtime-2.1` com credencial efêmera criada no servidor. A chave permanente da OpenAI nunca chega ao navegador.
* O endpoint do modelo rejeita PCM em 16 kHz e exige pelo menos 24 kHz, apesar de a documentação geral listar 16 kHz entre os formatos. A ponte reamostra 16 para 24 kHz na entrada e 24 para 16 kHz na saída.
* Antes desta mudança, os dois recursos existiam separados. O Inbox oferecia apenas a chamada conduzida por uma pessoa.

## Decisão

A ligação com IA deve preparar e validar a sessão efêmera da OpenAI antes de discar. Depois disso, o navegador faz somente a ponte em memória entre o PCM do WaCalls e o WebSocket do Realtime. Se a ponte falhar depois da discagem, a chamada é encerrada para não deixar o contato em silêncio.

## Proteções

* A conversa e o funcionário são sempre limitados à organização autenticada.
* A criação da sessão envia um identificador de segurança derivado por SHA 256 da organização e do usuário, sem expor identificadores reais ao provedor.
* O botão só aparece com WaCalls configurado, pareado e contato com telefone.
* O operador mantém o controle explícito de encerramento, mas o microfone humano não é aberto durante a condução pela IA.
* Testes cobrem o contrato GA da OpenAI, conversão PCM contínua, segredo efêmero, erro seguro, visibilidade do botão e preservação das ações do cabeçalho.
