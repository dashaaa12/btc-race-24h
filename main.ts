// btc-race-24h bot: patient, volatility-gated trend following on CBBTC/USDC
// 1-minute bars.
//
// Why so patient: a full-size round trip on this thin pool costs roughly
// 30-35 bps in fees, slippage and price impact, and one-minute noise alone has
// a standard deviation near 7 bps, so short-horizon momentum is mostly noise
// (the first version of this bot traded it and bled fees). This version only
// trades a confirmed multi-hour drift:
//
//   entry (all must hold): the fast EMA is above the slow EMA; the trailing
//   ~3.7-hour return is at least +80 bps, i.e. several times the round-trip
//   cost; the last hour is not falling (trailing 60-bar return >= 0); and the
//   last half hour is not a vertical spike (trailing 30-bar return <= +45 bps),
//   so the bot does not chase a move that is already spent.
//
//   sizing: the whole equity, capped so the trade stays a small share of the
//   pool's latest close depth (its own impact stays bounded if depth thins).
//
//   exit: a trailing stop 80 bps under the best close since entry, a hard stop
//   at 100 bps under the position's cost, or a 900-bar maximum hold. After an
//   exit the bot sits out a cooldown, longer after a loss.
//
// Everything else is cash: on a flat or falling tape the bot does nothing and
// loses nothing. Fully deterministic: every decision is a pure function of the
// bars and fills received so far - no clock, no randomness, no environment.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

// ---- strategy parameters (bps are 1/100 of a percent) ----

/** Trailing window for the momentum entry signal, in bars. */
const MOM_BARS = 220;
/** Trailing MOM_BARS return must reach this to enter. */
const ENTRY_MOM_BPS = 80;
/** EMA lengths (bars) for the trend regime filter. */
const EMA_FAST = 30;
const EMA_SLOW = 120;
/** The trailing 60-bar return must be at least this (the last hour not falling). */
const MOM60_FLOOR_BPS = 0;
/** The trailing 30-bar return must be at most this (no chasing a spent spike). */
const MOM30_CAP_BPS = 45;
/** Share of equity one position may take, in bps of equity. */
const SIZE_BPS = 10_000;
/** Cap the buy so it stays near this share (bps) of the pool's latest depth. */
const IMPACT_CAP_BPS = 100;
/** Exit when the close falls this far below the best close since entry. */
const TRAIL_BPS = 80;
/** Exit when the position's value at the close falls this far below its cost. */
const STOP_BPS = 100;
/** Exit after this many bars in the position, whatever the tape says. */
const MAX_HOLD_BARS = 900;
/** Bars to sit out after any exit, and after a losing exit. */
const COOLDOWN_ANY = 8;
const COOLDOWN_LOSS = 40;
/** Slippage cap sent with every order (from the latest close). */
const ORDER_SLIP_BPS = 250;
/** Never send a buy below this notional (quote units, 1 USDC = 1_000_000). */
const MIN_BUY_QUOTE = 50_000_000n;

const BPS_N = 10_000n;

class TrendBot {
  /** Closes in USDC (float), one per batch that carried a bar for the symbol. */
  private closes: number[] = [];
  private emaFast = 0;
  private emaSlow = 0;
  /** Bookkeeping for the position currently open (or last seen). */
  private open: { cost: bigint; cashAtOpen: bigint; barCount: number; peak: number } | null = null;
  private wasInPosition = false;
  /** First seq at which a new entry is allowed again. */
  private cooldownUntilSeq = -1;

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const sym = state.hello.symbols[0]!.symbol;
    const bar = batch.bars.find((b) => b.symbol === sym);
    if (bar !== undefined) {
      const priceScale = state.hello.symbols[0]!.price_scale;
      const close = Number(bar.c) / 10 ** priceScale;
      this.closes.push(close);
      const kf = 2 / (EMA_FAST + 1);
      const ks = 2 / (EMA_SLOW + 1);
      if (this.closes.length === 1) {
        this.emaFast = close;
        this.emaSlow = close;
      } else {
        this.emaFast += kf * (close - this.emaFast);
        this.emaSlow += ks * (close - this.emaSlow);
      }
    }
    if (state.warmingUp) return [];

