/**
 * A régua do design system, congelada em módulo — a fonte da derivação em RUNTIME.
 *
 * POR QUE ESTE ARQUIVO EXISTE, e não um `readFileSync("app/globals.css")`:
 *
 * A imagem de produção é `output: "standalone"` (next.config.ts) e o Dockerfile
 * copia para o runner apenas `.next/standalone`, `.next/static` e `public/`. O
 * `app/globals.css` NÃO existe no contêiner que o self-hoster roda. Um
 * `readFileSync` no caminho de render do `app/layout.tsx` daria ENOENT — 500 em
 * todas as telas, na VPS de quem a feature existe para servir, e verde em dev,
 * em teste e na Vercel. É o mesmo modo de falha que `lib/branding.ts` documenta
 * para o `NEXT_PUBLIC_*`.
 *
 * A separação também é a certa conceitualmente: a RÉGUA é do produto e nasce
 * congelada no build; a COR é da instalação e só existe em runtime. Só a segunda
 * precisa ser lida do ambiente.
 *
 * ESTE ARQUIVO É GERADO. Não edite à mão: ele é o `extrairRegua()` aplicado ao
 * `app/globals.css`. `tests/unit/branding-regua-do-produto.test.ts` compara os
 * dois a cada run e imprime o literal novo na mensagem de falha — mexeu na
 * paleta, o teste reprova e entrega o texto para colar aqui.
 */

import type { Regua } from "./contraste";

