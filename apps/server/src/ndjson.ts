// The #1 bug in CLI-wrapping: a single stdout chunk can split a JSON line in
// half. Buffer chunks, split on \n, and carry the partial trailing line across
// chunk boundaries. Returns a function you feed raw chunks to.

export function makeNdjsonSplitter(onLine: (line: string) => void): {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk.toString();
      let nl: number;
      // Emit every complete line; whatever remains after the last \n stays in buf.
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const trimmed = line.replace(/\r$/, "").trim();
        if (trimmed) onLine(trimmed);
      }
    },
    flush() {
      const trimmed = buf.replace(/\r$/, "").trim();
      buf = "";
      if (trimmed) onLine(trimmed);
    },
  };
}