    const pos = state.positions.get(sym);
    const inPosition = pos !== undefined && pos.qty > 0n;
    const close = this.closes.length > 0 ? this.closes[this.closes.length - 1]! : 0;

    // Position appeared since the last batch: start tracking it.
    if (inPosition && !this.wasInPosition) {
      this.open = { cost: pos!.cost, cashAtOpen: state.cash, barCount: this.closes.length, peak: close };
    }
    // Position disappeared since the last batch: the trade is over, set cooldown.
    if (!inPosition && this.wasInPosition && this.open !== null) {
      const proceeds = state.cash - this.open.cashAtOpen;
      const lost = proceeds < this.open.cost;
      this.cooldownUntilSeq = state.seq + (lost ? COOLDOWN_LOSS : COOLDOWN_ANY);
      this.open = null;
    }
    this.wasInPosition = inPosition;

    if (inPosition && this.open !== null) {
      if (close > this.open.peak) this.open.peak = close;
      if (this.shouldExit(state, sym, pos!.qty, pos!.cost)) {
        return [{ side: 'sell', symbol: sym, qty: pos!.qty, max_slippage_bps: ORDER_SLIP_BPS }];
      }
      return [];
    }

    // Flat: look for an entry.
    if (state.seq < this.cooldownUntilSeq) return [];
    const notional = this.entryNotional(state, sym);
    if (notional === null) return [];
    return [{ side: 'buy', symbol: sym, notional_quote_units: notional, max_slippage_bps: ORDER_SLIP_BPS }];
  }

  private shouldExit(state: BarsState, sym: string, qty: bigint, cost: bigint): boolean {
    const open = this.open!;
    const n = this.closes.length;
    const close = this.closes[n - 1]!;
    // Hard stop: value at the latest close too far under what the position cost.
    const value = state.value(sym, qty);
    if (value * BPS_N < cost * BigInt(10_000 - STOP_BPS)) return true;
    // Trailing stop: close too far under the best close since entry.
    if (close * 10_000 < open.peak * (10_000 - TRAIL_BPS)) return true;
    // Maximum hold.
    if (n - open.barCount >= MAX_HOLD_BARS) return true;
    return false;
  }

  /** Trailing return in bps of the close `bars` ago against the latest close. */
  private trailingBps(bars: number): number | null {
    const n = this.closes.length;
    if (n <= bars) return null;
    const past = this.closes[n - 1 - bars]!;
    if (past <= 0) return null;
    return (this.closes[n - 1]! / past - 1) * 10_000;
  }

  private entryNotional(state: BarsState, sym: string): bigint | null {
    const n = this.closes.length;
    if (n <= Math.max(MOM_BARS, EMA_SLOW, 60)) return null;
    // Trend regime: fast EMA above slow EMA.
    if (!(this.emaFast > this.emaSlow)) return null;
    // The drift itself: trailing return over MOM_BARS clears several round trips.
    const mom = this.trailingBps(MOM_BARS);
    if (mom === null || mom < ENTRY_MOM_BPS) return null;
    // The last hour must not be falling.
    const mom60 = this.trailingBps(60);
    if (mom60 === null || mom60 < MOM60_FLOOR_BPS) return null;
    // The last half hour must not be a vertical spike already spent.
    const mom30 = this.trailingBps(30);
    if (mom30 === null || mom30 > MOM30_CAP_BPS) return null;

    // Size: SIZE_BPS of equity, capped to a small share of the latest close's
    // pool depth, and never more than the cash held.
    let notional = (state.equity * BigInt(SIZE_BPS)) / BPS_N;
    const depth = state.depthAt(sym);
    if (depth !== null && depth.length > 0) {
      const cap = (depth[0]! * BigInt(IMPACT_CAP_BPS)) / BPS_N;
      if (cap < notional) notional = cap;
    }
    if (notional > state.cash) notional = state.cash;
    if (notional < MIN_BUY_QUOTE) return null;
    return notional;
  }
}

const bot = new TrendBot();
await runBars({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});
