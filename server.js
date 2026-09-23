const express = require("express");
const app = express();
const PORT = Number(process.env.PORT || 3000);

const CFG = {
  maxPositions: 10,
  maxSameSide: 5,
  positionRiskPct: 0.02,
  minEdge: 6.5,
  cooldownMs: 45 * 60 * 1000,
  maxHoldMs: 45 * 60 * 1000,
  pollMs: 15000,
  analysisBatch: 20,
  microstructureTop: 18,
  initialCapital: Number(process.env.INITIAL_CAPITAL || 10000),
  feeRate: Number(process.env.PAPER_FEE_RATE || 0.0004),
  slippageBps: Number(process.env.PAPER_SLIPPAGE_BPS || 3)
};

const state = {
  version: "TIERRA REAL-TIME MARKET INTELLIGENCE",
  mode: "PAPER",
  status: "STARTING",
  markets: 0,
  dataMarkets: 0,
  scans: 0,
  equity: CFG.initialCapital,
  realizedPnl: 0,
  floatingPnl: 0,
  cash: CFG.initialCapital,
  positions: {},
  cooldown: {},
  stats: { wins: 0, losses: 0, long: 0, short: 0 },
  candidates: [],
  events: [],
  lastScan: null,
  scanMs: 0,
  marketContext: {},
  scanRunning: false,
  symbolsCache: []
};

function logEvent(type, symbol, data) {
  state.events.unshift(Object.assign({ time: new Date().toISOString(), type, symbol: symbol || null }, data || {}));
  state.events = state.events.slice(0, 120);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, timeout = 10000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "SUPREMO-V13" } });
    const text = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status + " " + text.slice(0, 160));
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

async function binance(path) {
  const urls = ["https://fapi.binance.com" + path, "https://api.binance.com" + path];
  let last;
  for (const u of urls) {
    try { return await fetchJson(u); } catch (e) { last = e; }
  }
  throw last || new Error("Binance unavailable");
}

