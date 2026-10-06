import { makePrRef, type PrRef } from "@palmagent/shared";

/** Creation evidence admits a PR; previously fetched metadata never admits one by itself. */
export function projectConfirmedPrs(previous: PrRef[], confirmedUrls: Iterable<string>, rebuild = false): PrRef[] {
  const metadata = new Map(previous.map(pr => [pr.url, pr]));
  const projected = rebuild ? new Map<string, PrRef>() : new Map(metadata);
  for (const url of confirmedUrls) {
    const ref = metadata.get(url) ?? makePrRef(url);
    if (ref && !projected.has(url)) projected.set(url, ref);
  }
  return [...projected.values()];
}
