/** Quote one systemd value without allowing extra directives or specifiers. */
export function quoteSystemd(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("invalid systemd unit value");
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
}
