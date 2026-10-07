// Bundled content: what the game uses until contentUrl is set, and the
// shape of the content.json you host. Remote content replaces all of it.

import type { Content } from '../types'
import { DEFAULT_ECONOMY } from './game'

export const DEFAULT_CONTENT: Content = {
  version: '1',
  minVersion: '0.1.0',
  sponsor: {
    name: 'Banana Sponsor',
    tagline: 'Click while Claude thinks. Earn LLM tokens.',
    color: 'yellow',
    banner: [
      '  _______  ',
      ' / _____ \\ ',
      '| |BANANA| |',
      ' \\_______/ ',
    ],
    lines: ['Every click earns coins; coins buy $1 of LLM tokens.', 'Coins and bananas are void after 7 days. Lifetime totals stay.'],
  },
  banana: {
    name: 'Banana Sponsor Banana',
    buttonLabel: '🍌 CLICK THE BANANA 🍌',
  },
  specials: [
    { id: 'common', name: 'Yellow Banana', glyph: '🍌', rarity: 'common', chance: 0.1, sellValue: 5 },
    { id: 'rare', name: 'Green Banana', glyph: '🟢', rarity: 'rare', chance: 0.02, sellValue: 25 },
    { id: 'epic', name: 'Blue Banana', glyph: '🔵', rarity: 'epic', chance: 0.004, sellValue: 150 },
    { id: 'legendary', name: 'Golden Banana', glyph: '⭐', rarity: 'legendary', chance: 0.0005, sellValue: 1000 },
  ],
  gifts: [
    {
      // The $10 sponsor budget per window: ten $1 units of LLM API credit,
      // each a one-time code the server holds (POST /codes). Coin price = $1 × rate.
      id: 'llm-tokens',
      name: 'LLM tokens',
      sponsor: 'Banana Sponsor',
      usd: 1,
      stock: 10,
      description: '$1 of LLM API credit, topped up on your gateway account',
      claim: { kind: 'gateway' },
    },
  ],
  economy: DEFAULT_ECONOMY,
  gateway: {
    name: 'Banana Sponsor gateway',
    url: 'http://4.194.42.84:3000/register',
    hint: 'Register there, then run /banana link <your username> here.',
  },
  notes: 'Edit content.json and bump minVersion when the game needs a newer mod.',
}
