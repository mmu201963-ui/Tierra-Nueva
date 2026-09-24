const express = require("express");
const app = express();
const PORT = Number(process.env.PORT || 8080);

app.use(express.json());

const CFG = {
  maxPositions: 10,
  maxSameSide: 5,
  positionRiskPct: 0.02,
  minEdge: 6.5,
  cooldownMs: 10 * 60 * 1000,
  maxHoldMs: 45 * 60 * 1000,
  pollMs: 15000,
  analysisBatch: 20,
  microstructureTop: 18,
  initialCapital: Number(process.env.INITIAL_CAPITAL || 10000),
  feeRate: Number(process.env.PAPER_FEE_RATE || 0.0004),
  slippageBps: Number(process.env.PAPER_SLIPPAGE_BPS || 3)
};

const state = {
  version: "TIERRA-CIERRE-10-v1.2",
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
  stats: {
    wins: 0,
    losses: 0,
    long: 0,
    short: 0
  },
  candidates: [],
  events: [],
  lastScan: null,
  scanMs: 0,
  marketContext: {},
  scanRunning: false,
  symbolsCache: []
};

function logEvent(type, symbol, data) {
  state.events.unshift({
    time: new Date().toISOString(),
    type,
    symbol: symbol || null,
    ...(data || {})
  });

  state.events = state.events.slice(0, 120);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "TIERRA-CIERRE-10"
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        "HTTP " + response.status + " " + text.slice(0, 160)
      );
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function binance(path) {
  const urls = [
    "https://fapi.binance.com" + path,
    "https://api.binance.com" + path
  ];

  let lastError;

  for (const url of urls) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Binance unavailable");
}

async function spot(path) {
  return fetchJson("https://api.binance.com" + path);
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let value =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * k +
      value * (1 - k);
  }

  return value;
}

function atr(klines, period = 14) {
  if (klines.length < period + 1) return null;

  const tr = [];

  for (let i = 1; i < klines.length; i++) {
    const high = +klines[i][2];
    const low = +klines[i][3];
    const previousClose = +klines[i - 1][4];

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  return tr
    .slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const difference =
      closes[i] - closes[i - 1];

    if (difference > 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const difference =
      closes[i] - closes[i - 1];

    averageGain =
      ((period - 1) * averageGain +
        (difference > 0 ? difference : 0)) / period;

    averageLoss =
      ((period - 1) * averageLoss +
        (difference < 0 ? -difference : 0)) / period;
  }

  if (averageLoss === 0) return 100;

  return (
    100 -
    100 /
      (1 + averageGain / averageLoss)
  );
}

function relativeVolume(klines, n = 20) {
  if (klines.length < n + 1) return 1;

  const volumes =
    klines
      .slice(-(n + 1))
      .map(k => +k[5]);

  const average =
    volumes
      .slice(0, -1)
      .reduce((a, b) => a + b, 0) / n;

  return average
    ? volumes[volumes.length - 1] / average
    : 1;
}

function macd(closes) {
  if (closes.length < 35) return null;

  const values = [];

  for (let i = 26; i < closes.length; i++) {
    values.push(
      ema(closes.slice(0, i + 1), 12) -
      ema(closes.slice(0, i + 1), 26)
    );
  }

  const line = values.at(-1);
  const signal = ema(values, 9);

  return {
    line,
    signal,
    hist: line - signal
  };
}

function stochastic(klines, period = 14) {
  if (klines.length < period) return null;

  const values = klines.slice(-period);

  const high = Math.max(
    ...values.map(k => +k[2])
  );

  const low = Math.min(
    ...values.map(k => +k[3])
  );

  const close = +values.at(-1)[4];

  if (high === low) return 50;

  return (
    (close - low) /
    (high - low) *
    100
  );
}

function obv(klines) {
  if (klines.length < 21) return null;

  let value = 0;

  for (let i = 1; i < klines.length; i++) {
    const close = +klines[i][4];
    const previousClose = +klines[i - 1][4];
    const volume = +klines[i][5];

    if (close > previousClose) {
      value += volume;
    } else if (close < previousClose) {
      value -= volume;
    }
  }

  return value;
}

function adx(klines, period = 14) {
  if (klines.length < period * 2 + 1) {
    return null;
  }

  const tr = [];
  const plus = [];
  const minus = [];

  for (let i = 1; i < klines.length; i++) {
    const high = +klines[i][2];
    const low = +klines[i][3];

    const previousHigh = +klines[i - 1][2];
    const previousLow = +klines[i - 1][3];
    const previousClose = +klines[i - 1][4];

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );

    const up = high - previousHigh;
    const down = previousLow - low;

    plus.push(
      up > down && up > 0 ? up : 0
    );

    minus.push(
      down > up && down > 0 ? down : 0
    );
  }

  let averageTrueRange =
    tr.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  let averagePlus =
    plus.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  let averageMinus =
    minus.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  const dx = [];

  for (let i = period; i < tr.length; i++) {
    averageTrueRange =
      ((period - 1) * averageTrueRange +
        tr[i]) / period;

    averagePlus =
      ((period - 1) * averagePlus +
        plus[i]) / period;

    averageMinus =
      ((period - 1) * averageMinus +
        minus[i]) / period;

    const plusDI =
      averageTrueRange
        ? 100 * averagePlus / averageTrueRange
        : 0;

    const minusDI =
      averageTrueRange
        ? 100 * averageMinus / averageTrueRange
        : 0;

    dx.push(
      plusDI + minusDI
        ? 100 *
          Math.abs(plusDI - minusDI) /
          (plusDI + minusDI)
        : 0
    );
  }

  return dx.length
    ? dx
        .slice(-period)
        .reduce((a, b) => a + b, 0) /
      Math.min(period, dx.length)
    : null;
}
