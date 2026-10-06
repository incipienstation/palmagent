import type { Level } from "./engine";

// Authored prototype progression. Reachability and shortest-turn progression
// are checked independently in the game contract tests. No downloaded levels.
export const LEVELS: readonly Level[] = [
  { title: "First bloom", lesson: "Grow the last bud. A tap moves Seed → Bud → Bloom → Seed.",
    initial: [1, 2, 2], links: [] },
  { title: "A little echo", lesson: "Tap A into bloom, then let its echo grow B.",
    initial: [1, 1, 2], links: [[0, 1, 1]] },
  { title: "Passing it on", lesson: "Only a tap into bloom sends an echo. An arriving echo grows a plant quietly.",
    initial: [0, 0, 1], links: [[0, 1, 1], [1, 2, 1]] },
  { title: "A longer path", lesson: "Plan which buds to tap and which to leave for an echo.",
    initial: [0, 1, 0, 1], links: [[0, 1, 1], [1, 2, 1], [2, 3, 1]] },
  { title: "Branching out", lesson: "One bloom can send echoes down two paths.",
    initial: [0, 0, 1, 0], links: [[0, 1, 1], [0, 2, 1], [2, 3, 1]] },
  { title: "Coming home", lesson: "An echo can come back around. Watch the flowers you have already grown.",
    initial: [0, 0, 0, 0], links: [[0, 1, 1], [1, 2, 1], [2, 3, 1], [3, 0, 1]] },
  { title: "Meeting in the middle", lesson: "Echoes that meet both count. Two arrivals grow a plant twice.",
    initial: [0, 0, 0, 0, 0], links: [[0, 2, 1], [1, 2, 1], [2, 3, 1], [3, 4, 1]] },
  { title: "A slower echo", lesson: "A path marked 2 takes two more turns to arrive. Waiting also counts as a turn.",
    initial: [0, 0, 0, 0, 0], links: [[0, 1, 2], [1, 2, 1], [2, 3, 1], [3, 4, 1]] },
  { title: "Two tempos", lesson: "Short and long echoes travel together. Read the pending arrivals before each move.",
    initial: [0, 0, 0, 0, 0], links: [[0, 1, 2], [1, 2, 1], [2, 3, 2], [3, 4, 1], [4, 0, 1]] },
  { title: "Across the garden", lesson: "Six plants, two tempos. Make room for the echoes still on their way.",
    initial: [0, 0, 0, 0, 0, 0], links: [[0, 1, 1], [1, 2, 2], [2, 3, 1], [3, 4, 2], [4, 5, 1]] },
  { title: "Crossing paths", lesson: "A shortcut changes two parts of the garden. Try a different order if you get stuck.",
    initial: [0, 0, 0, 0, 0, 0], links: [[0, 1, 1], [1, 2, 2], [2, 3, 1], [3, 4, 2], [4, 5, 1], [5, 0, 2], [1, 4, 1]] },
  { title: "The whole garden", lesson: "Bring everything into bloom, with no echoes left to disturb it.",
    initial: [0, 0, 0, 0, 0, 0], links: [[0, 1, 2], [1, 2, 1], [2, 3, 2], [3, 4, 1], [4, 5, 2], [5, 0, 1], [0, 3, 1], [2, 5, 1]] },
];
