---
impacto: capacidade_nova
secao: adicionado
titulo: Conectar a assinatura do ChatGPT (login do Codex) pela própria tela, com a chave da organização como reserva
---
Em **Administração › Recursos opcionais** (`/admin/sistema`) aparece um interruptor novo, **Login do Codex por assinatura**, desligado por padrão, e um painel com o link de acesso do Codex: quem administra abre o link, entra com a conta que tem a assinatura e cola no painel o código que o navegador deixa em `localhost:1455`. O login usa PKCE, o token é guardado cifrado no mesmo padrão das chaves de IA e é renovado sozinho antes de vencer; se a assinatura falhar, a chamada continua caindo na reserva de sempre — a chave de API da organização. O aviso da própria tela diz, com todas as letras, que o `client_id` e o `redirect_uri` são os do Codex e que nada disso é contrato público da OpenAI. Nada a fazer para quem não quiser usar: o recurso nasce desligado, e ligar o caminho do agente é a próxima parte.

Crédito: Contribuição de @webtecnica

PR #1672
