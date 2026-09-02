import type { Config } from "tailwindcss";

const config: Config = {
  // Strategy: attribute selector to allow runtime swap via <html data-theme="dark">.
  darkMode: ["class", "[data-theme='dark']"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // Foundation
        bg: "var(--color-bg)",
        surface: {
          DEFAULT: "var(--color-surface)",
          elevated: "var(--color-surface-elevated)",
        },
        overlay: "var(--color-overlay)",
        text: {
          DEFAULT: "var(--color-text)",
          muted: "var(--color-text-muted)",
          subtle: "var(--color-text-subtle)",
        },

        // Accent — Sage scale
        accent: {
          DEFAULT: "var(--color-accent)",
          foreground: "var(--color-accent-fg)",
          soft: "var(--color-accent-soft)",
          hover: "var(--color-accent-hover)",
          50: "var(--color-accent-50)",
          100: "var(--color-accent-100)",
          200: "var(--color-accent-200)",
          300: "var(--color-accent-300)",
          400: "var(--color-accent-400)",
          500: "var(--color-accent-500)",
          600: "var(--color-accent-600)",
          700: "var(--color-accent-700)",
          800: "var(--color-accent-800)",
          900: "var(--color-accent-900)",
          950: "var(--color-accent-950)",
        },

        // Link — texto acionável. Separado da accent porque o piso é outro:
        // texto precisa de 4,5 e fundo de botão precisa de 3,0. Ver o bloco
        // `--color-link` em `app/globals.css`.
        link: {
          DEFAULT: "var(--color-link)",
          hover: "var(--color-link-hover)",
        },

        // Neutrals — greige
        neutral: {
          50: "var(--color-neutral-50)",
          100: "var(--color-neutral-100)",
          200: "var(--color-neutral-200)",
          300: "var(--color-neutral-300)",
          400: "var(--color-neutral-400)",
          500: "var(--color-neutral-500)",
          600: "var(--color-neutral-600)",
          700: "var(--color-neutral-700)",
          800: "var(--color-neutral-800)",
          900: "var(--color-neutral-900)",
          950: "var(--color-neutral-950)",
        },

        // States
        success: {
          DEFAULT: "var(--color-success)",
          bg: "var(--color-success-bg)",
          fg: "var(--color-success-fg)",
        },
        warning: {
          DEFAULT: "var(--color-warning)",
          bg: "var(--color-warning-bg)",
          fg: "var(--color-warning-fg)",
        },
        error: {
          DEFAULT: "var(--color-error)",
          bg: "var(--color-error-bg)",
          fg: "var(--color-error-fg)",
        },
        info: {
          DEFAULT: "var(--color-info)",
          bg: "var(--color-info-bg)",
          fg: "var(--color-info-fg)",
        },

        // shadcn aliases (compat com componentes ainda não migrados)
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        input: "var(--color-border)",
        ring: "var(--color-accent-500)",
        background: "var(--color-bg)",
        foreground: "var(--color-text)",
        primary: {
          DEFAULT: "var(--color-accent)",
          foreground: "var(--color-accent-fg)",
        },
        secondary: {
          DEFAULT: "var(--color-surface-elevated)",
          foreground: "var(--color-text)",
        },
        destructive: {
          DEFAULT: "var(--color-error)",
          foreground: "#ffffff",
        },
        muted: {
          DEFAULT: "var(--color-surface-elevated)",
          foreground: "var(--color-text-muted)",
        },
        popover: {
          DEFAULT: "var(--color-surface)",
          foreground: "var(--color-text)",
        },
        card: {
          DEFAULT: "var(--color-surface)",
          foreground: "var(--color-text)",
        },
      },
      fontFamily: {
        // Fachada (telas de antes de entrar) — ver o bloco das fontes em
        // `app/layout.tsx`. Não são a fonte do produto; são as do desenho do
        // `/login`, e só ele as usa.
        display: [
          "var(--font-archivo)",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        fachada: [
          "var(--font-public-sans)",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        sans: [
          "var(--font-atkinson)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      spacing: {
        0: "var(--space-0)",
        1: "var(--space-1)",
        2: "var(--space-2)",
        3: "var(--space-3)",
        4: "var(--space-4)",
        5: "var(--space-5)",
        6: "var(--space-6)",
        8: "var(--space-8)",
        10: "var(--space-10)",
        12: "var(--space-12)",
        16: "var(--space-16)",
        20: "var(--space-20)",
        24: "var(--space-24)",
        32: "var(--space-32)",
      },
      borderRadius: {
        none: "var(--radius-none)",
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius-md)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        full: "var(--radius-full)",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        none: "none",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
        spring: "var(--ease-spring)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
        slow: "var(--duration-slow)",
      },
      zIndex: {
        base: "0",
        raised: "10",
        dropdown: "20",
        sticky: "30",
        modal: "40",
        toast: "50",
      },
    },
  },
  plugins: [],
};

export default config;