export const REGUA_DO_PRODUTO: Regua = {
  "rampaDoProduto": [
    "#f0f5ff",
    "#dfebff",
    "#bfd6ff",
    "#95bbff",
    "#6c9fff",
    "#4a85f9",
    "#3b6fd4",
    "#3158a4",
    "#294882",
    "#253c6a",
    "#0d1b36"
  ],
  "claro": {
    "nome": "claro",
    "base": [
      {
        "chave": "--color-bg",
        "hex": "#0b0e14"
      },
      {
        "chave": "--color-surface",
        "hex": "#0e1624"
      },
      {
        "chave": "--color-surface-elevated",
        "hex": "#0a1f44"
      }
    ],
    "tingidas": [
      {
        "chave": "--color-accent-soft",
        "fonte": {
          "tipo": "literal",
          "hex": "#0d1b36",
          "alfa": 0.08
        }
      }
    ],
    "papeis": [
      {
        "token": "--color-accent",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-accent-fg",
        "tipo": "texto",
        "fonte": {
          "tipo": "frenteCalculada",
          "sobre": {
            "tipo": "grau",
            "indice": 6,
            "alfa": 1
          }
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 6,
            "alfa": 1
          }
        ]
      },
      {
        "token": "--color-link",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 5,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-link-hover",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 4,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-accent-hover",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 5,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--ring",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "::selection/color",
        "tipo": "texto",
        "fonte": {
          "tipo": "grau",
          "indice": 0,
          "alfa": 1
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 7,
            "alfa": 1
          }
        ]
      },
      {
        "token": ":focus-visible/outline",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      }
    ],
    "semanticas": [
      {
        "nome": "success",
        "hex": "#82a077"
      },
      {
        "nome": "warning",
        "hex": "#d09455"
      },
      {
        "nome": "error",
        "hex": "#c87263"
      },
      {
        "nome": "info",
        "hex": "#7da9bf"
      }
    ],
    "neutros": [
      "#f2f5fb",
      "#dbe2ee",
      "#b1bfd6",
      "#7c90b3",
      "#4d6692",
      "#29426f",
      "#0a1f44",
      "#0f1f3b",
      "#121f35",
      "#141e30",
      "#161d28"
    ],
    "indices": {
      "accent": 6,
      "hover": 5,
      "soft": null
    },
    "alfaDoSoft": 0.08
  },
  "escuro": {
    "nome": "escuro",
    "base": [
      {
        "chave": "--color-bg",
        "hex": "#0b0e14"
      },
      {
        "chave": "--color-surface",
        "hex": "#0e1624"
      },
      {
        "chave": "--color-surface-elevated",
        "hex": "#0a1f44"
      }
    ],
    "tingidas": [
      {
        "chave": "--color-accent-soft",
        "fonte": {
          "tipo": "literal",
          "hex": "#0d1b36",
          "alfa": 0.08
        }
      }
    ],
    "papeis": [
      {
        "token": "--color-accent",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-accent-fg",
        "tipo": "texto",
        "fonte": {
          "tipo": "frenteCalculada",
          "sobre": {
            "tipo": "grau",
            "indice": 6,
            "alfa": 1
          }
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 6,
            "alfa": 1
          }
        ]
      },
      {
        "token": "--color-accent-hover",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 5,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-link",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 5,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-link-hover",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 4,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--ring",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "[data-theme=\"dark\"] ::selection/color",
        "tipo": "texto",
        "fonte": {
          "tipo": "grau",
          "indice": 0,
          "alfa": 1
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 7,
            "alfa": 1
          }
        ]
      },
      {
        "token": "[data-theme=\"dark\"] :focus-visible/outline-color",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      }
    ],
    "semanticas": [
      {
        "nome": "success",
        "hex": "#82a077"
      },
      {
        "nome": "warning",
        "hex": "#d09455"
      },
      {
        "nome": "error",
        "hex": "#c87263"
      },
      {
        "nome": "info",
        "hex": "#7da9bf"
      }
    ],
    "neutros": [
      "#f2f5fb",
      "#dbe2ee",
      "#b1bfd6",
      "#7c90b3",
      "#4d6692",
      "#29426f",
      "#0a1f44",
      "#0f1f3b",
      "#121f35",
      "#141e30",
      "#161d28"
    ],
    "indices": {
      "accent": 6,
      "hover": 5,
      "soft": null
    },
    "alfaDoSoft": 0.08
  },
  "superficieClara": {
    "nome": "superficie-clara",
    "base": [
      {
        "chave": "--color-bg",
        "hex": "#f4f5f7"
      },
      {
        "chave": "--color-surface",
        "hex": "#ffffff"
      },
      {
        "chave": "--color-surface-elevated",
        "hex": "#e9ecf2"
      }
    ],
    "tingidas": [
      {
        "chave": "--color-accent-soft",
        "fonte": {
          "tipo": "literal",
          "hex": "#3b6fd4",
          "alfa": 0.1
        }
      }
    ],
    "papeis": [
      {
        "token": "--color-accent",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-accent-fg",
        "tipo": "texto",
        "fonte": {
          "tipo": "frenteCalculada",
          "sobre": {
            "tipo": "grau",
            "indice": 6,
            "alfa": 1
          }
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 6,
            "alfa": 1
          }
        ]
      },
      {
        "token": "--color-link",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 7,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-link-hover",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 8,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-accent-hover",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 7,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--ring",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "::selection/color",
        "tipo": "texto",
        "fonte": {
          "tipo": "grau",
          "indice": 0,
          "alfa": 1
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 7,
            "alfa": 1
          }
        ]
      },
      {
        "token": ":focus-visible/outline",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      }
    ],
    "semanticas": [
      {
        "nome": "success",
        "hex": "#3f6b34"
      },
      {
        "nome": "warning",
        "hex": "#7a4f12"
      },
      {
        "nome": "error",
        "hex": "#a3352a"
      },
      {
        "nome": "info",
        "hex": "#1f5468"
      }
    ],
    "neutros": [
      "#f2f5fb",
      "#dbe2ee",
      "#b1bfd6",
      "#7c90b3",
      "#4d6692",
      "#29426f",
      "#0a1f44",
      "#0f1f3b",
      "#121f35",
      "#141e30",
      "#161d28"
    ],
    "indices": {
      "accent": 6,
      "hover": 7,
      "soft": null
    },
    "alfaDoSoft": 0.1
  }
};
