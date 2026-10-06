/** Parse the install.env KEY=VALUE format shared by runtime and operator flows. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const val = line.slice(eq + 1).trim();
    if (val !== "") out[line.slice(0, eq).trim()] = val;
  }
  return out;
}
