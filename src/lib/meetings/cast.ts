// Per-strategy executive casts for meetings + comics.
//
// Each strategy has its own pair of "principals" — editorial-caricature
// "-bot" versions of figures associated with that investment philosophy.
// The three supporting roles (analyst / risk / operations) stay generic
// so the firm feels like a continuous org even as the principals rotate
// by strategy.
//
// SAFETY POSTURE — these are fictional satirical characters rendered in
// the editorial tradition of Mad Magazine / CRACKED caricature:
//   • Names always end in "-bot" to signal parody/homage
//   • Visual style is exaggerated editorial ink, never photorealistic
//   • Dialogue is extrapolation of publicly stated philosophy, not
//     quoting any real person verbatim
//   • The art style prompt explicitly frames the output as satirical
//
// Role slots (shared across strategies):
//   principal   — the firm's figurehead
//   contrarian  — the trusted devil's advocate
//   analyst     — research lead (generic)
//   risk        — risk officer (generic)
//   operations  — ops lead (generic)

import type { StrategyKey } from '@/lib/backtest/rules';
import type { Role } from './schema';

export type CharacterSheet = {
  role: Role;
  name: string;
  // One-line personality that the meeting prompt leans into.
  personality: string;
  // Detailed visual signature for the image model. Must be editorial-
  // caricature style — exaggerated features, not photoreal. Always
  // frame as a -bot variant so the character is clearly fictional.
  visual: string;
};

export type CastBundle = {
  strategyKey: StrategyKey | 'default';
  styleNote: string; // strategy-specific visual mood for the comic
  characters: Record<Role, CharacterSheet>;
};

// Supporting roles — same across every strategy so the firm feels
// continuous. Only the principals change by strategy.
const GENERIC_ANALYST: CharacterSheet = {
  role: 'analyst',
  name: 'Ana Bytesworth-bot',
  personality:
    'Data-heavy research lead. Cites P/E, ROE, D/E by memory. Brings spreadsheets, not narratives. Calm, precise, slightly nerdy.',
  visual:
    "A young woman editorial caricature in the Mad Magazine tradition — oversized round glasses magnifying sharp eyes, dark bob haircut, crisp navy blazer, arm full of manila folders and a tablet showing tiny spreadsheet cells. Exaggerated long slender fingers tapping a calculator. Clearly a '-bot' — a small corporate ID badge labelled 'Ana Bytesworth-bot' pinned to her lapel. NOT photoreal.",
};

const GENERIC_RISK: CharacterSheet = {
  role: 'risk',
  name: 'Ray Drawdown-bot',
  personality:
    'Conservative risk officer. Watches drawdowns, concentration, regime stress. Always raises the downside scenario first.',
  visual:
    "A stocky middle-aged man editorial caricature — furrowed brow exaggerated into deep worry lines, squared-off jaw, rolled-up sleeves, hazard-stripe tie, carrying a clipboard with a red-ink drawdown chart. One eyebrow permanently raised. Name badge 'Ray Drawdown-bot'. Mad Magazine / CRACKED caricature ink style.",
};

const GENERIC_OPS: CharacterSheet = {
  role: 'operations',
  name: 'Oli Tickertape-bot',
  personality:
    'Operations lead. Reviews what the system actually did — trades fired, missed, bugs caught. Pragmatic, audit-minded.',
  visual:
    "A wiry tech-ops worker editorial caricature — sleeves pushed up, headset dangling, utility belt of tiny terminal screens, laptop balanced on one forearm, wildly spiky hair as if perpetually mid-caffeine. Name badge 'Oli Tickertape-bot'. Exaggerated CRACKED-style linework.",
};

// ─── Strategy-specific principals ──────────────────────────────────────
// These are -bot parody/homage characters inspired by figureheads
// associated with each investment style. Rendered as Mad Magazine /
// CRACKED editorial caricatures — NEVER photorealistic.

const BUFFETT_CAST: CastBundle = {
  strategyKey: 'buffett_core',
  styleNote:
    'Warm, folksy Berkshire-style boardroom. Wood-panelled walls, a chart of "intrinsic value" on an old flipchart. Cream and burgundy palette.',
  characters: {
    warren_buffbot: {
      role: 'warren_buffbot',
      name: 'Warren Buff-bot',
      personality:
        "Folksy, patient, value-oriented. Sips a Cherry-Coke knockoff. Quotes Ben Graham before breakfast. Thinks in decades. Every other sentence is a homespun metaphor about moats or diet soda.",
      visual:
        "Elderly gentleman editorial caricature in the tradition of Mad Magazine — exaggeratedly bushy white eyebrows, wispy combed-over white hair, round wire-rim glasses magnifying twinkling eyes, oversized friendly smile, rumpled dark suit, wide red Midwestern tie slightly askew, holding a can labelled 'CHERRY SODA-BOT'. Small pin on lapel reading 'Buff-bot'. Definitely a -bot parody — NOT photoreal. CRACKED-style ink crosshatch.",
    },
    charlie_mungbot: {
      role: 'charlie_mungbot',
      name: 'Charlie Mung-bot',
      personality:
        "The 'abominable no-bot'. Sharp, dry, contrarian. Delivers one-liners like knives. Pokes holes in Warren's warmest ideas. Agrees only when truly convinced.",
      visual:
        "Older gentleman editorial caricature — thick black horn-rimmed glasses enlarged to comic proportions, stocky build, thinning white hair, perpetually wry downturned mouth, thick black eyebrows raised skeptically, dark suit and rumpled bow tie, arm wrapped around a massive leather-bound book titled 'POOR CHARLIE'S ALMANAC-BOT'. Small name badge 'Mung-bot'. Mad Magazine caricature style, clearly satirical.",
    },
    analyst: GENERIC_ANALYST,
    risk: GENERIC_RISK,
    operations: GENERIC_OPS,
  },
};

