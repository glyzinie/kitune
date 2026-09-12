export const themeNames = ["lavender", "blue", "sage", "amber"] as const;
type ThemeName = typeof themeNames[number];
type Palette = Record<
  "background" | "surface" | "foreground" | "muted" | "border" | "input-border" |
  "color" | "contrast" | "hover" | "text" | "secondary" | "secondary-hover" | "secondary-text",
  string
>;

const presets: Record<ThemeName, Palette> = {
  lavender: {
    background: "#f8f5fc", surface: "#ffffff", foreground: "#302638", muted: "#73657f",
    border: "#e4dced", "input-border": "#9785a6",
    color: "#e2d5f3", contrast: "#49305f", hover: "#d5c2ed", text: "#70478d",
    secondary: "#f1ebf7", "secondary-hover": "#e7dcf0", "secondary-text": "#624d73",
  },
  blue: {
    background: "#f3f7fc", surface: "#ffffff", foreground: "#233449", muted: "#5c6f85",
    border: "#d7e2ef", "input-border": "#7d96b0",
    color: "#d1e4fa", contrast: "#244a72", hover: "#bed8f4", text: "#315f91",
    secondary: "#eaf1f9", "secondary-hover": "#dce8f5", "secondary-text": "#415d7b",
  },
  sage: {
    background: "#f5f8f3", surface: "#ffffff", foreground: "#2e3a2d", muted: "#63745d",
    border: "#dce5d6", "input-border": "#7c9274",
    color: "#dce8d5", contrast: "#36532c", hover: "#cbdcbe", text: "#4b6a3d",
    secondary: "#edf2e8", "secondary-hover": "#e0e9d8", "secondary-text": "#526649",
  },
  amber: {
    background: "#fcf8f0", surface: "#ffffff", foreground: "#413321", muted: "#7c6951",
    border: "#eadfc9", "input-border": "#9b8056",
    color: "#f4dfb4", contrast: "#654415", hover: "#ecd095", text: "#8a5b22",
    secondary: "#f7efdf", "secondary-hover": "#efe1c7", "secondary-text": "#78603b",
  },
};

export function themeStyles({ theme }: { theme?: ThemeName }) {
  const palette = presets[theme ?? "amber"];
  return `:root{${Object.entries(palette).map(([name, value]) => `--theme-${name}:${value}`).join(";")}}`;
}
