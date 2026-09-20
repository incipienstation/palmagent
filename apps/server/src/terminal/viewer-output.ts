/**
 * Native terminals answer escape-sequence queries themselves. The host already
 * answered them, so omit those queries (and clipboard access) from CLI output.
 * Keep incomplete sequences across PTY chunks; ordinary rendering is unchanged.
 */
export class ViewerOutput {
  private pending = "";
  write(data: string): string {
    let output = "";
    for (const char of data) {
      if (!this.pending) {
        if (char === "\x1b") this.pending = char;
        else output += char;
        continue;
      }
      this.pending += char;
      const kind = this.pending[1];
      if (this.pending.length === 2 && ["[", "]", "P", "(", ")", "*", "+", "#", "%"].includes(kind)) continue;
      if (kind === "[") {
        if (!/[@-~]/.test(char)) continue;
        const query = /^\x1b\[[?>=]?[0-9;]*[cn]$/.test(this.pending) || /^\x1b\[[0-9;]*t$/.test(this.pending);
        if (!query) output += this.pending;
      } else if (kind === "]" || kind === "P") {
        if (char !== "\x07" && !this.pending.endsWith("\x1b\\")) {
          // Do not retain unbounded application-controlled control strings.
          if (this.pending.length > 65_536) throw new Error("Terminal control sequence is too large");
          continue;
        }
        const query = kind === "P" && this.pending.startsWith("\x1bP$q") ||
          kind === "]" && (/^\x1b\]52;/.test(this.pending) || /^\x1b\](4|10|11|12);.*\?/.test(this.pending));
        if (!query) output += this.pending;
      } else output += this.pending;
      this.pending = "";
    }
    return output;
  }
}
