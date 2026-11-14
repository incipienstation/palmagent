import type { DiscoveredRepo } from "@palmagent/shared";

/** Rank plausible leaf-name corrections, preserving discovery order for equal distances. */
export function repositorySuggestions(name: string, repos: readonly Pick<DiscoveredRepo, "path" | "name">[]): string[] {
  const leaf = name.toLowerCase();
  return repos.map(repo => ({ path: repo.path, distance: levenshtein(leaf, repo.name.toLowerCase()) }))
    .filter(candidate => candidate.distance <= Math.max(2, Math.floor(leaf.length / 2)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(candidate => candidate.path);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
