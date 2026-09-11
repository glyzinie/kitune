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

function customPalette(color: string): Palette {
  const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const mix = (channels: number[], target: number, amount: number) =>
    channels.map((channel) => Math.round(channel * (1 - amount) + target * amount));
  const hex = (channels: number[]) => `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  const luminance = (channels: number[]) => channels.reduce((sum, channel, index) => {
    const value = channel / 255;
    return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);

  // Preserve the configured primary color while keeping text readable.
  const darkText = luminance(rgb) > 0.179;
  const secondaryHover = mix(rgb, 235, 0.9);
  let text = rgb;
  // This is the darkest surface used behind accent text.
  while ((luminance(secondaryHover) + 0.05) / (luminance(text) + 0.05) < 4.5) text = mix(text, 0, 0.1);
  return {
    background: hex(mix(rgb, 255, 0.94)), surface: "#ffffff",
    foreground: hex(mix(rgb, 28, 0.9)), muted: hex(mix(rgb, 95, 0.9)),
    border: hex(mix(rgb, 214, 0.85)), "input-border": hex(mix(rgb, 120, 0.9)),
    color, contrast: darkText ? "#000000" : "#ffffff",
    hover: hex(mix(rgb, darkText ? 255 : 0, 0.12)), text: hex(text),
    secondary: hex(mix(rgb, 248, 0.93)), "secondary-hover": hex(secondaryHover),
    "secondary-text": hex(text),
  };
}

/** Config validation limits these values to known presets and hex colors. */
export function themeStyles({ theme, theme_color }: { theme?: ThemeName; theme_color?: string }) {
  const palette = theme ? presets[theme] : theme_color ? customPalette(theme_color) : presets.amber;
  return `:root{${Object.entries(palette).map(([name, value]) => `--theme-${name}:${value}`).join(";")}}`;
}
