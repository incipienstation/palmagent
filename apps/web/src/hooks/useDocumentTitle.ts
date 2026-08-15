import { useEffect } from "react";

import { BRANDING } from "@palmagent/shared";

// Per-route `document.title` for the SPA. The static index.html `<title>` only
// covers first paint; on hash-route changes the title must be updated in JS or
// every view shares one title in the browser tab, the installed-PWA app-switcher
// entry, and (the accessibility reason) the screen-reader page announcement —
// which fires off the title on navigation.
//
// Format: page name first, brand suffix, one separator — `Tasks · PalmAgent`.
// Page-first keeps the most specific, screen-reader-announced word leading; the
// `·` matches the separator the in-app eyebrows already use. Pass an empty page
// to fall back to the bare brand (e.g. the home/auth entry).
export function useDocumentTitle(page: string) {
  useEffect(() => {
    document.title = page ? `${page} · ${BRANDING.displayName}` : BRANDING.displayName;
  }, [page]);
}
