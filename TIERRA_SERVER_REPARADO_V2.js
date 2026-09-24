import express from "express";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const CFG = {
  maxPositions: 10,
  maxSameSide: 5,
  positionRiskPct: 0.02,
  minEdge: 6.5,
  cooldownMs: 45 * 60 * 1000,
  maxHoldMs: 45 * 60 * 1000,
  pollMs: 3000,
  analysisBatch: 40,
  microstructureTop: 12,
  entryEdgeMin: 2.5,
  entryProbMin: 0.56,
  symbolConcurrency: 8,
  requestTimeoutMs: 5000,
  initialCapital: Number(process.env.INITIAL_CAPITAL || 10000),
  feeRate: Number(process.env.PAPER_FEE_RATE || 0.0004),
  slippageBps: Number(process.env.PAPER_SLIPPAGE_BPS || 3)
};

const state = {
  version: "TIERRA-ADAPTIVE-BAYES-KELLY-FIB-v2.0-REPARADO",
  mode: process.env.LIVE_TRADING === "true" ? "LIVE" : "PAPER",
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
  scanCursor: 0,
  currentBatch: 0,
  batchStart: 0,
  marketProgress: "0/0",
  analysisCache: {},
  symbolsCache: [],
  liveAvailable: 0,
  lastError: null,
  execution: { orders: 0, live: process.env.LIVE_TRADING === "true" },
  botEnabled: false,
  cycleStartedAt: 0,
  cycleLiquidity: {},
  equityHistory: [],
  learning: { global: { alpha: 1, beta: 1 }, buckets: {} }
};

