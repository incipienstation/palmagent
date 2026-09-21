import { Fragment } from "react";
import { Highlight, Prism, type PrismTheme } from "prism-react-renderer";

const theme: PrismTheme = {
  plain: { color: "var(--color-strong)", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype"], style: { color: "var(--muted-foreground)" } },
    { types: ["keyword", "tag", "boolean"], style: { color: "var(--primary)" } },
    { types: ["string", "attr-value"], style: { color: "var(--color-green)" } },
    { types: ["number", "constant", "symbol"], style: { color: "var(--color-amber)" } },
    { types: ["function", "class-name"], style: { color: "var(--color-blue)" } },
  ],
};
const aliases: Record<string, string> = { js: "javascript", ts: "typescript", sh: "bash", shell: "bash", py: "python", yml: "yaml", html: "markup" };

export default function CodeHighlight({ source, language }: { source: string; language: string }) {
  const name = aliases[language.toLowerCase()] ?? language.toLowerCase();
  if (!Object.hasOwn(Prism.languages, name)) return <>{source}</>;
  return <Highlight code={source} language={name} theme={theme}>
    {({ tokens, getTokenProps }) => tokens.map((line, index) => <Fragment key={index}>
      {index > 0 && "\n"}
      {line.map((token, key) => token.empty ? null : <span key={key} {...getTokenProps({ token })} />)}
    </Fragment>)}
  </Highlight>;
}
