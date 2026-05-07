import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { usePlayer } from '../context/PlayerContext'
import { useGameTimer } from '../lib/useGameTimer'
import PokerTable from '../components/PokerTable'
import ActionBar from '../components/ActionBar'
import StatsDrawer from '../components/StatsDrawer'
import NameModal from '../components/NameModal'
import BuyInModal from '../components/BuyInModal'
import {
  initGameState, applyAction, dealNextRound,
  determineWinners, isBettingRoundComplete, runOutAllCards,
} from '../lib/poker'

export default function TablePage() {
  const { gameId }  = useParams()
  const navigate    = useNavigate()
  const { player, loading: playerLoading } = usePlayer()

  const [game, setGame]               = useState(null)
  const [gamePlayers, setGamePlayers] = useState([])
  const [gameState, setGameState]     = useState(null)
  const [showStats, setShowStats]     = useState(false)
  const [showName, setShowName]       = useState(false)
  const [winner, setWinner]           = useState(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState('')
  const [showBuyIn, setShowBuyIn]     = useState(false)
  const [brokeDlg, setBrokeDlg]       = useState(false)

  const isHost     = game?.host_id === player?.id
  const isMyTurn   = gameState?.seats?.[gameState?.currentTurnIdx]?.id === player?.id
  const isShowdown = gameState?.round === 'showdown'
  const canStartHand =
    isHost && (game?.status === 'waiting' || isShowdown || !gameState)

  // Game session timer
  const gameStartedAt        = game?.game_state?.gameStartedAt ?? null
  const gameDurationMinutes  = game?.game_state?.gameDurationMinutes ?? 0
  const { formatted: timerDisplay, expired: timerExpired, timeLeftMs } =
    useGameTimer(gameStartedAt, gameDurationMinutes)

  // Auto-end game when session timer expires (host only)
  const expiredRef = useRef(false)
  useEffect(() => {
    if (timerExpired && isHost && !expiredRef.current && gameState?.round !== 'showdown') {
      expiredRef.current = true
      supabase.from('games').update({ status: 'finished' }).eq('id', gameId)
    }
  }, [timerExpired, isHost])

  // ── Load ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!gameId || playerLoading) return
    if (!player) { setShowName(true); return }
    loadGame()
  }, [gameId, player, playerLoading])

  async function loadGame() {
    setLoading(true)
    try {
      const { data: g, error } = await supabase.from('games').select('*').eq('id', gameId).single()
      if (error) {
        if (error.code === 'PGRST116') {
          setError('Game not found.')
        } else if (!error.status || error.status === 0 || error.status >= 500 || error.code === 'NOT_FOUND') {
          setError('Cannot reach the server. Your Supabase project may be paused — visit supabase.com/dashboard to resume it, then refresh.')
        } else {
          setError(error.message || 'Failed to load game.')
        }
        return
      }
      if (!g) { setError('Game not found.'); return }
      setGame(g)
      await loadGamePlayers()
      if (g.game_state?.seats) setGameState(g.game_state)
    } catch (e) {
      setError('Cannot reach the server. Check your connection or resume your Supabase project at supabase.com/dashboard.')
    } finally {
      setLoading(false)
    }
  }

  async function loadGamePlayers() {
    const { data } = await supabase
      .from('game_players')
      .select('*, profiles(display_name)')
      .eq('game_id', gameId)
    setGamePlayers((data || []).map(p => ({
      ...p,
      display_name: p.profiles?.display_name || 'Player',
    })))
  }

  // ── Realtime ──────────────────────────────────────────────────
  useEffect(() => {
    if (!gameId) return
    const ch = supabase.channel(`game:${gameId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}`,
      }, payload => {
        setGame(payload.new)
        const gs = payload.new.game_state
        if (gs?.seats) setGameState(gs)
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'game_players', filter: `game_id=eq.${gameId}`,
      }, loadGamePlayers)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [gameId])

  // ── Persist game state (any player on their turn) ────────────
  async function persist(state) {
    await supabase.from('games').update({
      game_state: state,
      pot: state.pot,
      community_cards: state.communityCards,
      updated_at: new Date().toISOString(),
    }).eq('id', gameId)
  }

  // ── Start hand ───────────────────────────────────────────────
  async function startHand() {
    const active = gamePlayers
      .filter(p => p.status === 'active' && p.chips > 0)
      .map(p => ({ id: p.player_id, name: p.display_name, seat: p.seat, chips: p.chips }))

    if (active.length < 2) { setError('Need at least 2 players'); return }

    const nextDealer = ((game.dealer_seat ?? 0) + 1) % active.length

    // On first hand, record the session start time
    const existingStartedAt = game.game_state?.gameStartedAt
    const gameStartedAtValue = existingStartedAt || new Date().toISOString()

    const newState = initGameState({
      players: active,
      smallBlind:    game.small_blind,
      bigBlind:      game.big_blind,
      startingChips: game.starting_chips,
      dealerSeat:    nextDealer,
    })

    // Carry session-level fields through each hand state
    newState.gameDurationMinutes = game.game_state?.gameDurationMinutes ?? 0
    newState.gameStartedAt       = gameStartedAtValue

    setGameState(newState)
    setWinner(null)

    // Update game row: persist state + record start time if first hand
    await supabase.from('games').update({
      game_state: newState,
      pot: newState.pot,
      community_cards: newState.communityCards,
      current_hand: (game.current_hand ?? 0) + 1,
      dealer_seat: nextDealer,
      status: 'active',
      updated_at: new Date().toISOString(),
      // Write gameStartedAt into the game row's game_state above; also keep it accessible
    }).eq('id', gameId)

    // Separately patch game_state to include session info if first hand
    if (!existingStartedAt) {
      await supabase.from('games').update({
        game_state: { ...newState, gameStartedAt: gameStartedAtValue },
      }).eq('id', gameId)
    }
  }

  // ── Player action ─────────────────────────────────────────────
  async function handleAction(action, amount = 0) {
    if (!gameState || !player || !isMyTurn) return

    let st = applyAction(gameState, player.id, action, amount)

    const onlyOneLeft = st.seats.filter(s => !s.folded).length <= 1

    if (onlyOneLeft) {
      // Everyone else folded — instant win
      st = await resolveHand(st)
    } else if (isBettingRoundComplete(st.seats, st.currentBet)) {
      if (st.round === 'river') {
        st = await resolveHand(st)
      } else {
        // Advance street, then run out board if everyone is all-in
        st = dealNextRound(st)
        st = runOutAllCards(st)
        if (st.round === 'showdown') {
          st = await resolveHand(st)
        }
      }
    }

    setGameState(st)
    await persist(st)

    for (const seat of st.seats) {
      await supabase.from('game_players')
        .update({ chips: seat.chips })
        .eq('game_id', gameId).eq('player_id', seat.id)
    }
  }

  async function resolveHand(state) {
    const active = state.seats.filter(s => !s.folded)
    const winnerIds = active.length === 1
      ? [active[0].id]
      : determineWinners(
          active.map(p => ({ id: p.id, holeCards: p.holeCards })),
          state.communityCards
        )

    const split    = Math.floor(state.pot / winnerIds.length)
    const newSeats = state.seats.map(s => ({
      ...s,
      chips: winnerIds.includes(s.id) ? s.chips + split : s.chips,
    }))

    setWinner({
      names:  winnerIds.map(id => state.seats.find(s => s.id === id)?.name || 'Player'),
      amount: split,
    })

    return { ...state, seats: newSeats, status: 'showdown', round: 'showdown', pot: 0 }
  }

  // ── Buy In ───────────────────────────────────────────────────
  async function handleBuyIn(amount) {
    const gp = gamePlayers.find(p => p.player_id === player?.id)
    if (!gp) return

    const newChips = (gp.chips || 0) + amount
    await supabase.from('game_players')
      .update({ chips: newChips, buy_in: (gp.buy_in || 0) + amount })
      .eq('id', gp.id)

    // Also patch the live seat so chips update immediately
    if (gameState) {
      const updatedSeats = gameState.seats.map(s =>
        s.id === player.id ? { ...s, chips: newChips, allIn: false } : s
      )
      const newState = { ...gameState, seats: updatedSeats }
      setGameState(newState)
      await persist(newState)
    }

    setShowBuyIn(false)
    setBrokeDlg(false)
    await loadGamePlayers()
  }

  // Show broke dialog when winner is announced and this player has 0 chips
  useEffect(() => {
    if (winner && enrichedState) {
      const me = enrichedState.seats?.find(s => s.id === player?.id)
      if (me && me.chips === 0) setBrokeDlg(true)
    }
  }, [winner])

  // ── Leave ─────────────────────────────────────────────────────
  async function leaveGame() {
    const gp = gamePlayers.find(p => p.player_id === player?.id)
    if (gp) {
      await supabase.from('game_players').update({
        status: 'left', cash_out: gp.chips, left_at: new Date().toISOString(),
      }).eq('id', gp.id)
      await supabase.from('game_results').insert({
        game_id: gameId, player_id: player.id, display_name: player.display_name,
        buy_in: gp.buy_in, cash_out: gp.chips, profit_loss: gp.chips - gp.buy_in,
        hands_played: gp.hands_played, hands_won: gp.hands_won,
        vpip_pct: gp.hands_played > 0 ? Math.round(gp.vpip_count / gp.hands_played * 100) : 0,
        win_pct:  gp.hands_played > 0 ? Math.round(gp.hands_won  / gp.hands_played * 100) : 0,
      })
    }
    navigate('/')
  }

  // ── Derived ───────────────────────────────────────────────────
  const enrichedState = gameState ? {
    ...gameState,
    seats: gameState.seats?.map(seat => {
      const gp = gamePlayers.find(p => p.player_id === seat.id)
      return { ...seat, name: gp?.display_name || seat.name || 'Player' }
    }),
  } : null

  const myEnrichedPlayer = enrichedState?.seats?.find(s => s.id === player?.id)
  const currentTurnName  = enrichedState?.seats?.[gameState?.currentTurnIdx]?.name

  // Buy-in is available between hands (showdown / waiting / no hand started)
  const canBuyIn = !!player && (isShowdown || !gameState || game?.status === 'waiting')

  // Timer urgency for styling
  const timerUrgent  = timeLeftMs !== null && timeLeftMs < 10 * 60 * 1000   // < 10 min
  const timerWarning = timeLeftMs !== null && timeLeftMs < 30 * 60 * 1000   // < 30 min

  // ── Screens ───────────────────────────────────────────────────
  if (loading || playerLoading) {
    return (
      <div className="h-dvh bg-[#0a1118] flex items-center justify-center">
        <div className="text-white/50 text-sm animate-pulse">Loading table…</div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="h-dvh bg-[#0a1118] flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-red-400 text-sm">{error}</p>
        <button onClick={() => navigate('/')} className="text-green-400 underline text-sm">Back to lobby</button>
      </div>
    )
  }

  return (
    <div className="h-dvh flex flex-col bg-[#0a1118] overflow-hidden">

      {/* ── Header ────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-white/8 bg-[#0c1520]"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
      >
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-gray-400 hover:text-white text-sm transition"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Lobby
        </button>

        <div className="text-center">
          <p className="text-white text-sm font-semibold leading-tight">{game?.name}</p>
          <p className="text-gray-500 text-[10px]">
            {game?.game_type} · {game?.small_blind}/{game?.big_blind}
            {game?.current_hand > 0 ? ` · Hand #${game.current_hand}` : ''}
          </p>
        </div>

        {/* Buy In button + session timer + stats icon */}
        <div className="flex items-center gap-2">
          {canBuyIn && (
            <button
              onClick={() => setShowBuyIn(true)}
              className="h-8 px-3 rounded-full bg-green-700/80 hover:bg-green-600 text-white text-xs font-bold transition border border-green-600/50"
            >
              + Buy In
            </button>
          )}
          {timerDisplay && (
            <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-full ${
              timerExpired  ? 'bg-red-900 text-red-300' :
              timerUrgent   ? 'bg-red-900/70 text-red-300 animate-pulse' :
              timerWarning  ? 'bg-orange-900/70 text-orange-300' :
              'bg-white/8 text-gray-300'
            }`}>
              {timerExpired ? 'TIME' : timerDisplay}
            </span>
          )}
          <button
            onClick={() => setShowStats(true)}
            className="w-11 h-11 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Session expired banner ────────────────────────────── */}
      {timerExpired && (
        <div className="shrink-0 bg-red-900/80 border-b border-red-700 px-4 py-2 text-center">
          <span className="text-red-200 text-sm font-semibold">
            ⏰ Game time is up — finish the current hand and cash out.
          </span>
        </div>
      )}

      {/* ── Waiting lobby bar ─────────────────────────────────── */}
      {game?.status === 'waiting' && (
        <div className="shrink-0 px-4 py-2 bg-[#0e1c2e] border-b border-white/8 flex items-center gap-3 overflow-x-auto">
          <span className="text-[10px] text-gray-500 whitespace-nowrap shrink-0">
            {gamePlayers.length}/{game.max_players} players
          </span>
          {gamePlayers.map(p => (
            <div key={p.id} className="flex items-center gap-1.5 bg-white/5 px-2.5 py-1 rounded-full shrink-0">
              <div className="w-4 h-4 rounded-full bg-emerald-800 flex items-center justify-center text-white text-[9px] font-bold">
                {(p.display_name || '?')[0]}
              </div>
              <span className="text-[10px] text-white/80">{p.display_name}</span>
              {p.is_host && <span className="text-[8px] text-yellow-400 font-bold">HOST</span>}
            </div>
          ))}
          {gameDurationMinutes > 0 && (
            <span className="text-[10px] text-gray-500 whitespace-nowrap ml-auto shrink-0">
              ⏱ {gameDurationMinutes >= 60 ? `${gameDurationMinutes / 60}h` : `${gameDurationMinutes}m`} session
            </span>
          )}
        </div>
      )}

      {/* ── Turn indicator strip ──────────────────────────────── */}
      {gameState?.round && !isShowdown && (
        <div className="shrink-0 flex items-center justify-center py-1.5 bg-[#0a1118]">
          {isMyTurn ? (
            <span className="text-yellow-400 text-xs font-semibold animate-pulse">● Your turn</span>
          ) : (
            <span className="text-gray-500 text-xs">{currentTurnName}'s turn</span>
          )}
        </div>
      )}

      {/* ── Table area ────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex items-center justify-center px-2 py-1 overflow-hidden">
        <div className="w-full max-w-sm h-full flex items-center">
          <PokerTable
            gameState={enrichedState}
            myPlayerId={player?.id}
            maxPlayers={game?.max_players ?? 6}
          />
        </div>
      </div>

      {/* ── Action bar ────────────────────────────────────────── */}
      <div className="shrink-0">
        <ActionBar
          gameState={enrichedState}
          myPlayer={myEnrichedPlayer}
          communityCards={enrichedState?.communityCards ?? []}
          onAction={handleAction}
          isMyTurn={isMyTurn}
          isHost={isHost}
          canStartHand={canStartHand && !timerExpired}
          onStartHand={startHand}
          onLeave={leaveGame}
          winner={winner}
        />
      </div>

      {/* ── Drawers / modals ──────────────────────────────────── */}
      <StatsDrawer open={showStats} onClose={() => setShowStats(false)} gamePlayers={gamePlayers} game={game} />
      {showName && <NameModal onClose={() => setShowName(false)} />}

      {/* Voluntary buy-in dialog */}
      {showBuyIn && !brokeDlg && (
        <BuyInModal
          defaultAmount={game?.starting_chips ?? 1000}
          onConfirm={handleBuyIn}
          onCancel={() => setShowBuyIn(false)}
          broke={false}
        />
      )}

      {/* Broke dialog — shown when player hits 0 chips */}
      {brokeDlg && (
        <BuyInModal
          defaultAmount={game?.starting_chips ?? 1000}
          onConfirm={handleBuyIn}
          onCancel={leaveGame}
          broke={true}
        />
      )}
    </div>
  )
}
