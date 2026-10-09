import expansion from "./assets/expansion.webp?url";
import robots from "./assets/robots.webp?url";
// Normalized source rectangles preserve the generated silhouettes and their aspect ratios.
export const unitFrames = [
  [0.065, 0.12, 0.22, 0.27], [0.395, 0.12, 0.205, 0.285], [0.725, 0.12, 0.205, 0.285],
  [0.025, 0.63, 0.29, 0.235], [0.365, 0.56, 0.245, 0.305], [0.635, 0.54, 0.36, 0.34],
] as const;
export const expansionTexture = { key: "expansion", url: expansion };
export const robotTexture = { key: "robots", url: robots };
export const robotFrames = [
  [0.009, 0.12, 0.318, 0.295], [0.337, 0.12, 0.309, 0.305], [0.657, 0.12, 0.317, 0.305],
  [0.045, 0.508, 0.253, 0.397], [0.372, 0.51, 0.24, 0.401], [0.695, 0.509, 0.242, 0.404],
] as const;
export const expansionFrames = {
  mine: [0.055, 0.115, 0.22, 0.30], drone: [0.35, 0.112, 0.295, 0.325], chest: [0.71, 0.112, 0.265, 0.35],
  bolt: [0.038, 0.532, 0.285, 0.385], blade: [0.375, 0.533, 0.255, 0.38], arc: [0.743, 0.55, 0.205, 0.365],
} as const;