const GRAHAM_CAST: CastBundle = {
  strategyKey: 'deep_value_graham',
  styleNote:
    'Dusty 1930s Columbia-style lecture hall. Chalkboards crowded with intrinsic-value formulas. Sepia and charcoal palette. Mr. Market stalks the edges of panels.',
  characters: {
    warren_buffbot: {
      role: 'warren_buffbot',
      name: 'Ben Graham-bot',
      personality:
        "Scholarly, methodical, the father of value investing. Always calculating net-net working capital. Speaks in formulas. Unflappable, a touch professorial, occasionally dryly witty.",
      visual:
        "Mid-century scholar caricature — bow-tied, round wire spectacles slipped to the end of a long nose, thinning combed-back dark hair, tweed jacket with elbow patches, holding a ledger labelled 'SECURITY ANALYSIS-BOT', chalk dust on his sleeves. Exaggerated tall forehead and furrowed brow of a man mid-calculation. Pocket square. Name tag 'Graham-bot'. Editorial caricature, sepia ink, Mad Magazine style.",
    },
    charlie_mungbot: {
      role: 'charlie_mungbot',
      name: 'Mr. Market-bot',
      personality:
        "Graham's personified market — not a person, a moody embodiment of the market itself. Today euphoric, tomorrow despairing. Offers absurd prices that Graham calmly ignores. The comic should give him a wild bipolar energy.",
      visual:
        "Two-faced editorial caricature — one side maniacally grinning bull (horn-rim hat, green tie, coin-showering pockets), other side despondent bear (drooping ears, deflated posture, shedding coins). Clothes mismatched and half-torn. Arms open wide offering a tray of random price tags. Name badge flickering between 'BUY!!!' and 'SELL!!!'. Clearly a '-bot' parody — Mad Magazine caricature style, bold ink, exaggerated features.",
    },
    analyst: GENERIC_ANALYST,
    risk: GENERIC_RISK,
    operations: GENERIC_OPS,
  },
};

const QUALITY_CAST: CastBundle = {
  strategyKey: 'quality_compounders',
  styleNote:
    'Modern London boardroom. Clean lines, leather chairs, a whiteboard of compound-growth curves. Slate blue and brass palette.',
  characters: {
    warren_buffbot: {
      role: 'warren_buffbot',
      name: 'Terry Smythe-bot',
      personality:
        "Sharp, no-nonsense British value-quality investor. 'Do nothing' is a complete investment strategy. Impatient with fads. Dry wit.",
      visual:
        "Middle-aged gentleman editorial caricature — crisp dark suit, rimless glasses enlarged to comic proportion, salt-and-pepper hair combed sharply back, narrow pointing finger, mouth mid-'absolutely not'. Exaggerated angular features. A small Union Jack pin on the lapel. Name badge 'Smythe-bot'. Mad Magazine caricature ink, not photoreal.",
    },
    charlie_mungbot: {
      role: 'charlie_mungbot',
      name: 'Nick Trayne-bot',
      personality:
        "Softer, tweedy, long-term quality-at-any-price partner. Looks at 20-year horizons. Sips tea. Speaks in patient paragraphs. The counterweight to Terry's sharp edges.",
      visual:
        "Tweed-jacketed gentleman editorial caricature — round tortoiseshell glasses, unkempt grey-brown hair, mug of tea in hand, waistcoat with pocket-watch chain. Relaxed grin, gentle eyes. Name badge 'Trayne-bot'. Editorial caricature, Mad Magazine style.",
    },
    analyst: GENERIC_ANALYST,
    risk: GENERIC_RISK,
    operations: GENERIC_OPS,
  },
};

