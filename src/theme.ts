/** Generate theme variables from the hex color validated by configSchema. */
export function themeStyles(color: string | undefined) {
  if (!color) return "";
  const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const mix = (channels: number[], target: number, amount: number) =>
    channels.map((channel) => Math.round(channel * (1 - amount) + target * amount));
  const hex = (channels: number[]) => `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  const luminance = (channels: number[]) => channels.reduce((sum, channel, index) => {
    const value = channel / 255;
    return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);

  // Choose readable button text; hover increases its contrast with the fill.
  const darkText = luminance(rgb) > 0.179;
  let text = rgb;
  // Darken light accents for small text and focus outlines on light surfaces.
  while (luminance(text) > 0.16) text = mix(text, 0, 0.1);
  return `:root{--theme-color:${color};--theme-contrast:${darkText ? "#000000" : "#ffffff"};--theme-hover:${hex(mix(rgb, darkText ? 255 : 0, 0.12))};--theme-text:${hex(text)};--theme-background:${hex(mix(rgb, 255, 0.94))}}`;
}
