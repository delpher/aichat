import { useEffect, useState } from "react";
import { KEYS, storage } from "../lib/storage";

export type Theme = "system" | "light" | "dark";
const ORDER: Theme[] = ["system", "light", "dark"];

/** Light / dark / follow the system; stored per browser and applied as <html data-theme>. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = storage.get(KEYS.theme) as Theme | null;
    return t && ORDER.includes(t) ? t : "system";
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = theme;
    storage.set(KEYS.theme, theme);
  }, [theme]);
  const next = () => setTheme((t) => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]);
  return { theme, next };
}