function logEvent(type, symbol, data) {
  state.events.unshift(Object.assign({ time: new Date().toISOString(), type, symbol: symbol || null }, data || {}));
  state.events = state.events.slice(0, 120);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, timeout = CFG.requestTimeoutMs) {
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
  x.fib = fibLevels(ks);
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


function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function timeBucket(ts=Date.now()) { return String(new Date(ts).getUTCHours()).padStart(2,'0'); }
function learningKey(side, regimeName, ts=Date.now()) { return `${side}|${regimeName}|${timeBucket(ts)}`; }
function posteriorFor(side, regimeName, ts=Date.now()) {
  const key=learningKey(side,regimeName,ts);
  const b=state.learning.buckets[key]||{alpha:1,beta:1,trades:0};
  const g=state.learning.global||{alpha:1,beta:1};
  const weight=clamp((b.trades||0)/20,0,1);
  const a=(Number(b.alpha)||1)*weight+(Number(g.alpha)||1)*(1-weight);
  const be=(Number(b.beta)||1)*weight+(Number(g.beta)||1)*(1-weight);
  return {key,probability:a/(a+be),trades:b.trades||0};
}
function recordOutcome(pnl,side,regimeName,openedAt){
  const key=learningKey(side,regimeName,openedAt);
  const b=state.learning.buckets[key]||{alpha:1,beta:1,trades:0};
  b.trades=(b.trades||0)+1;
  if(pnl>0){b.alpha++;state.learning.global.alpha++;}else{b.beta++;state.learning.global.beta++;}
  state.learning.buckets[key]=b;
}
function fibLevels(ks){
  const closed=ks.slice(0,-1); if(closed.length<30)return null;
  const look=closed.slice(-60); let hi=-Infinity,lo=Infinity,hiI=-1,loI=-1;
  for(let i=0;i<look.length;i++){const h=+look[i][2],l=+look[i][3];if(h>hi){hi=h;hiI=i;}if(l<lo){lo=l;loI=i;}}
  if(!Number.isFinite(hi)||!Number.isFinite(lo)||hi<=lo)return null;
  const range=hi-lo;
  return {high:hi,low:lo,highIndex:hiI,lowIndex:loI,r382:hi-range*.382,r50:hi-range*.5,r618:hi-range*.618,r786:hi-range*.786,ext1272:hi+range*.272,ext1618:hi+range*.618,down382:lo+range*.382,down50:lo+range*.5,down618:lo+range*.618,down786:lo+range*.786,downExt1272:lo-range*.272,downExt1618:lo-range*.618};
}
function fibSignal(x,side){
  if(!x.fib)return {score:0,zone:'NONE',rr:1.9,reasons:[]};
  const f=x.fib,p=x.price,tol=Math.max(x.atr*.45,p*.0015);let score=0,zone='NONE',reasons=[];
  if(side==='LONG'){
    if(Math.abs(p-f.r382)<=tol){score+=.8;zone='38.2';reasons.push('FIB 38.2');}
    if(Math.abs(p-f.r50)<=tol){score+=1;zone='50';reasons.push('FIB 50');}
    if(Math.abs(p-f.r618)<=tol){score+=1.3;zone='61.8';reasons.push('FIB 61.8');}
    if(Math.abs(p-f.r786)<=tol){score+=.5;zone='78.6';reasons.push('FIB 78.6');}
    if(p>f.r382&&p<f.high)score+=.2;
  }else{
    if(Math.abs(p-f.down382)<=tol){score+=.8;zone='38.2';reasons.push('FIB 38.2');}
    if(Math.abs(p-f.down50)<=tol){score+=1;zone='50';reasons.push('FIB 50');}
    if(Math.abs(p-f.down618)<=tol){score+=1.3;zone='61.8';reasons.push('FIB 61.8');}
    if(Math.abs(p-f.down786)<=tol){score+=.5;zone='78.6';reasons.push('FIB 78.6');}
    if(p<f.down382&&p>f.low)score+=.2;
  }
  return {score,zone,rr:2.0,reasons};
}
function probabilityFromCandidate(tech,micro,lead,fib,align,volatilityPenalty,prior){
  const raw=-.15+tech*.22+micro*.16+lead*.10+fib*.18+align*.16-volatilityPenalty*.18+(prior-.5)*1.2;
  return clamp(1/(1+Math.exp(-raw)),.52,.90);
}
function kellyFraction(probability,rr){
  const b=Math.max(.5,rr),q=1-probability,raw=(probability*b-q)/b;
  return clamp(raw*.25,.003,.025);
}

function finalCandidate(x, side, liquidity) {
  const tech=side==='LONG'?x.longTech:x.shortTech;
  const micro=microScore(x,side), lead=leadLagScore(x,side), fib=fibSignal(x,side);
  const liq=liquidity&&liquidity.quoteVol>0?(liquidity.quoteVol>=5e6?.8:liquidity.quoteVol>=1e6?.4:liquidity.quoteVol>=2e5?0:-.8):0;
  const spreadPenalty=Number.isFinite(x.spreadBps)?(x.spreadBps>20?-1.2:x.spreadBps>10?-.5:.3):0;
  const align=marketAlignment(x,side), volatilityPenalty=clamp((x.atr/x.price)/.01,0,2);
  const prior=posteriorFor(side,x.regime).probability;
  const probability=probabilityFromCandidate(tech,micro.score,lead,fib.score,align,volatilityPenalty,prior);
  const rr=fib.rr, required=clamp(1/(1+rr)+.035,.52,.68), edgePct=(probability-required)*100;
  const composite=tech+micro.score+lead+fib.score+liq+spreadPenalty+align*.6+edgePct*.08;
  const kelly=kellyFraction(probability,rr);
  return {...x,side,score:composite,edgePct,probability,requiredProbability:required,kellyFraction:kelly,rewardRisk:rr,fibScore:fib.score,fibZone:fib.zone,techScore:tech,microScore:micro.score,leadLag:lead,reasons:[...micro.reasons,...fib.reasons],quoteVol:liquidity?.quoteVol||0,change24:liquidity?.change24||0};
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

function paperEnter(c) {
  if (Object.keys(state.positions).length >= CFG.maxPositions) return false;
  if (sideCount(c.side) >= CFG.maxSameSide) return false;
  const allocation = Math.min(state.cash, state.equity * Math.max(CFG.positionRiskPct, c.kellyFraction || CFG.positionRiskPct));
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
    reasons: c.reasons, techScore: c.techScore, microScore: c.microScore, leadLag: c.leadLag,
    probability:c.probability, requiredProbability:c.requiredProbability, edgePct:c.edgePct,
    kellyFraction:c.kellyFraction, rewardRisk:c.rewardRisk, fibZone:c.fibZone, markPrice:entry, pnl:0, pnlPct:0, peakPnl:0
  };
  state.cash -= allocation;
  state.stats[c.side.toLowerCase()]++;
  logEvent("ENTRY", c.symbol, { side: c.side, price: entry, score: c.score, tech: c.techScore, micro: c.microScore, leadLag: c.leadLag, reasons: c.reasons });
  return true;
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
  const raw = p.side === "LONG" ? (x.price - p.entry) * p.qty : (p.entry - x.price) * p.qty;
  const fees = p.allocation * CFG.feeRate + (p.allocation + raw) * CFG.feeRate;
  const pnl = raw - fees;
  state.cash += p.allocation + pnl;
  state.realizedPnl += pnl;
  if (pnl >= 0) state.stats.wins++; else state.stats.losses++;
  recordOutcome(pnl,p.side,p.regime,p.openedAt);
  delete state.positions[p.symbol];
  state.cooldown[p.symbol] = Date.now() + CFG.cooldownMs;
  logEvent("EXIT", p.symbol, { side: p.side, reason, entry: p.entry, exit: x.price, pnl, fees });
}


// ===== LIVE BINANCE EXECUTION LAYER =====
const LIVE = String(process.env.LIVE_TRADING || "false").toLowerCase() === "true";
const API_KEY = process.env.BINANCE_API_KEY || "";
const API_SECRET = process.env.BINANCE_API_SECRET || "";
const LIVE_LEVERAGE = Math.max(1, Math.min(5, Number(process.env.FUTURES_LEVERAGE || 3)));
const LIVE_MARGIN_PCT = Math.max(0.0025, Math.min(0.03, Number(process.env.LIVE_MARGIN_PCT || 0.01)));
const LIVE_TP_R = Math.max(1.3, Math.min(3.5, Number(process.env.LIVE_TP_R || 1.9)));
const LIVE_SL_ATR = Math.max(1.0, Math.min(3.0, Number(process.env.LIVE_SL_ATR || 1.6)));
const LIVE_MIN_NOTIONAL = Math.max(5, Number(process.env.LIVE_MIN_NOTIONAL || 6));
const LIVE_MAX_DAILY_LOSS_PCT = Math.max(0.01, Math.min(0.08, Number(process.env.MAX_DAILY_LOSS_PCT || 0.03)));
let liveMode = "BOTH";
let liveBusy = false;
let lastEquitySample = 0;

function hmac(q){ return crypto.createHmac('sha256', API_SECRET).update(q).digest('hex'); }
function encParams(obj){ return new URLSearchParams(Object.entries(obj).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)])).toString(); }
async function signedBinance(method,path,params={}){
  if(!API_KEY||!API_SECRET) throw new Error('Faltan BINANCE_API_KEY/BINANCE_API_SECRET');
  const p={...params,timestamp:Date.now(),recvWindow:5000};
  const q=encParams(p);
  let last;
  for(let i=0;i<4;i++){
    const base=["https://fapi.binance.com","https://fapi1.binance.com","https://fapi2.binance.com","https://fapi3.binance.com"][i];
    try{
      const r=await fetch(base+path+'?'+q+'&signature='+hmac(q),{method,headers:{'X-MBX-APIKEY':API_KEY,'User-Agent':'TIERRA/1.0'}});
      const text=await r.text();
      if(!r.ok) throw new Error(`${r.status}: ${text}`);
      return JSON.parse(text);
    }catch(e){ last=e; }
  }
  throw last||new Error('Binance private API unavailable');
}
async function liveAccount(){ return signedBinance('GET','/fapi/v2/account'); }
async function livePositions(){ return signedBinance('GET','/fapi/v2/positionRisk'); }
async function livePositionMode(){
  try{ const x=await signedBinance('GET','/fapi/v1/positionSide/dual'); liveMode=x.dualSidePosition?'HEDGE':'BOTH'; }
  catch(e){ state.lastError=e.message; }
  return liveMode;
}
function decimalsForStep(step){
  const s=String(step);
  if(s.includes('e-')) return Number(s.split('e-')[1]);
  return (s.split('.')[1]||'').length;
}
function floorStep(q,step){ return Math.floor(q/step)*step; }
function roundPrice(p,tick){ return tick>0 ? floorStep(p,tick) : p; }
async function liveSymbolRules(symbol){
  const info=await binance('/fapi/v1/exchangeInfo');
  const x=info.symbols.find(v=>v.symbol===symbol);
  if(!x) throw new Error('Símbolo no encontrado '+symbol);
  const lot=x.filters.find(f=>f.filterType==='LOT_SIZE');
  const minN=x.filters.find(f=>f.filterType==='MIN_NOTIONAL'||f.filterType==='NOTIONAL');
  const priceF=x.filters.find(f=>f.filterType==='PRICE_FILTER');
  return {step:Number(lot?.stepSize||1),minQty:Number(lot?.minQty||0),minNotional:Number(minN?.notional||minN?.minNotional||0),tick:Number(priceF?.tickSize||0)};
}
async function liveLeverage(symbol){ return signedBinance('POST','/fapi/v1/leverage',{symbol,leverage:LIVE_LEVERAGE}); }
async function liveOrder(symbol,side,quantity,reduceOnly=false,positionSide=null){
  const p={symbol,side,type:'MARKET',quantity};
  if(liveMode==='HEDGE') p.positionSide=positionSide || (side==='BUY'?'LONG':'SHORT');
  else if(reduceOnly) p.reduceOnly='true';
  return signedBinance('POST','/fapi/v1/order',p);
}
async function cancelTierraOrders(symbol){
  try{
    const orders=await signedBinance('GET','/fapi/v1/openOrders',{symbol});
    for(const o of orders){
      if(String(o.clientOrderId||'').startsWith('TIERRA_')){
        await signedBinance('DELETE','/fapi/v1/order',{symbol,orderId:o.orderId});
      }
    }
  }catch(e){ state.lastError=e.message; }
}
async function protectLivePosition(p){
  if(!LIVE) return;
  await cancelTierraOrders(p.symbol);
  const closeSide=p.side==='LONG'?'SELL':'BUY';
  const params={
    symbol:p.symbol, side:closeSide, type:'STOP_MARKET', stopPrice:p.stop,
    closePosition:'true', workingType:'MARK_PRICE',
    newClientOrderId:(`TIERRA_${p.symbol}_${p.orderId||Date.now()}_SL`).slice(0,36)
  };
  if(liveMode==='HEDGE') params.positionSide=p.side;
  await signedBinance('POST','/fapi/v1/order',params);
  const tp={
    symbol:p.symbol, side:closeSide, type:'TAKE_PROFIT_MARKET', stopPrice:p.tp,
    closePosition:'true', workingType:'MARK_PRICE',
    newClientOrderId:(`TIERRA_${p.symbol}_${p.orderId||Date.now()}_TP`).slice(0,36)
  };
  if(liveMode==='HEDGE') tp.positionSide=p.side;
  await signedBinance('POST','/fapi/v1/order',tp);
}
function liveCandidateKey(c){ return `${c.symbol}|${c.side}`; }
function dailyRealizedLive(){
  const since=Date.now()-86400000;
  return state.events.filter(e=>e.type==='LIVE_EXIT'&&new Date(e.time).getTime()>=since).reduce((s,e)=>s+Number(e.pnl||0),0);
}
async function enterLive(c){
  if(!LIVE) return false;
  if(Object.keys(state.positions).length>=CFG.maxPositions) return false;
  if(sideCount(c.side)>=CFG.maxSameSide) return false;
  if(state.positions[c.symbol]) return false;
  const account=await liveAccount();
  const equity=Number(account.totalWalletBalance||0);
  const available=Number(account.availableBalance||0);
  state.liveAvailable=available;
  state.equity=equity;
  if(!Number.isFinite(equity)||equity<=0) throw new Error('Equity Binance inválida');
  const margin=Math.min(equity*LIVE_MARGIN_PCT,available*0.25);
  if(margin<=0) throw new Error('Margen disponible insuficiente');
  const rules=await liveSymbolRules(c.symbol);
  const notional=margin*LIVE_LEVERAGE;
  const rawQty=notional/c.price;
  const qty=floorStep(rawQty,rules.step).toFixed(decimalsForStep(rules.step));
  const qtyN=Number(qty);
  const minNotional=Math.max(LIVE_MIN_NOTIONAL,rules.minNotional||0);
  if(qtyN<rules.minQty || qtyN*c.price<minNotional) throw new Error(`${c.symbol}: tamaño mínimo Binance supera el margen`);
  await liveLeverage(c.symbol);
  const resp=await liveOrder(c.symbol,c.side==='LONG'?'BUY':'SELL',qty,false,c.side);
  const entry=Number(resp.avgPrice||c.price);
  const stopDist=Math.max(c.atr*LIVE_SL_ATR,entry*0.007);
  const tpDist=stopDist*LIVE_TP_R;
  const rawStop=c.side==='LONG'?entry-stopDist:entry+stopDist;
  const rawTp=c.side==='LONG'?entry+tpDist:entry-tpDist;
  const stop=roundPrice(rawStop,rules.tick);
  const tp=roundPrice(rawTp,rules.tick);
  const p={symbol:c.symbol,side:c.side,entry,markPrice:entry,qty:qtyN,allocation:margin,margin,stop,tp,openedAt:Date.now(),score:c.score,regime:c.regime,reasons:c.reasons||[],techScore:c.techScore,microScore:c.microScore,leadLag:c.leadLag,orderId:resp.orderId,live:true};
  state.positions[c.symbol]=p;
  state.execution.orders++;
  state.stats[c.side.toLowerCase()]++;
  try{ await protectLivePosition(p); p._protectedStop=p.stop; p._protectedTp=p.tp; }catch(e){
    delete state.positions[c.symbol];
    try{ await liveOrder(c.symbol,c.side==='LONG'?'SELL':'BUY',qty,liveMode==='BOTH',c.side); }catch{}
    throw new Error(`Protección Binance falló; operación revertida: ${e.message}`);
  }
  logEvent('LIVE_ENTRY',c.symbol,{side:c.side,price:entry,qty:qtyN,margin,score:c.score,stop:p.stop,tp:p.tp,reasons:p.reasons});
  return true;
}
async function closeLivePosition(p,reason='MANUAL',price=null){
  if(!LIVE) return false;
  await cancelTierraOrders(p.symbol);
  const side=p.side==='LONG'?'SELL':'BUY';
  const resp=await liveOrder(p.symbol,side,p.qty,liveMode==='BOTH',p.side);
  const exit=Number(resp.avgPrice||price||p.markPrice||p.entry);
  const raw=p.side==='LONG'?(exit-p.entry)*p.qty:(p.entry-exit)*p.qty;
  const fees=(p.entry*p.qty+exit*p.qty)*Number(process.env.LIVE_FEE_RATE||0.0004);
  const pnl=raw-fees;
  delete state.positions[p.symbol];
  state.realizedPnl+=pnl;
  if(pnl>=0) state.stats.wins++; else state.stats.losses++;
  state.cooldown[p.symbol]=Date.now()+CFG.cooldownMs;
  logEvent('LIVE_EXIT',p.symbol,{side:p.side,reason,entry:p.entry,exit,pnl,fees});
  return true;
}
async function syncLivePositions(){
  if(!LIVE) return;
  const a=await liveAccount();
  state.equity=Number(a.totalWalletBalance||0);
  state.liveAvailable=Number(a.availableBalance||0);
  const remote=await livePositions();
  const active=new Set();
  for(const r of remote){
    const amt=Number(r.positionAmt||0);
    if(!amt) continue;
    const side=liveMode==='HEDGE'?r.positionSide:(amt>0?'LONG':'SHORT');
    const symbol=r.symbol; active.add(symbol);
    let p=state.positions[symbol];
    let recovered=false;
    if(!p){
      const entry=Number(r.entryPrice), mark=Number(r.markPrice);
      const margin=Math.abs(Number(r.positionInitialMargin||0));
      p={symbol,side,entry,markPrice:mark,qty:Math.abs(amt),allocation:margin,margin,stop:side==='LONG'?entry-entry*0.007:entry+entry*0.007,tp:side==='LONG'?entry+entry*0.0133:entry-entry*0.0133,openedAt:Date.now(),score:0,reasons:['RECOVERED'],recovered:true,live:true,_needsProtection:true};
      state.positions[symbol]=p; recovered=true;
      logEvent('LIVE_RECOVER',symbol,{side,entry,qty:p.qty});
    }
    p.markPrice=Number(r.markPrice); p.pnl=Number(r.unRealizedProfit||0); p.qty=Math.abs(amt);
    if(recovered){ try{ await protectLivePosition(p); p._needsProtection=false; }catch(e){ state.lastError=e.message; } }
  }
  for(const [symbol,p] of Object.entries(state.positions)){
    if(p.live && !active.has(symbol)) delete state.positions[symbol];
  }
}
async function manageLivePositions(){
  if(!LIVE) return;
  for(const p of Object.values({...state.positions})){
    try{
      const t=await binance('/fapi/v1/ticker/price?symbol='+encodeURIComponent(p.symbol));
      const price=Number(t.price); p.markPrice=price;
      const profitPct=p.side==='LONG'?(price/p.entry-1):(p.entry/price-1);
      p.high=Math.max(Number(p.high||p.entry),price); p.low=Math.min(Number(p.low||p.entry),price);
      const half=(p.tp && p.entry)?Math.abs(p.tp-p.entry)/p.entry*0.5:0.005;
      if(profitPct>=half){
        if(p.side==='LONG') p.stop=Math.max(p.stop,p.entry*1.0005);
        else p.stop=Math.min(p.stop,p.entry*0.9995);
      }
      const trail=Math.max(0.0025,Math.min(0.012,(p.entry?Math.abs(p.tp-p.entry)/p.entry:0.01)*0.45));
      const trailing=(p.side==='LONG'&&p.high>=p.entry*(1+half)&&price<=p.high*(1-trail))||(p.side==='SHORT'&&p.low<=p.entry*(1-half)&&price>=p.low*(1+trail));
      const stopHit=p.side==='LONG'?price<=p.stop:price>=p.stop;
      const tpHit=p.side==='LONG'?price>=p.tp:price<=p.tp;
      const stale=Date.now()-p.openedAt>CFG.maxHoldMs && profitPct<half;
      const regimeFlip=(p.side==='LONG'&&state.marketContext['5m']==='BEAR'&&state.marketContext['15m']==='BEAR')||(p.side==='SHORT'&&state.marketContext['5m']==='BULL'&&state.marketContext['15m']==='BULL');
      if(stopHit||tpHit||trailing||stale||regimeFlip){
        await closeLivePosition(p,tpHit?'TP':stopHit?'STOP':trailing?'TRAIL':regimeFlip?'REGIME_FLIP':'TIME',price);
      } else if(p._protectedStop!==p.stop || p._protectedTp!==p.tp || p._needsProtection){
        await protectLivePosition(p);
        p._protectedStop=p.stop; p._protectedTp=p.tp; p._needsProtection=false;
      }
    }catch(e){state.lastError=e.message;logEvent('LIVE_MANAGE_ERROR',p.symbol,{message:e.message});}
  }
}

