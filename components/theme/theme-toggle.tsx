"use client";

import { useTheme } from "@/lib/theme";
import { useHotkeys } from "react-hotkeys-hook";
import { Sun, Moon, MonitorPlay } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const cycle = () => {
    setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  };

  useHotkeys("mod+shift+l", cycle, { preventDefault: true }, [theme]);

  const Icon = theme === "dark" ? Moon : theme === "system" ? MonitorPlay : Sun;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`Tema: ${theme}. Cmd+Shift+L para alternar.`}
      // O servidor não sabe a preferência salva no navegador do usuário --
      // renderiza um valor default e o cliente corrige pro valor real assim
      // que hidrata. É o mismatch ESPERADO de todo seletor de tema; React
      // "corrige" sozinho no primeiro render, só reclamava no console.
      suppressHydrationWarning
    >
      <Icon size={16} aria-hidden />
    </Button>
  );
}