const DIVIDEND_CAST: CastBundle = {
  strategyKey: 'dividend_growth',
  styleNote:
    'Old-money club library. Leather chesterfields, dividend-per-share histories framed on wood walls, pocket watches everywhere. Burgundy and gold palette.',
  characters: {
    warren_buffbot: {
      role: 'warren_buffbot',
      name: 'The Aristocrat-bot',
      personality:
        'Personified ideal dividend investor. Old-money, measured, appreciative of 25-year dividend streaks. Knows every payout ratio by heart. Patient as a glacier.',
      visual:
        "Dignified older gentleman editorial caricature — oversized top hat, monocle magnifying one eye, long tailcoat, pocket watch on a gold chain. Tiny quill in one hand, ledger of dividend-per-share histories in the other. Exaggerated upright posture. Name badge 'The Aristocrat-bot'. Mad Magazine / CRACKED caricature style, clearly editorial.",
    },
    charlie_mungbot: {
      role: 'charlie_mungbot',
      name: 'Yield-bot',
      personality:
        "Personified yield-vs-growth trade-off. Splits the difference. Nervous about dividend traps (high yield, shrinking business). A permanent calculator in hand.",
      visual:
        "A small anxious character shaped like a giant stylised percentage sign (%) with arms and legs — legs on the two circles, arms out of the slash. Beady eyes, worried mouth, glasses, a calculator strapped to one hand. Name badge 'Yield-bot'. Editorial caricature, exaggerated geometry.",
    },
    analyst: GENERIC_ANALYST,
    risk: GENERIC_RISK,
    operations: GENERIC_OPS,
  },
};

const BOGLEHEAD_CAST: CastBundle = {
  strategyKey: 'boglehead_index',
  styleNote:
    'Vanguard-style simple conference room. One whiteboard with three letters: VTI VXUS BND. Navy and cream palette. Unpretentious.',
  characters: {
    warren_buffbot: {
      role: 'warren_buffbot',
      name: 'Jack Boagle-bot',
      personality:
        'Pioneer of low-cost index investing. Gentle, persistent, anti-active-management. Recites cost ratios like scripture. Believes in three funds and nothing else.',
      visual:
        "Avuncular older gentleman editorial caricature — warm crinkly smile, wavy white hair, simple grey suit, holding up a single index card labelled 'COSTS MATTER'. Exaggerated friendly features. Name badge 'Boagle-bot'. Mad Magazine caricature style, warm ink tones.",
    },
    charlie_mungbot: {
      role: 'charlie_mungbot',
      name: 'The Three-Fund-bot',
      personality:
        'Literal embodiment of the three-fund portfolio. Simple, efficient, allergic to complexity. Speaks only in ratios. The counterweight to anyone suggesting anything clever.',
      visual:
        "A stylised robot with three articulated arms each holding a differently-coloured puck labelled respectively 'VTI' (US stocks), 'VXUS' (ex-US stocks), and 'BND' (bonds). Square minimalist chassis, single friendly oval eye. Name badge 'Three-Fund-bot'. Mad Magazine / editorial caricature — clean, almost diagrammatic.",
    },
    analyst: GENERIC_ANALYST,
    risk: GENERIC_RISK,
    operations: GENERIC_OPS,
  },
};

// Fallback when we can't determine the strategy (legacy meetings,
// crypto-only accounts, etc.). Uses the Buffett cast since that's the
// flagship.
const DEFAULT_CAST: CastBundle = { ...BUFFETT_CAST, strategyKey: 'default' };

const CASTS_BY_STRATEGY: Record<StrategyKey, CastBundle> = {
  buffett_core: BUFFETT_CAST,
  deep_value_graham: GRAHAM_CAST,
  quality_compounders: QUALITY_CAST,
  dividend_growth: DIVIDEND_CAST,
  boglehead_index: BOGLEHEAD_CAST,
};

// Infer a strategy key from a free-form active-strategy name. User's
// Strategy.name comes from the wizard and isn't guaranteed to be one
// of our preset keys, so we do a substring match.
export function castForStrategyName(name: string | null | undefined): CastBundle {
  if (!name) return DEFAULT_CAST;
  const n = name.toLowerCase();
  if (n.includes('graham') || n.includes('deep value')) return GRAHAM_CAST;
  if (n.includes('quality') || n.includes('compounder')) return QUALITY_CAST;
  if (n.includes('dividend')) return DIVIDEND_CAST;
  if (n.includes('boglehead') || n.includes('index')) return BOGLEHEAD_CAST;
  if (n.includes('buffett') || n.includes('warren')) return BUFFETT_CAST;
  return DEFAULT_CAST;
}

export function castForStrategyKey(key: StrategyKey | null | undefined): CastBundle {
  if (!key) return DEFAULT_CAST;
  return CASTS_BY_STRATEGY[key] ?? DEFAULT_CAST;
}

// Dense description of the cast for the comic image prompt. Renders
// verbatim into the prompt so every panel in every meeting under this
// strategy gets consistent silhouettes.
export function castSheet(bundle: CastBundle): string {
  const roles: Role[] = [
    'warren_buffbot',
    'charlie_mungbot',
    'analyst',
    'risk',
    'operations',
  ];
  const lines = roles.map((r) => {
    const c = bundle.characters[r];
    return `• ${c.name}: ${c.visual}`;
  });
  return [
    'CAST (use these EXACT visual descriptions for every panel — consistency across panels AND across meetings is essential):',
    ...lines,
    '',
    `STRATEGY MOOD: ${bundle.styleNote}`,
  ].join('\n');
}

export function nameForRole(bundle: CastBundle, role: Role): string {
  return bundle.characters[role]?.name ?? role;
}