async function analyzeBatchBounded(symbols, concurrency=8){
  const out=[]; let cursor=0;
  async function worker(){
    while(true){
      const i=cursor++; if(i>=symbols.length) return;
      const symbol=symbols[i];
      try{ const x=await analyzeSymbol(symbol); if(x) out.push(x); }
      catch(e){ state.lastError=`ANALYZE ${symbol}: ${e.message}`; logEvent('ANALYZE_ERROR',symbol,{message:e.message}); }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,symbols.length)},()=>worker()));
  return out;
}

async function scan(){
  if(state.scanRunning)return;
  state.scanRunning=true;
  const stepStarted=Date.now();
  try{
    state.mode=LIVE?'LIVE':'PAPER';
    let symbols=state.symbolsCache;
    if(!symbols.length){symbols=await loadSymbols();state.symbolsCache=symbols;state.scanCursor=0;state.analysisCache={};}
    if(!symbols.length)throw new Error('Binance no devolvió mercados USDT PERPETUAL');

    // Inicia un ciclo nuevo: contexto/liquidez una sola vez.
    if(Number(state.scanCursor||0)===0){
      state.cycleStartedAt=Date.now();
      state.status='SCANNING ALL MARKET';
      try{
        const [context,liquidity]=await Promise.all([marketContext(),load24h(symbols)]);
        state.marketContext=context;
        state.cycleLiquidity=Object.fromEntries(liquidity.map(x=>[x.symbol,x]));
      }catch(e){state.lastError=`MARKET_CONTEXT: ${e.message}`;logEvent('CONTEXT_ERROR',null,{message:e.message});}
      state.analysisCache={};
      state.dataMarkets=0;
      state.marketProgress=`0/${symbols.length}`;
    }

    const start=Math.min(Number(state.scanCursor||0),symbols.length);
    const batch=symbols.slice(start,start+CFG.analysisBatch);
    state.currentBatch=batch.length;
    state.batchStart=start;
    state.status=`SCANNING ALL MARKET · ${start}/${symbols.length}`;

    const out=await analyzeBatchBounded(batch,CFG.symbolConcurrency);
    for(const x of out)state.analysisCache[x.symbol]=x;
    state.scanCursor=start+batch.length;
    state.dataMarkets=Object.keys(state.analysisCache).length;
    state.marketProgress=`${state.dataMarkets}/${symbols.length}`;
    state.scanMs=Date.now()-stepStarted;

    // Todavía no finalizamos: la siguiente iteración continúa inmediatamente.
    if(state.scanCursor<symbols.length){
      state.status=`SCANNING ALL MARKET · ${state.dataMarkets}/${symbols.length}`;
      return;
    }

    // ===== FIN DEL CICLO COMPLETO =====
    const results=Object.values(state.analysisCache);
    const liquidityMap=new Map(Object.entries(state.cycleLiquidity||{}));
    let preliminary=[];
    for(const x of results){
      if(x.regime==='VOLATILE')continue;
      if(state.cooldown[x.symbol]&&Date.now()<state.cooldown[x.symbol])continue;
      if(state.positions[x.symbol])continue;
      const liq=liquidityMap.get(x.symbol);
      for(const side of ['LONG','SHORT'])preliminary.push(finalCandidate(x,side,liq));
    }
    preliminary.sort((a,b)=>b.score-a.score);

    const enrichTargets=preliminary.slice(0,CFG.microstructureTop);
    const enriched=[];
    for(let i=0;i<enrichTargets.length;i+=4){
      const chunk=await Promise.all(enrichTargets.slice(i,i+4).map(c=>enrichMicro(c)));
      enriched.push(...chunk);
    }
    const enrichedMap=new Map(enriched.map(x=>[x.symbol+'|'+x.side,x]));
    let candidates=preliminary.map(c=>{
      const e=enrichedMap.get(c.symbol+'|'+c.side);
      return e?finalCandidate(e,c.side,liquidityMap.get(c.symbol)):c;
    });
    candidates=candidates.filter(c=>c.edgePct>=CFG.entryEdgeMin&&c.probability>=Math.max(CFG.entryProbMin,c.requiredProbability));
    candidates.sort((a,b)=>b.score-a.score);

    state.candidates=candidates.slice(0,12).map(x=>({
      symbol:x.symbol,side:x.side,score:+x.score.toFixed(2),regime:x.regime,price:x.price,
      rsi:x.rsi,adx:x.adx,relVol:x.relVol,macdHist:x.macdHist,stoch:x.stoch,
      techScore:+x.techScore.toFixed(2),microScore:+x.microScore.toFixed(2),leadLag:+x.leadLag.toFixed(2),
      probability:+(x.probability*100).toFixed(1),requiredProbability:+(x.requiredProbability*100).toFixed(1),edgePct:+x.edgePct.toFixed(2),kellyFraction:+(x.kellyFraction*100).toFixed(2),rewardRisk:+x.rewardRisk.toFixed(2),fibZone:x.fibZone,fibScore:+x.fibScore.toFixed(2),
      oiDeltaPct:Number.isFinite(x.oiDeltaPct)?+x.oiDeltaPct.toFixed(3):null,funding:Number.isFinite(x.funding)?+x.funding.toFixed(5):null,basisPct:Number.isFinite(x.basisPct)?+x.basisPct.toFixed(3):null,bookImbalance:Number.isFinite(x.bookImbalance)?+x.bookImbalance.toFixed(3):null,spreadBps:Number.isFinite(x.spreadBps)?+x.spreadBps.toFixed(2):null,takerRatio:Number.isFinite(x.takerRatio)?+x.takerRatio.toFixed(3):null,quoteVol:x.quoteVol,reasons:x.reasons||[]
    }));

    if(!LIVE){
      for(const p of Object.values({...state.positions})){const x=results.find(z=>z.symbol===p.symbol);if(x)managePosition(p,x);}
      const chosen=candidates.find(c=>c.edgePct>=CFG.entryEdgeMin&&c.probability>=Math.max(CFG.entryProbMin,c.requiredProbability)&&sideCount(c.side)<CFG.maxSameSide);
      if(state.botEnabled&&chosen&&Object.keys(state.positions).length<CFG.maxPositions)paperEnter(chosen);
      state.status=state.botEnabled?'PAPER_RUNNING':'PAPER_READY';
    }else{
      await livePositionMode(); await manageLivePositions();
      const dayLimit=Math.max(10,state.equity*LIVE_MAX_DAILY_LOSS_PCT);
      if(dailyRealizedLive()<=-dayLimit){state.status='LIVE_RISK_PAUSED';state.lastError=`Límite diario LIVE alcanzado: ${dailyRealizedLive().toFixed(2)} USDT`;}
      else if(state.botEnabled){let opened=0;const usedSides={LONG:sideCount('LONG'),SHORT:sideCount('SHORT')};for(const c of candidates){if(Object.keys(state.positions).length>=CFG.maxPositions)break;if(usedSides[c.side]>=CFG.maxSameSide||state.positions[c.symbol])continue;try{if(await enterLive(c)){usedSides[c.side]++;opened++;}}catch(e){state.lastError=e.message;logEvent('LIVE_ENTRY_ERROR',c.symbol,{message:e.message});}}state.status=opened?`LIVE_RUNNING · +${opened}`:'LIVE_RUNNING';}
      else state.status='LIVE_PAUSED';
      await syncLivePositions();
    }

    if(!LIVE){
      state.floatingPnl=Object.values(state.positions).reduce((sum,p)=>{const x=results.find(z=>z.symbol===p.symbol);if(!x)return sum;p.markPrice=x.price;p.pnl=p.side==='LONG'?(x.price-p.entry)*p.qty:(p.entry-x.price)*p.qty;return sum+p.pnl;},0);
      state.equity=state.cash+Object.values(state.positions).reduce((s,p)=>s+p.allocation,0)+state.floatingPnl;
    }else state.floatingPnl=Object.values(state.positions).reduce((sum,p)=>sum+Number(p.pnl||0),0);
    state.equityHistory.push({t:Date.now(),equity:+state.equity.toFixed(4),pnl:+state.floatingPnl.toFixed(4)});if(state.equityHistory.length>120)state.equityHistory.shift();
    state.execution.eligibleCandidates=candidates.length;state.execution.botEnabled=state.botEnabled;
    state.scans++;state.lastScan=new Date().toISOString();state.scanMs=Date.now()-(state.cycleStartedAt||Date.now());

    // Reinicia el cursor para el siguiente ciclo, pero deja visible el 100% logrado.
    state.scanCursor=0;
    state.currentBatch=0;
    state.marketProgress=`${symbols.length}/${symbols.length}`;
    state.analysisCache={};
    state.cycleLiquidity={};
  }finally{state.scanRunning=false;}
}