async function spot(path) {
  return fetchJson("https://api.binance.com" + path);
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atr(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < klines.length; i++) {
    const h = +klines[i][2], l = +klines[i][3], pc = +klines[i - 1][4];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = ((period - 1) * ag + (d > 0 ? d : 0)) / period;
    al = ((period - 1) * al + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function relativeVolume(klines, n = 20) {
  if (klines.length < n + 1) return 1;
  const v = klines.slice(-(n + 1)).map(k => +k[5]);
  const avg = v.slice(0, -1).reduce((a, b) => a + b, 0) / n;
  return avg ? v[v.length - 1] / avg : 1;
}

function macd(closes) {
  if (closes.length < 35) return null;
  const vals = [];
  for (let i = 26; i < closes.length; i++) vals.push(ema(closes.slice(0, i + 1), 12) - ema(closes.slice(0, i + 1), 26));
  const line = vals.at(-1), signal = ema(vals, 9);
  return { line, signal, hist: line - signal };
}

function stochastic(klines, period = 14) {
  if (klines.length < period) return null;
  const a = klines.slice(-period);
  const hi = Math.max(...a.map(k => +k[2])), lo = Math.min(...a.map(k => +k[3])), close = +a.at(-1)[4];
  return hi === lo ? 50 : ((close - lo) / (hi - lo)) * 100;
}

function obv(klines) {
  if (klines.length < 21) return null;
  let v = 0;
  for (let i = 1; i < klines.length; i++) {
    const c = +klines[i][4], pc = +klines[i - 1][4], vol = +klines[i][5];
    if (c > pc) v += vol; else if (c < pc) v -= vol;
  }
  return v;
}

function adx(klines, period = 14) {
  if (klines.length < period * 2 + 1) return null;
  const tr = [], plus = [], minus = [];
  for (let i = 1; i < klines.length; i++) {
    const h = +klines[i][2], l = +klines[i][3], ph = +klines[i - 1][2], pl = +klines[i - 1][3], pc = +klines[i - 1][4];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, down = pl - l;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  let at = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let ap = plus.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let am = minus.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    at = ((period - 1) * at + tr[i]) / period;
    ap = ((period - 1) * ap + plus[i]) / period;
    am = ((period - 1) * am + minus[i]) / period;
    const pdi = at ? 100 * ap / at : 0, mdi = at ? 100 * am / at : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  return dx.length ? dx.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, dx.length) : null;
}

function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const a = closes.slice(-period), mid = a.reduce((s, v) => s + v, 0) / period;
  const sd = Math.sqrt(a.reduce((s, v) => s + Math.pow(v - mid, 2), 0) / period);
  return { middle: mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

function tfTrend(klines) {
  const closed = klines.slice(0, -1), c = closed.map(k => +k[4]);
  const e20 = ema(c, 20), e50 = ema(c, 50), price = c.at(-1), a = atr(closed, 14);
  if (![e20, e50, price, a].every(Number.isFinite)) return "UNKNOWN";
  if (e20 > e50 && price > e20) return "BULL";
  if (e20 < e50 && price < e20) return "BEAR";
  return "RANGE";
}

async function marketContext() {
  const tfs = ["1m", "5m", "15m", "1h"];
  const out = {};
  await Promise.all(tfs.map(async tf => {
    try { out[tf] = tfTrend(await binance(`/fapi/v1/klines?symbol=BTCUSDT&interval=${tf}&limit=80`)); }
    catch { out[tf] = "UNKNOWN"; }
  }));
  out.direction = out["5m"] === out["15m"] ? out["5m"] : "MIXED";
  return out;
}

function regime(x) {
  const spread = (x.ema20 - x.ema50) / x.price;
  const atrPct = x.atr / x.price;
  const slope = (x.ema20 - x.ema20Prev) / x.price;
  if (atrPct > 0.035) return "VOLATILE";
  if (Number.isFinite(x.adx) && x.adx < 16) return "RANGE";
  if (spread > 0.003 && slope > 0.0003) return "BULL";
  if (spread < -0.003 && slope < -0.0003) return "BEAR";
  return "RANGE";
}

function technicalScore(x, side) {
  let s = 0;
  const up = x.ema20 > x.ema50, down = x.ema20 < x.ema50;
  const macdUp = x.macd > x.macdSignal && x.macdHist > 0, macdDown = x.macd < x.macdSignal && x.macdHist < 0;
  const obvUp = x.obvSlope > 0, obvDown = x.obvSlope < 0;
  const adxStrong = x.adx >= 20;
  const bbRange = x.bbUpper - x.bbLower;
  const bbPos = bbRange > 0 ? (x.price - x.bbLower) / bbRange : 0.5;
  const nearEma = Math.abs(x.price - x.ema20) <= x.atr * 0.8;
  if (side === "LONG") {
    if (up) s += 1.0; if (x.regime === "BULL") s += 1.0; if (macdUp) s += 1.0;
    if (x.rsi >= 45 && x.rsi <= 68) s += .5; if (nearEma && x.price >= x.ema20) s += .5;
    if (x.momentum > 0) s += .5; if (x.relVol >= 1.1) s += .5; if (obvUp) s += .5;
    if (adxStrong) s += .5; if (x.stoch >= 35 && x.stoch <= 80) s += .5; if (bbPos >= .35 && bbPos <= .85) s += .5;
  } else {
    if (down) s += 1.0; if (x.regime === "BEAR") s += 1.0; if (macdDown) s += 1.0;
    if (x.rsi >= 32 && x.rsi <= 55) s += .5; if (nearEma && x.price <= x.ema20) s += .5;
    if (x.momentum < 0) s += .5; if (x.relVol >= 1.1) s += .5; if (obvDown) s += .5;
    if (adxStrong) s += .5; if (x.stoch >= 20 && x.stoch <= 65) s += .5; if (bbPos >= .15 && bbPos <= .65) s += .5;
  }
  return s;
}

async function loadSymbols() {
  const info = await binance("/fapi/v1/exchangeInfo");
  const list = info.symbols.filter(s => s.status === "TRADING" && s.quoteAsset === "USDT" && s.contractType === "PERPETUAL").map(s => s.symbol);
  state.markets = list.length;
  return list;
}

async function load24h(symbols) {
  try {
    const all = await binance("/fapi/v1/ticker/24hr");
    const map = new Map(all.map(x => [x.symbol, { quoteVol: +x.quoteVolume || 0, change24: +x.priceChangePercent || 0 }]));
    return symbols.map(s => ({ symbol: s, ...(map.get(s) || {}) }));
  } catch {
    return symbols.map(s => ({ symbol: s, quoteVol: 0, change24: 0 }));
  }
}

async function analyzeSymbol(symbol) {
  const ks = await binance(`/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=80`);
  if (!Array.isArray(ks) || ks.length < 55) throw new Error("insufficient candles");
  const closed = ks.slice(0, -1), closes = closed.map(k => +k[4]), price = +closed.at(-1)[4];
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e20Prev = ema(closes.slice(0, -1), 20);
  const a = atr(closed, 14), r = rsi(closes, 14), rv = relativeVolume(closed, 20);
  const momentum = closes.at(-1) - closes.at(-6), mc = macd(closes), stoch = stochastic(closed, 14), ob = obv(closed), obPrev = obv(closed.slice(0, -5)), ax = adx(closed, 14), bb = bollinger(closes, 20, 2);
  if (![price, e20, e50, e20Prev, a, r, rv, momentum, stoch, ob, ax].every(Number.isFinite) || !mc || !Number.isFinite(mc.line) || !Number.isFinite(mc.signal) || !bb) throw new Error("invalid data");
  const x = { symbol, price, ema20: e20, ema50: e50, ema20Prev: e20Prev, atr: a, rsi: r, relVol: rv, momentum, macd: mc.line, macdSignal: mc.signal, macdHist: mc.hist, stoch, obv: ob, obvSlope: Number.isFinite(obPrev) ? ob - obPrev : 0, adx: ax, bbMiddle: bb.middle, bbUpper: bb.upper, bbLower: bb.lower };
  x.regime = regime(x); x.longTech = technicalScore(x, "LONG"); x.shortTech = technicalScore(x, "SHORT");
  return x;
}

async function enrichMicro(x) {
  const q = encodeURIComponent(x.symbol);
  const pair = x.symbol;
  const result = { ...x, microOk: false, oi: null, oiPrev: null, oiDeltaPct: null, funding: null, basisPct: null, bookImbalance: null, spreadBps: null, takerRatio: null, spotPrice: null };
  try {
    const [oi, prem, depth, tb, sb] = await Promise.all([
      binance(`/fapi/v1/openInterest?symbol=${q}`),
      binance(`/fapi/v1/premiumIndex?symbol=${q}`),
      binance(`/fapi/v1/depth?symbol=${q}&limit=20`),
      binance(`/futures/data/takerBuySellVol?symbol=${q}&contractType=PERPETUAL&period=5m&limit=2`),
      spot(`/api/v3/ticker/bookTicker?symbol=${q}`)
    ]);
    result.oi = +oi.openInterest;
    result.funding = Number.isFinite(+prem.lastFundingRate) ? +prem.lastFundingRate : null;
    const bids = (depth.bids || []).map(a => [+a[0], +a[1]]), asks = (depth.asks || []).map(a => [+a[0], +a[1]]);
    const bidQty = bids.reduce((s, a) => s + a[1], 0), askQty = asks.reduce((s, a) => s + a[1], 0);
    result.bookImbalance = (bidQty + askQty) ? (bidQty - askQty) / (bidQty + askQty) : 0;
    const bestBid = bids[0]?.[0], bestAsk = asks[0]?.[0];
    result.spreadBps = bestBid && bestAsk ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10000 : null;
    const latest = Array.isArray(tb) ? tb.at(-1) : tb;
    const buy = +(latest?.takerBuyVolValue ?? latest?.takerBuyVol ?? 0), sell = +(latest?.takerSellVolValue ?? latest?.takerSellVol ?? 0);
    result.takerRatio = (buy + sell) ? buy / (buy + sell) : null;
    result.spotPrice = (+sb.bidPrice + +sb.askPrice) / 2;
    result.basisPct = result.spotPrice ? ((x.price - result.spotPrice) / result.spotPrice) * 100 : null;
    try {
      const hist = await binance(`/futures/data/openInterestHist?symbol=${q}&period=5m&limit=2`);
      if (Array.isArray(hist) && hist.length >= 2) {
        result.oiPrev = +hist.at(-2).sumOpenInterest;
        if (result.oiPrev) result.oiDeltaPct = ((result.oi - result.oiPrev) / result.oiPrev) * 100;
      }
    } catch {}
    result.microOk = true;
  } catch (e) {
    result.microError = e.message;
  }
  return result;
}

function marketAlignment(x, side) {
  const ctx = state.marketContext || {};
  const bullish = [ctx["5m"], ctx["15m"], ctx["1h"]].filter(v => v === "BULL").length;
  const bearish = [ctx["5m"], ctx["15m"], ctx["1h"]].filter(v => v === "BEAR").length;
  if (side === "LONG") return bullish >= 2 ? 1 : bearish >= 2 ? -1 : 0;
  return bearish >= 2 ? 1 : bullish >= 2 ? -1 : 0;
}

function microScore(x, side) {
  let s = 0, reasons = [];
  const dir = side === "LONG" ? 1 : -1;
  const oiUp = Number.isFinite(x.oiDeltaPct) && x.oiDeltaPct > 0.15;
  const oiDown = Number.isFinite(x.oiDeltaPct) && x.oiDeltaPct < -0.15;
  const takerBull = Number.isFinite(x.takerRatio) && x.takerRatio > 0.54;
  const takerBear = Number.isFinite(x.takerRatio) && x.takerRatio < 0.46;
  const bookBull = Number.isFinite(x.bookImbalance) && x.bookImbalance > 0.08;
  const bookBear = Number.isFinite(x.bookImbalance) && x.bookImbalance < -0.08;
  const fundingBullCrowd = Number.isFinite(x.funding) && x.funding > 0.0008;
  const fundingBearCrowd = Number.isFinite(x.funding) && x.funding < -0.0008;
  const basisLong = Number.isFinite(x.basisPct) && x.basisPct > 0.03;
  const basisShort = Number.isFinite(x.basisPct) && x.basisPct < -0.03;

  if (side === "LONG") {
    if (oiUp) { s += 1.0; reasons.push("OI↑"); }
    if (oiDown) { s += .5; reasons.push("OI↓/short-cover"); }
    if (takerBull) { s += 1.2; reasons.push("TAKER BUY"); }
    if (takerBear) { s -= .8; reasons.push("TAKER SELL"); }
    if (bookBull) { s += .8; reasons.push("BOOK BUY"); }
    if (bookBear) { s -= .6; reasons.push("BOOK SELL"); }
    if (fundingBullCrowd) { s -= .4; reasons.push("funding crowded"); }
    if (fundingBearCrowd) { s += .4; reasons.push("negative funding"); }
    if (basisLong) { s += .4; reasons.push("basis+"); }
    if (basisShort) { s += .3; reasons.push("basis-"); }
  } else {
    if (oiUp) { s += 1.0; reasons.push("OI↑"); }
    if (oiDown) { s += .5; reasons.push("OI↓/long-cover"); }
    if (takerBear) { s += 1.2; reasons.push("TAKER SELL"); }
    if (takerBull) { s -= .8; reasons.push("TAKER BUY"); }
    if (bookBear) { s += .8; reasons.push("BOOK SELL"); }
    if (bookBull) { s -= .6; reasons.push("BOOK BUY"); }
    if (fundingBearCrowd) { s -= .4; reasons.push("funding crowded"); }
    if (fundingBullCrowd) { s += .4; reasons.push("positive funding"); }
    if (basisShort) { s += .4; reasons.push("basis-"); }
    if (basisLong) { s += .3; reasons.push("basis+"); }
  }
  const align = marketAlignment(x, side);
  if (align > 0) { s += .8; reasons.push("BTC ALIGN"); }
  if (align < 0) { s -= 1.0; reasons.push("BTC AGAINST"); }
  return { score: s, reasons };
}

function leadLagScore(x, side) {
  const movePct = x.price ? (x.momentum / x.price) * 100 : 0;
  const aligned = side === "LONG" ? movePct > 0 : movePct < 0;
  // A small positive score favors a move that has started without rewarding a huge spike.
  if (!aligned) return -0.8;
  if (Math.abs(movePct) < 0.05) return 0.7;
  if (Math.abs(movePct) <= 0.35) return 1.1;
  if (Math.abs(movePct) <= 0.8) return 0.4;
  return -0.8; // overextended: do not chase.
}

function finalCandidate(x, side, liquidity) {
  const tech = side === "LONG" ? x.longTech : x.shortTech;
  const micro = microScore(x, side);
  const lead = leadLagScore(x, side);
  const liq = liquidity && liquidity.quoteVol > 0 ? (liquidity.quoteVol >= 5e6 ? .8 : liquidity.quoteVol >= 1e6 ? .4 : liquidity.quoteVol >= 2e5 ? 0 : -.8) : 0;
  const spreadPenalty = Number.isFinite(x.spreadBps) ? (x.spreadBps > 20 ? -1.2 : x.spreadBps > 10 ? -.5 : .3) : 0;
  const edge = tech + micro.score + lead + liq + spreadPenalty;
  return { ...x, side, score: edge, techScore: tech, microScore: micro.score, leadLag: lead, reasons: micro.reasons, quoteVol: liquidity?.quoteVol || 0, change24: liquidity?.change24 || 0 };
}

function bestCandidates(results, liquidityMap) {
  const arr = [];
  for (const x of results) {
    if (x.regime === "VOLATILE") continue;
    if (state.cooldown[x.symbol] && Date.now() < state.cooldown[x.symbol]) continue;
    if (state.positions[x.symbol]) continue;
    const liq = liquidityMap.get(x.symbol);
    for (const side of ["LONG", "SHORT"]) {
      const c = finalCandidate(x, side, liq);
      if (c.score >= CFG.minEdge) arr.push(c);
    }
  }
  arr.sort((a, b) => b.score - a.score);
  return arr;
}

function sideCount(side) { return Object.values(state.positions).filter(p => p.side === side).length; }

function enter(c) {
  if (Object.keys(state.positions).length >= CFG.maxPositions) return false;
  if (sideCount(c.side) >= CFG.maxSameSide) return false;
  const allocation = Math.min(state.cash, state.equity * CFG.positionRiskPct);
  if (allocation <= 0) return false;
  const slip = CFG.slippageBps / 10000;
  const entry = c.side === "LONG" ? c.price * (1 + slip) : c.price * (1 - slip);
  const stopDist = Math.max(c.atr * 1.6, c.price * 0.007);
  const tpDist = stopDist * 1.9;
  state.positions[c.symbol] = {
    symbol: c.symbol, side: c.side, entry, qty: allocation / entry, allocation,
    stop: c.side === "LONG" ? entry - stopDist : entry + stopDist,
    tp: c.side === "LONG" ? entry + tpDist : entry - tpDist,
    openedAt: Date.now(), score: c.score, regime: c.regime,
    reasons: c.reasons, techScore: c.techScore, microScore: c.microScore, leadLag: c.leadLag
  };
  state.cash -= allocation;
  state.stats[c.side.toLowerCase()]++;
  logEvent("ENTRY", c.symbol, { side: c.side, price: entry, score: c.score, tech: c.techScore, micro: c.microScore, leadLag: c.leadLag, reasons: c.reasons });
  return true;
}

function closePaperPosition(p, exitPrice, reason = "MANUAL") {
  const px = Number(exitPrice);
  if (!p || !Number.isFinite(px) || px <= 0) return false;
  const raw = p.side === "LONG" ? (px - p.entry) * p.qty : (p.entry - px) * p.qty;
  const fees = p.allocation * CFG.feeRate + Math.max(0, p.allocation + raw) * CFG.feeRate;
  const pnl = raw - fees;
  state.cash += p.allocation + pnl;
  state.realizedPnl += pnl;
  if (pnl >= 0) state.stats.wins++; else state.stats.losses++;
  delete state.positions[p.symbol];
  state.cooldown[p.symbol] = Date.now() + CFG.cooldownMs;
  logEvent("EXIT", p.symbol, { side: p.side, reason, entry: p.entry, exit: px, pnl, fees });
  return true;
}

async function livePaperPrice(symbol) {
  const r = await binance("/fapi/v1/ticker/price?symbol=" + encodeURIComponent(symbol));
  const px = Number(r.price);
  if (!Number.isFinite(px) || px <= 0) throw new Error("Precio inválido para " + symbol);
  return px;
}

function recalcEquity() {
  const floating = Object.values(state.positions).reduce((sum, p) => {
    const px = Number(p.markPrice || p.entry);
    const raw = p.side === "LONG" ? (px - p.entry) * p.qty : (p.entry - px) * p.qty;
    return sum + raw;
  }, 0);
  state.floatingPnl = floating;
  state.equity = state.cash + Object.values(state.positions).reduce((sum, p) => sum + p.allocation, 0) + floating;
}

function managePosition(p, x) {
  const age = Date.now() - p.openedAt;
  let reason = null;
  if (p.side === "LONG") {
    if (x.price <= p.stop) reason = "STOP";
    else if (x.price >= p.tp) reason = "TP";
    else if (x.regime === "BEAR" && x.ema20 < x.ema50) reason = "REGIME_FLIP";
  } else {
    if (x.price >= p.stop) reason = "STOP";
    else if (x.price <= p.tp) reason = "TP";
    else if (x.regime === "BULL" && x.ema20 > x.ema50) reason = "REGIME_FLIP";
  }
  if (age >= CFG.maxHoldMs && !reason) reason = "TIME";
  if (!reason) return;
  closePaperPosition(p, x.price, reason);
}

async function scan() {
  if (state.scanRunning) return;
  state.scanRunning = true;
  const started = Date.now();
  try {
    state.status = "SCANNING ALL MARKET";
    let symbols = state.symbolsCache;
    if (!symbols.length) { symbols = await loadSymbols(); state.symbolsCache = symbols; }
    const [context, liquidity] = await Promise.all([marketContext(), load24h(symbols)]);
    state.marketContext = context;
    const liquidityMap = new Map(liquidity.map(x => [x.symbol, x]));
    const results = [];
    for (let i = 0; i < symbols.length; i += CFG.analysisBatch) {
      const batch = symbols.slice(i, i + CFG.analysisBatch);
      const out = await Promise.all(batch.map(s => analyzeSymbol(s).catch(() => null)));
      for (const x of out) if (x) results.push(x);
      state.dataMarkets = results.length;
      await sleep(20);
    }

    let candidates = bestCandidates(results, liquidityMap);
    const enrichTargets = candidates.slice(0, CFG.microstructureTop);
    const enriched = [];
    for (let i = 0; i < enrichTargets.length; i += 6) {
      const chunk = await Promise.all(enrichTargets.slice(i, i + 6).map(c => enrichMicro(c)));
      enriched.push(...chunk);
    }
    const enrichedMap = new Map(enriched.map(x => [x.symbol + "|" + (x.side || ""), x]));
    candidates = candidates.map(c => enrichedMap.get(c.symbol + "|" + c.side) || c);
    candidates.sort((a, b) => b.score - a.score);

    state.candidates = candidates.slice(0, 12).map(x => ({
      symbol: x.symbol, side: x.side, score: +x.score.toFixed(2), regime: x.regime, price: x.price,
      rsi: x.rsi, adx: x.adx, relVol: x.relVol, macdHist: x.macdHist, stoch: x.stoch,
      techScore: +x.techScore.toFixed(2), microScore: +x.microScore.toFixed(2), leadLag: +x.leadLag.toFixed(2),
      oiDeltaPct: Number.isFinite(x.oiDeltaPct) ? +x.oiDeltaPct.toFixed(3) : null,
      funding: Number.isFinite(x.funding) ? +x.funding.toFixed(5) : null,
      basisPct: Number.isFinite(x.basisPct) ? +x.basisPct.toFixed(3) : null,
      bookImbalance: Number.isFinite(x.bookImbalance) ? +x.bookImbalance.toFixed(3) : null,
      spreadBps: Number.isFinite(x.spreadBps) ? +x.spreadBps.toFixed(2) : null,
      takerRatio: Number.isFinite(x.takerRatio) ? +x.takerRatio.toFixed(3) : null,
      quoteVol: x.quoteVol, reasons: x.reasons || []
    }));

    for (const p of Object.values({ ...state.positions })) {
      const x = results.find(z => z.symbol === p.symbol);
      if (x) managePosition(p, x);
    }

    const chosen = candidates.find(c => c.score >= CFG.minEdge && sideCount(c.side) < CFG.maxSameSide);
    if (chosen && Object.keys(state.positions).length < CFG.maxPositions) enter(chosen);

    state.floatingPnl = Object.values(state.positions).reduce((sum, p) => {
      const x = results.find(z => z.symbol === p.symbol);
      if (!x) return sum;
      p.markPrice = x.price;
      return sum + (p.side === "LONG" ? (x.price - p.entry) * p.qty : (p.entry - x.price) * p.qty);
    }, 0);
    state.equity = state.cash + Object.values(state.positions).reduce((s, p) => s + p.allocation, 0) + state.floatingPnl;
    state.scans++;
    state.lastScan = new Date().toISOString();
    state.scanMs = Date.now() - started;
    state.status = "PAPER_RUNNING";
  } finally {
    state.scanRunning = false;
  }
}

app.get("/health", (_q, res) => res.json({ ok: true, status: state.status, version: state.version, scanRunning: state.scanRunning }));
app.get("/status", (_q, res) => res.json(state));

app.use(express.json());

app.post("/api/close/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").toUpperCase();
    const p = state.positions[symbol];
    if (!p) return res.status(404).json({ ok: false, error: "Posición no encontrada" });
    const price = await livePaperPrice(symbol);
    closePaperPosition(p, price, "MANUAL");
    recalcEquity();
    return res.json({ ok: true, symbol, price, realizedPnl: state.realizedPnl });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/close-all", async (_req, res) => {
  try {
    const positions = Object.values({ ...state.positions });
    let closed = 0;
    for (const p of positions) {
      try {
        const price = await livePaperPrice(p.symbol);
        if (closePaperPosition(p, price, "MANUAL_ALL")) closed++;
      } catch (e) {
        logEvent("MANUAL_CLOSE_ERROR", p.symbol, { message: e.message });
      }
    }
    recalcEquity();
    return res.json({ ok: true, closed, remaining: Object.keys(state.positions).length, realizedPnl: state.realizedPnl });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/", (_q, res) => {
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TIERRA · REAL-TIME MARKET INTELLIGENCE</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;background:#080d13;color:#edf2f7;margin:0;padding:18px}h1{font-size:30px}.card{background:#111a24;border:1px solid #2a3b4e;border-radius:16px;padding:18px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px}.big{font-size:27px;font-weight:800}.ok{color:#4ade80}.bad{color:#fb7185}.warn{color:#fbbf24}.muted{color:#94a3b8}.candidate{padding:12px 0;border-top:1px solid #253443;line-height:1.55}.tag{display:inline-block;padding:3px 7px;border-radius:8px;background:#1b2a39;margin:2px;font-size:12px}.posbar{display:flex;justify-content:space-between;align-items:center;gap:10px}.closeall,.closebtn{border:0;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}.closeall{background:#7f1d1d;color:#fff}.closebtn{margin-top:12px;background:#334155;color:#fff;width:100%}.closebtn:hover,.closeall:hover{filter:brightness(1.12)}.position{margin:12px 0;padding:14px;border-radius:14px;border:1px solid #334155;background:#0d151e}.position.win{border-color:#16a34a;background:linear-gradient(90deg,rgba(22,163,74,.18),#0d151e)}.position.loss{border-color:#dc2626;background:linear-gradient(90deg,rgba(220,38,38,.18),#0d151e)}.position.flat{border-color:#64748b}.poshead{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:17px}.statepill{padding:5px 9px;border-radius:999px;font-weight:800;font-size:12px}.win .statepill{color:#4ade80;background:rgba(74,222,128,.12)}.loss .statepill{color:#fb7185;background:rgba(251,113,133,.12)}.flat .statepill{color:#cbd5e1;background:rgba(148,163,184,.12)}.posgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.posgrid>div{background:#111c27;border-radius:10px;padding:9px;font-size:12px;color:#94a3b8}.posgrid b{display:block;color:#f8fafc;font-size:14px;margin-top:3px}.win .posgrid div:nth-child(3),.win .posgrid div:nth-child(4){color:#4ade80}.loss .posgrid div:nth-child(3),.loss .posgrid div:nth-child(4){color:#fb7185}.pbar{height:10px;background:#1e293b;border-radius:999px;overflow:hidden;margin:10px 0}.pbar>div{height:100%;background:#4ade80;border-radius:999px}.loss .pbar>div{background:#fb7185}.flat .pbar>div{background:#94a3b8}@media(max-width:700px){.posgrid{grid-template-columns:repeat(2,1fr)}}</style></head><body>
<h1>🌎 TIERRA · REAL-TIME MARKET INTELLIGENCE</h1><div class="card"><b>🟡 PAPER · Binance USD-M público · TODO EL MERCADO</b><br>Escanea todos los perpetuos USDT. BTC/ETH son contexto; las monedas pequeñas también pueden ser seleccionadas.<br><b>Lead/Lag + Spot/Futures + OI + Funding + Taker Flow + Order Book + Técnica</b><br><span class="muted">No ejecuta dinero real y no garantiza beneficios.</span></div><div id="app">Cargando…</div><script>
function esc(v){return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
async function closeOne(symbol){if(!confirm("¿Cerrar "+symbol+" ahora?"))return;try{const r=await fetch("/api/close/"+encodeURIComponent(symbol),{method:"POST"});const j=await r.json();if(!j.ok)throw new Error(j.error||"No se pudo cerrar");await load()}catch(e){alert(e.message)}}
async function closeAll(){if(!confirm("¿Cerrar TODAS las posiciones abiertas?"))return;try{const r=await fetch("/api/close-all",{method:"POST"});const j=await r.json();if(!j.ok)throw new Error(j.error||"No se pudieron cerrar");await load()}catch(e){alert(e.message)}}
async function load(){try{const s=await (await fetch('/status',{cache:'no-store'})).json();let h='<div class="grid">';h+='<div class="card"><div class="muted">ESTADO</div><div class="big">'+esc(s.status)+'</div><div>Scan '+s.scans+' · mercados '+s.dataMarkets+'/'+s.markets+' · '+s.scanMs+' ms</div></div>';h+='<div class="card"><div class="muted">EQUITY</div><div class="big">$'+Number(s.equity).toFixed(2)+'</div><div>Realizado $'+Number(s.realizedPnl).toFixed(2)+' · flotante $'+Number(s.floatingPnl).toFixed(2)+'</div></div>';h+='<div class="card"><div class="muted">BTC CONTEXTO</div><div>'+['1m','5m','15m','1h'].map(tf=>'<span class="tag">'+tf+': '+esc(s.marketContext?.[tf]||'—')+'</span>').join('')+'</div></div></div>';
h+='<div class="card"><h2>Oportunidades detectadas en todo el mercado</h2>';if(!s.candidates.length)h+='<p class="warn">NO TRADE · no hay convergencia suficiente</p>';s.candidates.forEach(c=>{h+='<div class="candidate"><b>'+esc(c.symbol)+'</b> · <b>'+esc(c.side)+'</b> · EDGE <b>'+c.score+'</b> · '+esc(c.regime)+'<br>Tech '+c.techScore+' · Micro '+c.microScore+' · Lead/Lag '+c.leadLag+' · RSI '+Number(c.rsi).toFixed(1)+' · ADX '+Number(c.adx||0).toFixed(1)+' · RV '+Number(c.relVol||0).toFixed(2)+'x<br>OI Δ '+(c.oiDeltaPct==null?'—':c.oiDeltaPct+'%')+' · Funding '+(c.funding==null?'—':c.funding)+' · Basis '+(c.basisPct==null?'—':c.basisPct+'%')+' · Book '+(c.bookImbalance==null?'—':c.bookImbalance)+' · Taker '+(c.takerRatio==null?'—':c.takerRatio)+' · Spread '+(c.spreadBps==null?'—':c.spreadBps+' bps')+'<br><span class="muted">'+esc((c.reasons||[]).join(' · '))+'</span></div>'});h+='</div>';
h+='<div class="card"><h2>Posiciones '+Object.keys(s.positions).length+'/10</h2><button class="closeall" onclick="closeAll()">✕ CERRAR TODAS</button></div>';const ps=Object.values(s.positions);if(!ps.length)h+='<p class="muted">Sin posiciones.</p>';ps.forEach(p=>{const gross=(p.side==='LONG'?(Number(p.markPrice||p.entry)-p.entry)*p.qty:(p.entry-Number(p.markPrice||p.entry))*p.qty);const estFees=p.allocation*0.0004;const net=gross-estFees;const pct=p.allocation?net/p.allocation*100:0;const cls=net>0.02?'win':net<-0.02?'loss':'flat';const label=net>0.02?'▲ GANANDO':net<-0.02?'▼ PERDIENDO':'● NEUTRAL';const width=Math.min(100,Math.max(0,50+pct*8));h+='<div class="position '+cls+'"><div class="poshead"><div><b>'+esc(p.symbol)+'</b> · <b>'+esc(p.side)+'</b></div><div class="statepill">'+label+'</div></div><div class="posgrid"><div>Entrada<br><b>'+Number(p.entry).toFixed(8)+'</b></div><div>Actual<br><b>'+Number(p.markPrice||p.entry).toFixed(8)+'</b></div><div>P&L neto<br><b>'+((net>=0?'+':'')+net.toFixed(2))+' USDT</b></div><div>Variación<br><b>'+((pct>=0?'+':'')+pct.toFixed(2))+'%</b></div></div><div class="pbar"><div style="width:'+width.toFixed(1)+'%"></div></div><div class="muted">SL '+Number(p.stop).toFixed(8)+' · TP '+Number(p.tp).toFixed(8)+' · '+esc((p.reasons||[]).join(' · '))+'</div><button class="closebtn" data-symbol="'+esc(p.symbol)+'" onclick="closeOne(this.dataset.symbol)">✕ CERRAR POSICIÓN</button></div>'});h+='</div>';
h+='<div class="card"><b>Resultados:</b> '+s.stats.wins+' ganadoras · '+s.stats.losses+' perdedoras · LONG '+s.stats.long+' · SHORT '+s.stats.short+'<br><span class="muted">Último scan: '+esc(s.lastScan||'')+'</span></div>';document.getElementById('app').innerHTML=h}catch(e){document.getElementById('app').innerHTML='<div class="card bad">'+esc(e.message)+'</div>'}}load();setInterval(load,5000);</script></body></html>`);
});

app.listen(PORT,"0.0.0.0",()=>{console.log("SUPREMO V13 listening on "+PORT);scan().catch(e=>logEvent("START_SCAN_ERROR",null,{message:e.message})).finally(function loop(){setTimeout(()=>scan().catch(e=>logEvent("SCAN_ERROR",null,{message:e.message})).finally(loop),CFG.pollMs);});});
process.on("uncaughtException",e=>console.error("UNCAUGHT_EXCEPTION",e));
process.on("unhandledRejection",e=>console.error("UNHANDLED_REJECTION",e));
async function setLeverage(symbol){
  try{
    return await signed(
      'POST',
      '/fapi/v1/leverage',
      {
        symbol,
        leverage:LEV
      }
    );
  }catch(e){
    throw e;
  }
}

async function order(
  symbol,
  side,
  quantity,
  reduceOnly=false
){
  const p={
    symbol,
    side,
    type:'MARKET',
    quantity
  };

  if(mode==='BOTH' && reduceOnly){
    p.reduceOnly='true';
  }

  if(mode==='HEDGE'){
    p.positionSide=
      side==='BUY'
        ?'LONG'
        :'SHORT';
  }

  return signed(
    'POST',
    '/fapi/v1/order',
    p
  );
}

async function open(
  symbol,
  side,
  price,
  signal
){

  if(
    S.positions.length>=MAX_POS ||
    S.positions.some(
      p=>p.symbol===symbol
    )
  ){
    return null;
  }

  const a=
    await account();

  const available=
    Number(a.availableBalance||0);

  const margin=
    Math.min(
      MARGIN,
      available*0.05
    );

  const rules=
    await symbolRules(symbol);

  const raw=
    margin*LEV/price;

  const qty=
    fmtQty(
      raw,
      rules.step
    );

  if(
    Number(qty)<rules.minQty ||
    Number(qty)*price<
      rules.minNotional
  ){
    throw new Error(
      `${symbol}: tamaño mínimo Binance supera el margen configurado`
    );
  }

  await setLeverage(symbol);

  if(!LIVE){

    const p={
      symbol,
      side,
      entry:price,
      current:price,
      qty:Number(qty),
      margin,
      sl:
        side==='LONG'
          ?price*(1-SL)
          :price*(1+SL),
      tp:
        side==='LONG'
          ?price*(1+TP)
          :price*(1-TP),
      opened:Date.now(),
      high:price,
      low:price,
      pnl:0,
      paper:true,
      score:signal.score
    };

    S.positions.push(p);

    p._protectedSL=p.sl;
    p._protectedTP=p.tp;

    return p;
  }

  const resp=
    await order(
      symbol,
      side==='LONG'
        ?'BUY'
        :'SELL',
      qty,
      false
    );

  const fill=
    Number(
      resp.avgPrice||price
    );

  const p={
    symbol,
    side,
    entry:fill,
    current:fill,
    qty:Number(qty),
    margin,
    sl:
      side==='LONG'
        ?fill*(1-SL)
        :fill*(1+SL),
    tp:
      side==='LONG'
        ?fill*(1+TP)
        :fill*(1-TP),
    opened:Date.now(),
    high:fill,
    low:fill,
    pnl:0,
    orderId:resp.orderId,
    score:signal.score
  };

  S.positions.push(p);

  p._protectedSL=p.sl;
  p._protectedTP=p.tp;

  await protect(p);

  return p;
}

async function cancelBotProtection(
  symbol
){

  try{

    const o=
      await signed(
        'GET',
        '/fapi/v1/openOrders',
        {symbol}
      );

    for(
      const x of o
    ){

      const cid=
        String(
          x.clientOrderId||''
        );

      if(
        cid.startsWith('TIERRA_')
      ){

        await signed(
          'DELETE',
          '/fapi/v1/order',
          {
            symbol,
            orderId:x.orderId
          }
        );

      }
    }

  }catch(e){

    S.lastError=
      e.message;

  }
}

async function protect(p){

  if(!LIVE)return;

  await cancelBotProtection(
    p.symbol
  );

  const closeSide=
    p.side==='LONG'
      ?'SELL'
      :'BUY';

  const ps=
    mode==='HEDGE'
      ?{positionSide:p.side}
      :{reduceOnly:'true'};

  const tag=
    `TIERRA_${p.symbol}_${p.orderId||Date.now()}`;

  await signed(
    'POST',
    '/fapi/v1/order',
    {
      symbol:p.symbol,
      side:closeSide,
      type:'STOP_MARKET',
      stopPrice:p.sl,
      closePosition:'true',
      newClientOrderId:
        (tag+'_SL').slice(0,36),
      ...ps
    }
  );

  await signed(
    'POST',
    '/fapi/v1/order',
    {
      symbol:p.symbol,
      side:closeSide,
      type:'TAKE_PROFIT_MARKET',
      stopPrice:p.tp,
      closePosition:'true',
      newClientOrderId:
        (tag+'_TP').slice(0,36),
      ...ps
    }
  );
}

async function close(
  p,
  reason
){

  if(LIVE){

    await cancelBotProtection(
      p.symbol
    );

    const side=
      p.side==='LONG'
        ?'SELL'
        :'BUY';

    if(mode==='HEDGE'){

      await order(
        p.symbol,
        side,
        p.qty,
        false
      );

    }else{

      await order(
        p.symbol,
        side,
        p.qty,
        true
      );

    }
  }

  S.realized+=
    Number(p.pnl||0);

  S.history.unshift({
    time:
      new Date().toISOString(),
    symbol:p.symbol,
    side:p.side,
    pnl:p.pnl||0,
    reason
  });

  S.history=
    S.history.slice(0,200);

  S.positions=
    S.positions.filter(
      x=>x!==p
    );
}

async function manage(){

  for(
    const p of [...S.positions]
  ){

    try{

      const t=
        await ticker(p.symbol);

      p.current=
        Number(t.price);

      p.pnl=
        p.side==='LONG'
          ?(p.current-p.entry)*p.qty
          :(p.entry-p.current)*p.qty;

      p.high=
        Math.max(
          p.high,
          p.current
        );

      p.low=
        Math.min(
          p.low,
          p.current
        );

      const profitPct=
        p.side==='LONG'
          ?(p.current/p.entry-1)
          :(p.entry/p.current-1);

      const halfTP=
        TP*0.5;

      /*
       BREAK-EVEN:
       cuando la operación alcanza
       la mitad del objetivo,
       el stop se mueve ligeramente
       por encima/debajo de la entrada.
      */

      if(
        profitPct>=halfTP
      ){

        if(p.side==='LONG'){

          p.sl=
            Math.max(
              p.sl,
              p.entry*(1+0.0005)
            );

        }else{

          p.sl=
            Math.min(
              p.sl,
              p.entry*(1-0.0005)
            );

        }
      }

      /*
       TRAILING ADAPTATIVO
      */

      const dynTrail=
        Math.max(
          TRAIL,
          p.atrPct
            ?Math.min(
              TRAIL*2,
              p.atrPct*0.8
            )
            :TRAIL
        );

      const trail=
        (
          p.side==='LONG' &&
          p.high>=
            p.entry*(1+halfTP) &&
          p.current<=
            p.high*(1-dynTrail)
        ) ||
        (
          p.side==='SHORT' &&
          p.low<=
            p.entry*(1-halfTP) &&
          p.current>=
            p.low*(1+dynTrail)
        );

      const sl=
        p.side==='LONG'
          ?p.current<=p.sl
          :p.current>=p.sl;

      const tp=
        p.side==='LONG'
          ?p.current>=p.tp
          :p.current<=p.tp;

      /*
       SALIDA POR ESTANCAMIENTO:
       ya no son solamente 10 minutos.
      */

      const stale=
        Date.now()-p.opened>
          30*60*1000 &&
        profitPct<halfTP &&
        Math.abs(p.pnl)>
          Math.max(
            0.05,
            p.margin*0.01
          );

      if(
        sl||
        tp||
        trail||
        stale
      ){

        await close(
          p,
          tp
            ?'TP'
            :sl
              ?'SL'
              :trail
                ?'TRAIL'
                :'STALE'
        );

      }else if(
        LIVE &&
        (
          p.sl!==p._protectedSL ||
          p.tp!==p._protectedTP
        )
      ){

        p._protectedSL=
          p.sl;

        p._protectedTP=
          p.tp;

        await protect(p);

      }

    }catch(e){

      S.lastError=
        e.message;

    }
  }
}
async function cycle(){
  if(busy||!S.running)return;busy=true;
  try{
    await dual();
    if(LIVE){const a=await account();S.equity=Number(a.totalWalletBalance||0);S.available=Number(a.availableBalance||0)}
    await manage();
    const sig=await topSignals();S.signals=sig;
    const lead=sig[0];S.regime=regimeFrom(lead?lead.longScore-lead.shortScore:0);
    const dayPnl=S.history.filter(x=>Date.now()-new Date(x.time).getTime()<86400000).reduce((a,x)=>a+Number(x.pnl||0),0);
    if(dayPnl<=-MAX_DAILY_LOSS){
      S.lastError=`Límite diario alcanzado: ${dayPnl.toFixed(4)} USDT`;
      S.unrealized=S.positions.reduce((a,p)=>a+(p.pnl||0),0);
      S.lastCycle=new Date().toISOString();
      return
    }
    const longs=S.positions.filter(p=>p.side==='LONG').length,
          shorts=S.positions.filter(p=>p.side==='SHORT').length;
    const candidates=sig.filter(x=>x.side!=='WAIT' && Math.max(x.longScore,x.shortScore)>=MIN_SCORE)
      .sort((a,b)=>Math.max(b.longScore,b.shortScore)-Math.max(a.longScore,a.shortScore));

    for(const x of candidates){
      if(S.positions.length>=MAX_POS)break;
      if(S.positions.some(p=>p.symbol===x.symbol))continue;
      if(x.side==='LONG' && S.positions.filter(p=>p.side==='LONG').length>=MAX_LONG)continue;
      if(x.side==='SHORT' && S.positions.filter(p=>p.side==='SHORT').length>=MAX_SHORT)continue;
      try{
        await open(x.symbol,x.side,x.price,x)
      }catch(e){
        S.lastError=e.message
      }
    }

    S.unrealized=S.positions.reduce((a,p)=>a+(p.pnl||0),0);
    S.lastCycle=new Date().toISOString();
  }catch(e){
    S.lastError=e.message
  }finally{
    busy=false
  }
}

async function sync(){
  if(!LIVE)return;
  try{
    const a=await account();
    S.equity=Number(a.totalWalletBalance||0);
    S.available=Number(a.availableBalance||0);
    const pr=await positionsRemote();

    for(const r of pr){
      const amt=Number(r.positionAmt);
      if(!amt)continue;

      const symbol=r.symbol,
            side=mode==='HEDGE'?r.positionSide:(amt>0?'LONG':'SHORT');

      let existing=S.positions.find(p=>p.symbol===symbol&&p.side===side);

      if(!existing){
        existing={
          symbol,
          side,
          entry:Number(r.entryPrice),
          current:Number(r.markPrice),
          qty:Math.abs(amt),
          margin:Math.abs(Number(r.positionInitialMargin||0)),
          sl:side==='LONG'
            ?Number(r.entryPrice)*(1-SL)
            :Number(r.entryPrice)*(1+SL),
          tp:side==='LONG'
            ?Number(r.entryPrice)*(1+TP)
            :Number(r.entryPrice)*(1-TP),
          opened:Date.now(),
          high:Number(r.markPrice),
          low:Number(r.markPrice),
          pnl:Number(r.unRealizedProfit||0),
          recovered:true
        };
        S.positions.push(existing);
      }

      existing.current=Number(r.markPrice);
      existing.pnl=Number(r.unRealizedProfit||0);
      existing.high=Math.max(existing.high,existing.current);
      existing.low=Math.min(existing.low,existing.current);

      await protect(existing);
    }
  }catch(e){
    S.lastError=e.message
  }
}

function summary(){
  const h=S.history;
  const wins=h.filter(x=>x.pnl>0),
        loss=h.filter(x=>x.pnl<0);

  return {
    generatedAt:new Date().toISOString(),
    regime:S.regime,
    openPositions:S.positions.length,
    realized:S.realized,
    unrealized:S.unrealized,
    trades:h.length,
    wins:wins.length,
    losses:loss.length,
    winRate:h.length?wins.length/h.length:0,
    avgWin:wins.length?wins.reduce((a,x)=>a+x.pnl,0)/wins.length:0,
    avgLoss:loss.length?loss.reduce((a,x)=>a+x.pnl,0)/loss.length:0,
    topSignals:S.signals.slice(0,10)
  }
}

const INDEX_HTML = `<!doctype html>
<html lang="es">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BOSCO FINAL</title>
<style>
body{font-family:system-ui;background:#0b1017;color:#eef4f8;margin:0;padding:14px}
.card{background:#111923;border:1px solid #24303c;border-radius:12px;padding:12px;margin:8px 0}
button{padding:10px 14px;border-radius:9px;border:1px solid #456;background:#17222d;color:white;font-weight:700;margin:3px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.big{font-size:20px;font-weight:800}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}}
table{width:100%;border-collapse:collapse}
td,th{padding:7px;border-bottom:1px solid #24303c;text-align:left;font-size:12px}
.good{color:#28d17c}
.bad{color:#ff5964}
</style>

<body>
<h2>🎯 BOSCO FINAL</h2>

<div class="card" id="state">Cargando…</div>

<div class="grid">
<div class="card">Modo<div class="big" id="mode">—</div></div>
<div class="card">Equity<div class="big" id="eq">—</div></div>
<div class="card">P/L<div class="big" id="pnl">—</div></div>
<div class="card">Posiciones<div class="big" id="pos">—</div></div>
</div>

<div class="card">
<button onclick="post('/api/start')">INICIAR</button>
<button onclick="post('/api/stop')">PAUSAR</button>
<button onclick="post('/api/close')">CERRAR TODO</button>
<button onclick="check()">PROBAR BINANCE</button>
</div>

<div class="card">
<b>Señales</b>
<table>
<thead>
<tr><th>PAR</th><th>SIDE</th><th>SCORE</th><th>5m</th></tr>
</thead>
<tbody id="sig"></tbody>
</table>
</div>

<div class="card">
<b>Posiciones</b>
<table>
<thead>
<tr><th>PAR</th><th>SIDE</th><th>ENTRADA</th><th>ACTUAL</th><th>P/L</th></tr>
</thead>
<tbody id="positions"></tbody>
</table>
</div>

<script>
const $=x=>document.getElementById(x);

async function j(u,o){
  let r=await fetch(u,o);
  return r.json()
}

async function post(u){
  await j(u,{
    method:'POST',
    headers:{'content-type':'application/json'}
  });
  load()
}

async function check(){
  alert(JSON.stringify(await j('/api/binance-check'),null,2))
}

async function load(){
  try{
    const s=await j('/api/status');

    $('state').textContent=
      (s.lastError?'ERROR: '+s.lastError:'OK')+
      ' · Régimen '+s.regime+
      ' · Ciclo '+(s.lastCycle||'—');

    $('mode').textContent=s.live?'LIVE':'PAPER';

    $('eq').textContent='$'+Number(s.equity||0).toFixed(2);

    $('pnl').textContent='$'+
      Number((s.realized||0)+(s.unrealized||0)).toFixed(4);

    $('pos').textContent=s.positions.length+'/'+10;

    $('sig').innerHTML=s.signals.map(x=>
      \`<tr>
        <td>\${x.symbol}</td>
        <td class="\${x.side==='LONG'?'good':'bad'}">\${x.side}</td>
        <td>\${Number(x.score).toFixed(3)}</td>
        <td>\${(x.r5*100).toFixed(3)}%</td>
      </tr>\`
    ).join('');

    $('positions').innerHTML=s.positions.map(x=>
      \`<tr>
        <td>\${x.symbol}</td>
        <td>\${x.side}</td>
        <td>\${x.entry}</td>
        <td>\${x.current}</td>
        <td class="\${x.pnl>=0?'good':'bad'}">
          \${Number(x.pnl||0).toFixed(4)}
        </td>
      </tr>\`
    ).join('')||
    '<tr><td colspan="5">Sin posiciones</td></tr>'

  }catch(e){
    $('state').textContent=e.message
  }
}

load();
setInterval(load,3000)
</script>
</body>
</html>`;

app.get('/api/health',(req,res)=>
  res.json({
    ok:true,
    live:LIVE,
    running:S.running,
    lastError:S.lastError,
    warning:S.warning
  })
);

app.get('/api/status',(req,res)=>
  res.json({...S,summary:summary()})
);

app.get('/api/positions',(req,res)=>
  res.json(S.positions)
);

app.get('/api/signals',(req,res)=>
  res.json(S.signals)
);

app.get('/api/ai-summary',(req,res)=>
  res.json(summary())
);

app.get('/api/binance-check',async(req,res)=>{
  try{
    const pub=await publicGet('/ping');
    let priv=null;

    if(KEY&&SECRET){
      const a=await account();
      priv={
        canTrade:a.canTrade,
        availableBalance:Number(a.availableBalance||0),
        totalWalletBalance:Number(a.totalWalletBalance||0),
        mode:await dual()
      };
    }

    res.json({
      ok:true,
      public:pub,
      private:priv,
      live:LIVE,
      host:FUT_HOSTS[hostIndex],
      maxPositions:MAX_POS,
      leverage:LEV
    });

  }catch(e){
    S.lastError=e.message;
    res.status(502).json({
      ok:false,
      error:e.message,
      live:LIVE
    })
  }
});

app.post('/api/start',(req,res)=>{
  S.running=true;
  res.json({
    ok:true,
    running:true,
    live:LIVE
  })
});

app.post('/api/stop',(req,res)=>{
  S.running=false;
  res.json({
    ok:true,
    running:false
  })
});

app.post('/api/close',async(req,res)=>{
  try{
    for(const p of [...S.positions])
      await close(p,'MANUAL');

    res.json({ok:true})
  }catch(e){
    S.lastError=e.message;
    res.status(500).json({
      ok:false,
      error:e.message
    })
  }
});

setInterval(()=>{
  sync();
  cycle()
},POLL);

app.get('*',(req,res)=>
  res.type('html').send(INDEX_HTML)
);

const port=Number(process.env.PORT||8080);

app.listen(
  port,
  ()=>console.log(
    \`Wealth Hunter listening on \${port} | LIVE=\${LIVE}\`
  )
);
