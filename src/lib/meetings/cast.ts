// Canonical cast of the executive meeting. Each character has a
// "botified" name and a fixed visual description so comics across
// weeks feel like the same company. Never describe any character by
// a real person's physical features — these are explicitly robots.
//
// Visuals are kept deliberately stylised and distinct silhouettes so
// users can identify characters in speech bubbles at a glance.

import type { Role } from './schema';

export type CharacterSheet = {
  role: Role;
  // Display name (always -bot or equivalent to make it clear this is
  // a fictional character, never a real person).
  name: string;
  // One-line personality for the comic writer to lean into.
  personality: string;
  // Fixed visual signature the image model can render consistently.
  // Always robotic / mechanical to avoid any real-person likeness.
  visual: string;
};

export const CAST: Record<Role, CharacterSheet> = {
  warren_buffbot: {
    role: 'warren_buffbot',
    name: 'Warren Buffbot',
    personality:
      'Warm, folksy, value-oriented. Thinks long-term. Pauses and reflects before deciding. Loves a good metaphor about moats, margin of safety, and diet soda.',
    visual:
      'Stocky friendly robot with a rounded boxy chassis in warm beige enamel, oversized round rivets-for-glasses that make him look owlish, a neat mechanical bow-tie, and a small red Nebraska pin on his lapel. Short antenna on top. Gentle stance, hands usually clasped.',
  },
  charlie_mungbot: {
    role: 'charlie_mungbot',
    name: 'Charlie Mungbot',
    personality:
      'Sharp, dry, contrarian. The abominable no-bot. Delivers blunt one-liners. Pokes holes in Warren’s warmest ideas. Agrees only when actually convinced.',
    visual:
      'Taller angular robot with a slate-grey chassis and slightly crooked posture, a chromed monocle over one optical sensor, thick analog book under one arm, and a raised index finger for emphasis. Small satellite dish ear. Perpetual faint frown.',
  },
  analyst: {
    role: 'analyst',
    name: 'the Analyst',
    personality:
      'Data-heavy, precise. Cites P/E, ROE, D/E by memory. Prefers numbers to narratives.',
    visual:
      'Sleek mid-size robot in matte navy, with a translucent display panel in the chest cycling tiny spreadsheets, a spindly stylus arm, and a crisp lab-coat-style plate over the torso. Eye sensors glow pale blue.',
  },
  risk: {
    role: 'risk',
    name: 'the Risk Officer',
    personality:
      'Conservative. Watches drawdowns, concentration, correlation. Raises downside scenarios first.',
    visual:
      'Bulky robot with reinforced amber chassis, hazard stripes across the forearms, and a pop-up heads-up display showing drawdown meters. Squat, grounded stance. A small hardhat indicator on top.',
  },
  operations: {
    role: 'operations',
    name: 'the Operations Lead',
    personality:
      'Pragmatic, audit-minded. Runs the weekly numbers — what trades fired, what missed, what the agent did vs. should have done. Catches drift.',
    visual:
      'Nimble silver-grey robot with a utility-belt of small terminal screens, a clipboard with blinking LED checkmarks, and an extra articulated arm holding a tiny keyboard. Always mid-gesture.',
  },
};

// Dense description of the full cast for the image prompt — inserted
// verbatim so every comic renders the same silhouettes.
export function castSheet(): string {
  const lines = Object.values(CAST).map(
    (c) => `• ${c.name}: ${c.visual}`
  );
  return `CAST (use these exact visual descriptions for every panel — consistency across meetings matters):\n${lines.join('\n')}`;
}

export function nameForRole(role: Role): string {
  return CAST[role].name;
}
