---
impacto: capacidade_nova
secao: adicionado
titulo: Conectar a assinatura do ChatGPT (login do Codex) pela própria tela, com a chave da organização como reserva
---
Em **Administração › Recursos opcionais** (`/admin/sistema`) aparece um interruptor novo, **Login do Codex por assinatura**, desligado por padrão — só quem administra a instalação liga. Ligado, **cada empresa conecta a própria conta** no painel que aparece em **Credenciais**, no mesmo lugar onde ela já guarda as chaves de IA: quem revende escolhe se conecta a conta dele em cada empresa ou deixa o cliente conectar a dele. O painel traz o link de acesso do Codex — quem abre entra com a conta que tem a assinatura e cola o endereço em que o navegador parou (`localhost:1455`, a página não abre e é esperado). O retorno colado só é aceito se veio do link que aquela pessoa abriu, naquela empresa (o `state` é assinado e conferido antes da troca). O login usa PKCE, o par de tokens é guardado cifrado na tabela de credenciais da empresa (`ai_provider_credentials`, AES-GCM, mesmas colunas das chaves) e é renovado sozinho antes de vencer — na janela de 8 dias e na hora em que o sistema acordar —, com uma trava de renovação NO BANCO que vale entre os processos (`app`, `worker` e `scheduler`); se a assinatura falhar, a chamada continua caindo na reserva de sempre — a chave de API da própria empresa. O aviso da própria tela diz, com todas as letras, que o `client_id` e o `redirect_uri` são do Codex e que nada disso é contrato público da OpenAI. Com o interruptor desligado, nada aparece para as empresas e nenhuma leitura decifra as linhas já conectadas. Nada a fazer para quem não quiser usar: o recurso nasce desligado — e, ligado, a fiação já vem pronta: o agente fala pela assinatura e cai na chave da própria empresa quando ela não responde.

Crédito: Contribuição de @webtecnica

PR #1672
