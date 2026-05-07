import PlayingCard from './PlayingCard'
import { formatChips } from '../lib/poker'

const ROUND_LABEL = {
  preflop: 'PRE-FLOP',
  flop:    'FLOP',
  turn:    'TURN',
  river:   'RIVER',
  showdown:'SHOWDOWN',
}

// How many community card slots to show per round
const VISIBLE_SLOTS = {
  preflop:  0,
  flop:     3,
  turn:     4,
  river:    5,
  showdown: 5,
}

export default function CommunityCards({ cards = [], pot = 0, round = '' }) {
  const slotCount = VISIBLE_SLOTS[round] ?? 0

  return (
    <div className="flex flex-col items-center gap-2 select-none">

      {/* Round badge */}
      {round && round !== 'showdown' && (
        <span className="text-[9px] font-bold tracking-[0.2em] uppercase text-white/35 bg-black/20 px-2 py-0.5 rounded-full">
          {ROUND_LABEL[round] || round}
        </span>
      )}

      {/* Card slots — only show slots relevant to the current round */}
      {slotCount > 0 && (
        <div className="flex gap-1.5 items-center">
          {Array.from({ length: slotCount }).map((_, i) => (
            <PlayingCard
              key={i}
              card={cards[i] ?? null}
              size="sm"
              faceDown={!cards[i]}
            />
          ))}
        </div>
      )}

      {/* Pot display */}
      {pot > 0 && (
        <div className="flex items-center gap-1.5 bg-black/50 border border-yellow-500/25 px-3 py-1 rounded-full">
          <span className="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0 shadow shadow-yellow-400/60" />
          <span className="text-yellow-300 text-[11px] font-bold font-mono tracking-wide">
            {formatChips(pot)}
          </span>
        </div>
      )}
    </div>
  )
}
