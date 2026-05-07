import { useState } from 'react'
import { formatChips } from '../lib/poker'

export default function BuyInModal({ defaultAmount = 1000, onConfirm, onCancel, broke = false }) {
  const [amount, setAmount] = useState(defaultAmount)

  const presets = [
    Math.floor(defaultAmount / 2),
    defaultAmount,
    defaultAmount * 2,
  ].filter(n => n > 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="bg-[#1a2535] rounded-2xl p-6 w-full max-w-sm shadow-2xl border border-white/10">

        {broke ? (
          <div className="text-center mb-5">
            <div className="text-5xl mb-3">💸</div>
            <h2 className="text-xl font-bold text-white mb-1">You're out of chips!</h2>
            <p className="text-sm text-gray-400">Buy back in to keep playing.</p>
          </div>
        ) : (
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xl font-bold text-white">Buy In</h2>
            <button
              onClick={onCancel}
              className="text-gray-400 hover:text-white text-2xl leading-none transition"
            >
              &times;
            </button>
          </div>
        )}

        {/* Quick presets */}
        <div className="flex gap-2 mb-3">
          {presets.map(p => (
            <button
              key={p}
              onClick={() => setAmount(p)}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition border ${
                amount === p
                  ? 'bg-green-700 border-green-500 text-white'
                  : 'bg-white/5 border-white/10 text-gray-400 hover:border-white/30 hover:text-white'
              }`}
            >
              {formatChips(p)}
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="bg-[#0f1923] border border-white/20 rounded-xl px-3 py-2.5 flex items-center gap-2 mb-5">
          <span className="text-gray-500 text-sm font-mono">₮</span>
          <input
            type="number"
            min={1}
            step={100}
            value={amount}
            onChange={e => setAmount(Math.max(1, Number(e.target.value)))}
            className="flex-1 bg-transparent text-white text-sm focus:outline-none"
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 bg-white/5 hover:bg-white/10 text-gray-400 font-medium py-3 rounded-xl text-sm transition border border-white/8"
          >
            {broke ? 'Leave' : 'Cancel'}
          </button>
          <button
            onClick={() => onConfirm(amount)}
            className="flex-1 bg-green-600 hover:bg-green-500 active:bg-green-700 text-white font-bold py-3 rounded-xl text-sm transition"
          >
            Buy In · {formatChips(amount)}
          </button>
        </div>
      </div>
    </div>
  )
}