app.get("/health", (_q, res) => res.json({ ok: true, status: state.status, version: state.version, mode: state.mode, live: LIVE, scanRunning: state.scanRunning, lastError: state.lastError }));
app.get("/status", (_q, res) => res.json(state));
app.get("/api/status", (_q, res) => res.json(state));
app.get("/api/health", (_q, res) => res.json({ ok:true, status:state.status, version:state.version, mode:state.mode, live:LIVE, scanRunning:state.scanRunning, lastError:state.lastError }));
app.get("/api/positions", (_q, res) => res.json(Object.values(state.positions)));

app.post("/api/start", (_q,res)=>{ state.botEnabled=true; state.status=LIVE?"LIVE_RUNNING":"PAPER_RUNNING"; res.json({ok:true,mode:state.mode,status:state.status,botEnabled:true}); });
app.post("/api/stop", (_q,res)=>{ state.botEnabled=false; state.status=LIVE?"LIVE_PAUSED":"PAPER_READY"; res.json({ok:true,status:state.status,botEnabled:false}); });
app.post("/api/close/:symbol", async (req,res)=>{
  try{
    const symbol=String(req.params.symbol||'').toUpperCase();
    const p=state.positions[symbol];
    if(!p) return res.status(404).json({ok:false,error:'Posición no encontrada'});
    if(LIVE) await closeLivePosition(p,'MANUAL');
    else {
      const price=await binance('/fapi/v1/ticker/price?symbol='+encodeURIComponent(symbol));
      const x=Number(price.price); const raw=p.side==='LONG'?(x-p.entry)*p.qty:(p.entry-x)*p.qty; const fees=p.allocation*CFG.feeRate+(p.allocation+raw)*CFG.feeRate; const pnl=raw-fees;
      state.cash+=p.allocation+pnl; state.realizedPnl+=pnl; if(pnl>=0)state.stats.wins++;else state.stats.losses++; delete state.positions[symbol]; state.cooldown[symbol]=Date.now()+CFG.cooldownMs; logEvent('EXIT',symbol,{side:p.side,reason:'MANUAL',entry:p.entry,exit:x,pnl,fees});
    }
    res.json({ok:true,symbol});
  }catch(e){state.lastError=e.message;res.status(500).json({ok:false,error:e.message});}
});
app.post("/api/close-all", async (_q,res)=>{
  try{ let closed=0; for(const p of Object.values({...state.positions})){ try{ if(LIVE) await closeLivePosition(p,'MANUAL_ALL'); else { const t=await binance('/fapi/v1/ticker/price?symbol='+encodeURIComponent(p.symbol)); const x=Number(t.price); const raw=p.side==='LONG'?(x-p.entry)*p.qty:(p.entry-x)*p.qty; const fees=p.allocation*CFG.feeRate+(p.allocation+raw)*CFG.feeRate; const pnl=raw-fees; state.cash+=p.allocation+pnl;state.realizedPnl+=pnl;if(pnl>=0)state.stats.wins++;else state.stats.losses++;delete state.positions[p.symbol]; } closed++; }catch(e){logEvent('CLOSE_ERROR',p.symbol,{message:e.message});} } res.json({ok:true,closed,remaining:Object.keys(state.positions).length}); }
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get("/api/diagnostics", (_q,res)=>res.json({ok:true,mode:state.mode,botEnabled:state.botEnabled,status:state.status,markets:state.markets,dataMarkets:state.dataMarkets,scans:state.scans,candidates:state.candidates.length,eligibleCandidates:state.execution.eligibleCandidates||0,lastError:state.lastError,lastScan:state.lastScan,marketProgress:state.marketProgress,scanCursor:state.scanCursor,positions:Object.keys(state.positions).length}));
app.get("/api/binance-check",async(_q,res)=>{
  try{ const pub=await binance('/fapi/v1/ping'); let priv=null; if(API_KEY&&API_SECRET){ const a=await liveAccount(); priv={canTrade:a.canTrade,availableBalance:Number(a.availableBalance||0),totalWalletBalance:Number(a.totalWalletBalance||0),mode:await livePositionMode()}; } res.json({ok:true,live:LIVE,public:pub,private:priv,maxPositions:CFG.maxPositions,maxSameSide:CFG.maxSameSide,leverage:LIVE_LEVERAGE}); }
  catch(e){state.lastError=e.message;res.status(502).json({ok:false,error:e.message,live:LIVE});}
});

app.get("/", (_q, res) => {
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TIERRA · REAL-TIME MARKET INTELLIGENCE</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;background:#080d13;color:#edf2f7;margin:0;padding:18px}h1{font-size:30px}.card{background:#111a24;border:1px solid #2a3b4e;border-radius:16px;padding:18px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px}.big{font-size:27px;font-weight:800}.ok{color:#4ade80}.bad{color:#fb7185}.warn{color:#fbbf24}.muted{color:#94a3b8}.candidate{padding:12px 0;border-top:1px solid #253443;line-height:1.55}.tag{display:inline-block;padding:3px 7px;border-radius:8px;background:#1b2a39;margin:2px;font-size:12px}.position{margin:12px 0;padding:14px;border-radius:14px;border:1px solid #334155;background:#0d151e}.position.win{border-color:#16a34a;background:linear-gradient(90deg,rgba(22,163,74,.18),#0d151e)}.position.loss{border-color:#dc2626;background:linear-gradient(90deg,rgba(220,38,38,.18),#0d151e)}.position.flat{border-color:#64748b}.poshead{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:17px}.statepill{padding:5px 9px;border-radius:999px;font-weight:800;font-size:12px}.win .statepill{color:#4ade80;background:rgba(74,222,128,.12)}.loss .statepill{color:#fb7185;background:rgba(251,113,133,.12)}.flat .statepill{color:#cbd5e1;background:rgba(148,163,184,.12)}.posgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.posgrid>div{background:#111c27;border-radius:10px;padding:9px;font-size:12px;color:#94a3b8}.posgrid b{display:block;color:#f8fafc;font-size:14px;margin-top:3px}.win .posgrid div:nth-child(3),.win .posgrid div:nth-child(4){color:#4ade80}.loss .posgrid div:nth-child(3),.loss .posgrid div:nth-child(4){color:#fb7185}.pbar{height:10px;background:#1e293b;border-radius:999px;overflow:hidden;margin:10px 0}.pbar>div{height:100%;background:#4ade80;border-radius:999px}.loss .pbar>div{background:#fb7185}.flat .pbar>div{background:#94a3b8}@media(max-width:700px){.posgrid{grid-template-columns:repeat(2,1fr)}}</style></head><body>
<h1>🌎 TIERRA · REAL-TIME MARKET INTELLIGENCE</h1><div class="card"><b>Versión: TIERRA-ADAPTIVE-BAYES-KELLY-FIB-v2.0-REPARADO</b> · Backend + Dashboard sincronizados</div><div class="card"><b>⚙️ TIERRA · Binance USD-M · TODO EL MERCADO · <span id="modeBadge">${state.mode}</span></b><br>Escanea todos los perpetuos USDT. BTC/ETH son contexto; las monedas pequeñas también pueden ser seleccionadas.<br><b>Lead/Lag + Spot/Futures + OI + Funding + Taker Flow + Order Book + Técnica</b><br><span class="muted">LIVE solo si LIVE_TRADING=true. No garantiza beneficios.</span></div><div class="card"><button onclick="post('/api/start')">INICIAR</button><button onclick="post('/api/stop')">PAUSAR</button><button onclick="check()">PROBAR BINANCE</button><button onclick="closeAll()">CERRAR TODO</button></div><div id="app">Cargando…</div><script>
async function post(u){await fetch(u,{method:"POST"});await load()}
async function check(){alert(JSON.stringify(await (await fetch("/api/binance-check")).json(),null,2))}
async function closeAll(){if(confirm("¿Cerrar todas las posiciones?")){await fetch("/api/close-all",{method:"POST"});await load()}}
async function closeOne(sym){const symbol=decodeURIComponent(sym);if(confirm("¿Cerrar "+symbol+"?")){await fetch("/api/close/"+encodeURIComponent(symbol),{method:"POST"});await load()}}
function esc(v){return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
async function load(){try{const r=await fetch('/status?ts='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error('/status HTTP '+r.status);const s=await r.json();let h='<div class="grid">';h+='<div class="card"><div class="muted">ESTADO</div><div class="big">'+esc(s.status)+'</div><div>BOT '+(s.botEnabled?'🟢 ENCENDIDO':'⚪ APAGADO')+' · Scan '+s.scans+' · mercados '+s.dataMarkets+'/'+s.markets+' · lote '+(s.currentBatch||0)+' · '+s.scanMs+' ms</div><div class="muted">Progreso acumulado: '+esc(s.marketProgress||'0/0')+' · cursor '+(s.scanCursor||0)+'</div>' + (s.lastError?'<div class="bad">Error: '+esc(s.lastError)+'</div>':'')</div>';h+='<div class="card"><div class="muted">EQUITY</div><div class="big">$'+Number(s.equity).toFixed(2)+'</div><div>Realizado $'+Number(s.realizedPnl).toFixed(2)+' · flotante $'+Number(s.floatingPnl).toFixed(2)+'</div></div>';h+='<div class="card"><div class="muted">BTC CONTEXTO</div><div>'+['1m','5m','15m','1h'].map(tf=>'<span class="tag">'+tf+': '+esc(s.marketContext?.[tf]||'—')+'</span>').join('')+'</div></div></div>';
h+='<div class="card"><h2>Oportunidades detectadas en todo el mercado</h2>';if(!s.candidates.length)h+='<p class="warn">NO TRADE · no hay convergencia suficiente</p>';s.candidates.forEach(c=>{h+='<div class="candidate"><b>'+esc(c.symbol)+'</b> · <b>'+esc(c.side)+'</b> · EDGE <b>'+c.score+'</b> · '+esc(c.regime)+'<br>Tech '+c.techScore+' · Micro '+c.microScore+' · Lead/Lag '+c.leadLag+' · RSI '+Number(c.rsi).toFixed(1)+' · ADX '+Number(c.adx||0).toFixed(1)+' · RV '+Number(c.relVol||0).toFixed(2)+'x<br>OI Δ '+(c.oiDeltaPct==null?'—':c.oiDeltaPct+'%')+' · Funding '+(c.funding==null?'—':c.funding)+' · Basis '+(c.basisPct==null?'—':c.basisPct+'%')+' · Book '+(c.bookImbalance==null?'—':c.bookImbalance)+' · Taker '+(c.takerRatio==null?'—':c.takerRatio)+' · Spread '+(c.spreadBps==null?'—':c.spreadBps+' bps')+'<br><span class="muted">'+esc((c.reasons||[]).join(' · '))+'</span></div>'});h+='</div>';
h+='<div class="card"><h2>Posiciones '+Object.keys(s.positions).length+'/10</h2>';const ps=Object.values(s.positions);if(!ps.length)h+='<p class="muted">Sin posiciones.</p>';ps.forEach(p=>{const gross=(p.side==='LONG'?(Number(p.markPrice||p.entry)-p.entry)*p.qty:(p.entry-Number(p.markPrice||p.entry))*p.qty);const estFees=p.allocation*0.0004;const net=gross-estFees;const pct=p.allocation?net/p.allocation*100:0;const cls=net>0.02?'win':net<-0.02?'loss':'flat';const label=net>0.02?'▲ GANANDO':net<-0.02?'▼ PERDIENDO':'● NEUTRAL';const width=Math.min(100,Math.max(0,50+pct*8));h+='<div class="position '+cls+'"><div class="poshead"><div><b>'+esc(p.symbol)+'</b> · <b>'+esc(p.side)+'</b></div><div class="statepill">'+label+'</div></div><div class="posgrid"><div>Entrada<br><b>'+Number(p.entry).toFixed(8)+'</b></div><div>Actual<br><b>'+Number(p.markPrice||p.entry).toFixed(8)+'</b></div><div>P&L neto<br><b>'+((net>=0?'+':'')+net.toFixed(2))+' USDT</b></div><div>Variación<br><b>'+((pct>=0?'+':'')+pct.toFixed(2))+'%</b></div></div><div class="pbar"><div style="width:'+width.toFixed(1)+'%"></div></div><div class="muted">SL '+Number(p.stop).toFixed(8)+' · TP '+Number(p.tp).toFixed(8)+' · '+esc((p.reasons||[]).join(' · '))+'</div><button style="margin-top:10px;background:#7f1d1d;color:#fff;border:1px solid #ef4444;border-radius:10px;padding:10px 14px;font-weight:800;width:100%" onclick="closeOne(encodeURIComponent(''+p.symbol+''))">CERRAR '+esc(p.symbol)+'</button></div>'});h+='</div>';
h+='<div class="card"><b>Resultados:</b> '+s.stats.wins+' ganadoras · '+s.stats.losses+' perdedoras · LONG '+s.stats.long+' · SHORT '+s.stats.short+'<br><span class="muted">Último scan: '+esc(s.lastScan||'')+'</span></div>';document.getElementById('app').innerHTML=h}catch(e){document.getElementById('app').innerHTML='<div class="card bad">'+esc(e.message)+'</div>'}}load();setInterval(load,2000);</script></body></html>`);
});

async function mainLoop(){
  try{ await scan(); }
  catch(e){ state.lastError=e.message; logEvent("SCAN_ERROR",null,{message:e.message}); }
  setTimeout(mainLoop, CFG.pollMs);
}

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`TIERRA listening on ${PORT} | MODE=${LIVE?'LIVE':'PAPER'} | MAX=${CFG.maxPositions}`);
  if(LIVE && (!API_KEY || !API_SECRET)) console.error('LIVE_TRADING=true pero faltan BINANCE_API_KEY/BINANCE_API_SECRET');
  if(LIVE){ livePositionMode().then(()=>syncLivePositions()).catch(e=>{state.lastError=e.message;}).finally(mainLoop); }
  else mainLoop();
});
process.on("uncaughtException",e=>console.error("UNCAUGHT_EXCEPTION",e));
process.on("unhandledRejection",e=>console.error("UNHANDLED_REJECTION",e));
