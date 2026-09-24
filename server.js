
'use strict';

/*
 SOL — MULTI-STRATEGY PAPER ENGINE / LIVE-READY
 ------------------------------------------------
 PAPER is the default. No Binance private keys are required in PAPER.
 The engine combines:
 - Market regime / EMA trend
 - Momentum / RSI / MACD
 - ATR volatility
 - Relative volume
 - Breakout + mean-reversion context
 - Funding
 - Open Interest
 - Order-book imbalance
 - Taker buy/sell flow
 - BTC/market lead-lag context
 - Independent LONG and SHORT scoring
 - Dynamic candidate ranking
 - Position limits / cooldown
 - TP / SL / break-even / trailing
 - Individual close + close all
 - Detailed rejection reasons
 - Binance public connectivity diagnostics

 This is software, not a profitability guarantee.
 LIVE_TRADING=false by default.
*/

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const CFG = {
  PORT: Number(process.env.PORT || 3000),
  LIVE: String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true',
  MAX_POS: Math.max(1, Math.min(10, Number(process.env.MAX_POSITIONS || 10))),
  MAX_SAME_SIDE: Math.max(1, Math.min(5, Number(process.env.MAX_SAME_SIDE || 5))),
  POLL_MS: Math.max(5000, Number(process.env.SCAN_INTERVAL_MS || 20000)),
  ANALYZE_TOP: Math.max(20, Math.min(120, Number(process.env.ANALYZE_TOP || 80))),
  MICRO_TOP: Math.max(8, Math.min(30, Number(process.env.MICRO_TOP || 20))),
  CONCURRENCY: Math.max(2, Math.min(12, Number(process.env.CONCURRENCY || 8))),
  ENTRY_SCORE: Math.max(0.52, Math.min(0.90, Number(process.env.MIN_SIGNAL_SCORE || 0.58))),
  TP: Math.max(0.003, Math.min(0.03, Number(process.env.TAKE_PROFIT_PCT || 0.006))),
  SL: Math.max(0.0025, Math.min(0.02, Number(process.env.STOP_AT_LOSS_PCT || 0.004))),
  TRAIL: Math.max(0.0015, Math.min(0.015, Number(process.env.TRAILING_PCT || 0.0025))),
  BE_TRIGGER: Math.max(0.002, Math.min(0.01, Number(process.env.BREAK_EVEN_TRIGGER || 0.003))),
  MARGIN: Math.max(1, Number(process.env.PAPER_MARGIN || 50)),
  START_CAPITAL: Math.max(100, Number(process.env.PAPER_CAPITAL || 10000)),
  FEE: Number(process.env.PAPER_FEE || 0.0004),
  COOLDOWN_MS: Math.max(60000, Number(process.env.COOLDOWN_MS || 8*60*1000)),
  MAX_HOLD_MS: Math.max(5*60*1000, Number(process.env.MAX_HOLD_MS || 90*60*1000)),
  LEVERAGE: Math.max(1, Math.min(5, Number(process.env.FUTURES_LEVERAGE || 3))),
};

const HOSTS = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
];

const state = {
  startedAt: Date.now(),
  enabled: true,
  scanNo: 0,
  scanning: false,
  marketCount: 0,
  analyzed: 0,
  lastScanMs: 0,
  lastScanAt: null,
  lastError: null,
  lastDecision: 'BOOT',
  lastDecisionDetail: '',
  equity: CFG.START_CAPITAL,
  cash: CFG.START_CAPITAL,
  realized: 0,
  fees: 0,
  wins: 0,
  losses: 0,
  positions: {},
  candidates: [],
  rejections: [],
  logs: [],
  symbols: [],
  universe: [],
  cooldown: {},
  binance: { ok:false, host:null, latency:null, message:'not tested' },
  regime: 'UNKNOWN',
  btc: null,
};

function log(msg, data='') {
  const line = `[${new Date().toISOString()}] ${msg}${data ? ' '+data : ''}`;
  state.logs.unshift(line);
  if (state.logs.length > 120) state.logs.length = 120;
  console.log(line);
}

function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }
function n(x,d=0){ const v=Number(x); return Number.isFinite(v)?v:d; }
function pct(a,b){ return b ? (a/b)-1 : 0; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function api(path, params={}, signed=false, method='GET') {
  let last;
  for (const host of HOSTS) {
    try {
      const u = new URL(host + path);
      Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,String(v)));
      if (signed) {
        const key=process.env.BINANCE_API_KEY;
        const secret=process.env.BINANCE_API_SECRET;
        if(!key || !secret) throw new Error('BINANCE_API_KEY/BINANCE_API_SECRET missing');
        u.searchParams.set('timestamp',Date.now());
        u.searchParams.set('recvWindow','5000');
        const sig=crypto.createHmac('sha256',secret).update(u.searchParams.toString()).digest('hex');
        u.searchParams.set('signature',sig);
      }
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),7000);
      const headers={};
      if(signed) headers['X-MBX-APIKEY']=process.env.BINANCE_API_KEY;
      const res=await fetch(u,{method,headers,signal:controller.signal});
      clearTimeout(timer);
      const txt=await res.text();
      let data; try{data=JSON.parse(txt)}catch{data={raw:txt}};
      if(!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(data).slice(0,240)}`);
      return data;
    } catch(e) { last=e; }
  }
  throw last || new Error('Binance unavailable');
}

async function binanceCheck(){
  const t=Date.now();
  try {
    const d=await api('/fapi/v1/time');
    state.binance={ok:true,host:'public-futures',latency:Date.now()-t,message:`serverTime ${d.serverTime}`};
    return state.binance;
  } catch(e) {
    state.binance={ok:false,host:null,latency:Date.now()-t,message:e.message};
    return state.binance;
  }
}

function ema(vals,p){
  if(!vals.length) return 0;
  const k=2/(p+1), start=vals.slice(0,p);
  let e=start.reduce((a,b)=>a+b,0)/start.length;
  for(let i=p;i<vals.length;i++) e=vals[i]*k+e*(1-k);
  return e;
}
function sma(vals,p){ return vals.length<p ? vals.reduce((a,b)=>a+b,0)/Math.max(1,vals.length) : vals.slice(-p).reduce((a,b)=>a+b,0)/p; }
function rsi(vals,p=14){
  if(vals.length<p+1) return 50;
  let g=0,l=0;
  for(let i=vals.length-p;i<vals.length;i++){const d=vals[i]-vals[i-1]; if(d>=0)g+=d;else l-=d;}
  if(l===0)return 100;
  return 100-(100/(1+g/l));
}
function atr(kl,p=14){
  if(kl.length<p+1)return 0;
  const tr=[];
  for(let i=1;i<kl.length;i++){
    const h=+kl[i][2],lo=+kl[i][3],pc=+kl[i-1][4];
    tr.push(Math.max(h-lo,Math.abs(h-pc),Math.abs(lo-pc)));
  }
  return sma(tr,p);
}
function macd(vals){
  const e12=ema(vals,12), e26=ema(vals,26);
  return e12-e26;
}
function stdev(vals){
  if(!vals.length)return 0;
  const m=vals.reduce((a,b)=>a+b,0)/vals.length;
  return Math.sqrt(vals.reduce((a,b)=>a+(b-m)**2,0)/vals.length);
}
function zscore(v,arr){
  const s=stdev(arr); return s ? (v-sma(arr,arr.length))/s : 0;
}

async function mapLimit(items, limit, fn){
  const out=new Array(items.length); let idx=0;
  async function worker(){
    while(true){
      const i=idx++; if(i>=items.length)return;
      try{out[i]=await fn(items[i],i)}catch(e){out[i]={error:e.message,symbol:items[i].symbol||items[i]};}
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

async function loadUniverse(){
  const info=await api('/fapi/v1/exchangeInfo');
  const ticker=await api('/fapi/v1/ticker/24hr');
  const by=new Map(ticker.map(x=>[x.symbol,x]));
  const arr=info.symbols.filter(s=>
    s.status==='TRADING' &&
    s.quoteAsset==='USDT' &&
    s.contractType==='PERPETUAL' &&
    s.symbol!=='USDCUSDT'
  ).map(s=>{
    const t=by.get(s.symbol)||{};
    return {
      symbol:s.symbol,
      price:n(t.lastPrice),
      change:n(t.priceChangePercent)/100,
      volume:n(t.quoteVolume),
      count:n(t.count),
      filters:s.filters
    };
  }).filter(x=>x.price>0&&x.volume>1000000)
    .sort((a,b)=>b.volume-a.volume);
  state.marketCount=arr.length;
  state.universe=arr;
  return arr;
}

async function klines(symbol, interval='1m', limit=120){
  return api('/fapi/v1/klines',{symbol,interval,limit});
}

async function analyze(symbol, base){
  const k=await klines(symbol,'1m',120);
  const close=k.map(x=>+x[4]), high=k.map(x=>+x[2]), low=k.map(x=>+x[3]), vol=k.map(x=>+x[5]);
  const price=close.at(-1);
  const e9=ema(close,9), e21=ema(close,21), e50=ema(close,50);
  const r=rsi(close), a=atr(k), m=macd(close);
  const rv=vol.at(-1)/(sma(vol.slice(0,-1).slice(-20),20)||1);
  const recentHigh=Math.max(...high.slice(-20,-1));
  const recentLow=Math.min(...low.slice(-20,-1));
  const breakoutUp=price>recentHigh;
  const breakoutDown=price<recentLow;
  const volPct=a/price;
  const mom=pct(price,close.at(-11));
  const bbMid=sma(close.slice(-20),20);
  const bbSd=stdev(close.slice(-20));
  const bbZ=bbSd?(price-bbMid)/(2*bbSd):0;

  const trendUp=e9>e21&&e21>e50&&price>e21;
  const trendDown=e9<e21&&e21<e50&&price<e21;
  const trend=clamp((e9/e21-1)*120 + (e21/e50-1)*80,-1,1);
  const momScore=clamp(mom*100,-1,1);
  const rsiLong=clamp((r-50)/25,-1,1);
  const rsiShort=clamp((50-r)/25,-1,1);
  const breakoutLong=breakoutUp?1:0;
  const breakoutShort=breakoutDown?1:0;
  const meanLong=bbZ<-1.4?1:0;
  const meanShort=bbZ>1.4?1:0;
  const volScore=clamp((rv-1)*0.8,-1,1);

  return {
    symbol,price,change:base.change,volume:base.volume,
    e9,e21,e50,rsi:r,atr:a,atrPct:volPct,momentum:mom,
    relVolume:rv,macd:m,bbZ,trend,
    trendUp,trendDown,breakoutUp,breakoutDown,
    longBase: 0.26*clamp(trend,0,1)+0.20*clamp(momScore,0,1)+0.12*clamp(rsiLong,0,1)+0.12*volScore+0.15*breakoutLong+0.15*meanLong,
    shortBase:0.26*clamp(-trend,0,1)+0.20*clamp(-momScore,0,1)+0.12*clamp(rsiShort,0,1)+0.12*volScore+0.15*breakoutShort+0.15*meanShort
  };
}

async function micro(symbol){
  const [premium,oi,depth,trade]=await Promise.all([
    api('/fapi/v1/premiumIndex',{symbol}),
    api('/fapi/v1/openInterest',{symbol}),
    api('/fapi/v1/depth',{symbol,limit:20}),
    api('/futures/data/takerlongshortRatio',{symbol,period:'5m',limit:1})
  ]);
  const bids=depth.bids||[], asks=depth.asks||[];
  const bv=bids.reduce((s,x)=>s+n(x[0])*n(x[1]),0);
  const av=asks.reduce((s,x)=>s+n(x[0])*n(x[1]),0);
  const obi=(bv+av)?(bv-av)/(bv+av):0;
  const taker=trade?.[0]||{};
  const buyRatio=n(taker.buySellRatio,1);
  const flow=clamp((buyRatio-1)*2,-1,1);
  const funding=n(premium.lastFundingRate);
  return {funding,oi:n(oi.openInterest),obi,flow};
}

function scoreSide(a,m,side){
  const sign=side==='LONG'?1:-1;
  let s=side==='LONG'?a.longBase:a.shortBase;
  const details=[];
  const add=(name,v,w)=>{
    s+=v*w;
    if(Math.abs(v)>.18)details.push(`${name}:${v>0?'+':'-'}${Math.abs(v).toFixed(2)}`);
  };
  if(m){
    add('book',sign*m.obi,0.12);
    add('flow',sign*m.flow,0.12);
    add('funding',sign*(-m.funding/0.001),0.05);
  }
  if(state.btc){
    add('btc',sign*state.btc.trend,0.08);
  }
  if(side==='LONG' && a.rsi>74) s-=0.08;
  if(side==='SHORT' && a.rsi<26) s-=0.08;
  if(a.atrPct<0.0007) s-=0.05;
  if(a.relVolume<0.65) s-=0.06;
  return {score:clamp(s,0,1),details};
}

async function getBtc(){
  const b=state.universe.find(x=>x.symbol==='BTCUSDT');
  if(!b)return null;
  const a=await analyze('BTCUSDT',b);
  return {price:a.price,trend:a.trend,change:a.change};
}

function reasonForReject(c){
  if(state.positions[c.symbol]) return 'posición ya abierta';
  if((state.cooldown[c.symbol]||0)>Date.now()) return 'cooldown';
  if(sideCount(c.side)>=CFG.MAX_SAME_SIDE)return `máximo ${c.side}`;
  if(c.score<CFG.ENTRY_SCORE)return `score ${c.score.toFixed(3)} < ${CFG.ENTRY_SCORE}`;
  if(c.atrPct<0.0005)return 'volatilidad demasiado baja';
  return '';
}
function sideCount(side){return Object.values(state.positions).filter(p=>p.side===side).length;}

function chooseCandidates(rows){
  const out=[];
  for(const r of rows){
    if(!r||r.error)continue;
    const long=scoreSide(r.analysis,r.micro,'LONG');
    const short=scoreSide(r.analysis,r.micro,'SHORT');
    const side=long.score>=short.score?'LONG':'SHORT';
    const score=Math.max(long.score,short.score);
    const details=(side==='LONG'?long:short).details;
    out.push({...r.analysis,side,score,details});
  }
  return out.sort((a,b)=>b.score-a.score);
}

async function scan(){
  if(state.scanning||!state.enabled)return;
  state.scanning=true;
  const started=Date.now();
  try{
    const universe=await loadUniverse();
    state.symbols=universe.slice(0,CFG.ANALYZE_TOP).map(x=>x.symbol);
    state.btc=await getBtc().catch(()=>null);

    const analyzed=await mapLimit(universe.slice(0,CFG.ANALYZE_TOP),CFG.CONCURRENCY,
      async base=>({analysis:await analyze(base.symbol,base),base}));
    const clean=analyzed.filter(x=>x&&!x.error&&x.analysis);
    state.analyzed=clean.length;

    const preliminary=chooseCandidates(clean.map(x=>({...x,micro:null}))).slice(0,CFG.MICRO_TOP);
    const withMicro=await mapLimit(preliminary,CFG.CONCURRENCY,
      async a=>({...a,micro:await micro(a.symbol).catch(()=>({funding:0,oi:0,obi:0,flow:0}))}));
    const final=chooseCandidates(withMicro);

    state.candidates=final.slice(0,20).map(x=>({
      symbol:x.symbol,side:x.side,score:+x.score.toFixed(3),
      price:x.price,rsi:+x.rsi.toFixed(1),relVolume:+x.relVolume.toFixed(2),
      funding:x.micro?.funding||0,obi:+(x.micro?.obi||0).toFixed(3),
      flow:+(x.micro?.flow||0).toFixed(3),details:x.details
    }));

    state.rejections=state.candidates.slice(0,20).map(c=>({
      symbol:c.symbol,side:c.side,score:c.score,reason:reasonForReject(c)
    }));

    state.lastDecision='SCAN COMPLETE';
    state.lastDecisionDetail=`${universe.length} mercados · ${clean.length} analizados · top ${final[0]?.symbol||'ninguno'}`;

    let opened=0;
    if(state.enabled && Object.keys(state.positions).length<CFG.MAX_POS){
      for(const c of final){
        if(opened>=2)break; // no more than two new paper entries per scan
        const reason=reasonForReject(c);
        if(!reason){
          const ok=openPaper(c);
          if(ok)opened++;
        }
      }
    }
    state.scanNo++;
    state.lastScanAt=new Date().toISOString();
    state.lastScanMs=Date.now()-started;
    log(`SCAN #${state.scanNo}`,`${universe.length} markets / ${clean.length} analyzed / ${opened} opened / ${state.lastScanMs}ms`);
  }catch(e){
    state.lastError=e.message;
    state.lastDecision='SCAN ERROR';
    state.lastDecisionDetail=e.message;
    log('SCAN ERROR',e.message);
  }finally{
    state.scanning=false;
  }
}

function markPrice(symbol){
  return state.universe.find(x=>x.symbol===symbol)?.price || state.positions[symbol]?.entry || 0;
}

function openPaper(c){
  if(Object.keys(state.positions).length>=CFG.MAX_POS)return false;
  if(sideCount(c.side)>=CFG.MAX_SAME_SIDE)return false;
  const qty=(CFG.MARGIN*CFG.LEVERAGE)/c.price;
  const now=Date.now();
  state.positions[c.symbol]={
    symbol:c.symbol,side:c.side,qty,entry:c.price,mark:c.price,
    margin:CFG.MARGIN,leverage:CFG.LEVERAGE,openedAt:now,
    best:c.price,worst:c.price,score:c.score,reason:c.details,
    tp:c.side==='LONG'?c.price*(1+CFG.TP):c.price*(1-CFG.TP),
    sl:c.side==='LONG'?c.price*(1-CFG.SL):c.price*(1+CFG.SL),
    be:false,trailing:false
  };
  state.cash-=CFG.MARGIN;
  state.lastDecision='PAPER ENTRY';
  state.lastDecisionDetail=`${c.side} ${c.symbol} score=${c.score.toFixed(3)} ${c.details.join(' ')}`;
  log('PAPER ENTRY',`${c.side} ${c.symbol} @ ${c.price} score ${c.score.toFixed(3)}`);
  return true;
}

function pnl(p,price){
  const raw=(p.side==='LONG'?(price-p.entry):(p.entry-price))*p.qty;
  const fees=(p.entry*p.qty+price*p.qty)*CFG.FEE;
  return raw-fees;
}

function closePaper(symbol,why='MANUAL'){
  const p=state.positions[symbol]; if(!p)return false;
  const price=markPrice(symbol)||p.mark;
  const value=pnl(p,price);
  state.realized+=value;
  state.fees+=(p.entry*p.qty+price*p.qty)*CFG.FEE;
  state.cash+=p.margin+value;
  if(value>=0)state.wins++;else state.losses++;
  delete state.positions[symbol];
  state.cooldown[symbol]=Date.now()+CFG.COOLDOWN_MS;
  log('PAPER CLOSE',`${symbol} ${why} pnl=${value.toFixed(2)}`);
  return true;
}

function manage(){
  for(const [symbol,p] of Object.entries(state.positions)){
    const price=markPrice(symbol);
    if(!price)continue;
    p.mark=price;
    p.best=p.side==='LONG'?Math.max(p.best,price):Math.min(p.best,price);
    const ret=p.side==='LONG'?price/p.entry-1:p.entry/price-1;
    if(ret>=CFG.BE_TRIGGER)p.be=true;
    if(p.be){
      p.sl=p.side==='LONG'?Math.max(p.sl,p.entry*(1+0.0002)):Math.min(p.sl,p.entry*(1-0.0002));
      p.trailing=true;
      const trail=p.side==='LONG'?p.best*(1-CFG.TRAIL):p.best*(1+CFG.TRAIL);
      p.sl=p.side==='LONG'?Math.max(p.sl,trail):Math.min(p.sl,trail);
    }
    const hitTP=p.side==='LONG'?price>=p.tp:price<=p.tp;
    const hitSL=p.side==='LONG'?price<=p.sl:price>=p.sl;
    const stale=Date.now()-p.openedAt>CFG.MAX_HOLD_MS;
    if(hitTP)closePaper(symbol,'TP');
    else if(hitSL)closePaper(symbol,p.be?'TRAIL/BE':'SL');
    else if(stale)closePaper(symbol,'TIME');
  }
  state.equity=state.cash+Object.values(state.positions).reduce((s,p)=>s+p.margin+pnl(p,p.mark),0);
}

function publicState(){
  return {
    mode:CFG.LIVE?'LIVE':'PAPER',
    enabled:state.enabled,scan:state.scanNo,scanning:state.scanning,
    marketCount:state.marketCount,analyzed:state.analyzed,lastScanAt:state.lastScanAt,
    lastScanMs:state.lastScanMs,equity:+state.equity.toFixed(2),
    cash:+state.cash.toFixed(2),realized:+state.realized.toFixed(2),
    fees:+state.fees.toFixed(2),wins:state.wins,losses:state.losses,
    positions:Object.values(state.positions).map(p=>({...p,pnl:+pnl(p,p.mark).toFixed(2)})),
    candidates:state.candidates,rejections:state.rejections,
    binance:state.binance,regime:state.regime,btc:state.btc,
    lastDecision:state.lastDecision,lastDecisionDetail:state.lastDecisionDetail,
    lastError:state.lastError,logs:state.logs.slice(0,30),
    config:{...CFG,LIVE:CFG.LIVE}
  };
}

const HTML=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SOL — Multi Strategy</title>
<style>
body{margin:0;background:#080d14;color:#e9eef5;font-family:system-ui,Arial}header{padding:18px 20px;background:#0e1622;position:sticky;top:0}h1{margin:0;font-size:22px}.sub{opacity:.65;font-size:12px}.wrap{padding:16px;max-width:1200px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.card{background:#111b27;border:1px solid #233244;border-radius:12px;padding:13px}.v{font-size:22px;font-weight:700}.small{font-size:12px;opacity:.7}.ok{color:#53d18b}.bad{color:#ff7070}.btn{border:0;border-radius:9px;padding:10px 13px;background:#2d7cff;color:white;margin:3px}.btn2{background:#253345}.row{display:flex;flex-wrap:wrap;gap:6px}.scroll{max-height:300px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:7px;border-bottom:1px solid #263444;text-align:left}code{font-size:11px}</style></head>
<body><header><h1>☀ SOL — MULTI-STRATEGY ENGINE</h1><div class="sub">Binance USD-M · TODO EL MERCADO · <b id="mode">PAPER</b> · LIVE desactivado por defecto</div></header>
<div class="wrap"><div class="row"><button class="btn" onclick="start()">PRENDER</button><button class="btn btn2" onclick="stop()">PAUSAR</button><button class="btn btn2" onclick="scan()">ESCANEAR AHORA</button><button class="btn btn2" onclick="test()">PROBAR BINANCE</button><button class="btn btn2" onclick="closeAll()">CERRAR TODO</button></div>
<div class="grid" style="margin-top:10px">
<div class="card"><div class="small">ESTADO</div><div class="v" id="status">—</div></div><div class="card"><div class="small">MERCADOS</div><div class="v" id="markets">0</div></div><div class="card"><div class="small">ANALIZADOS</div><div class="v" id="analyzed">0</div></div><div class="card"><div class="small">SCAN</div><div class="v" id="scanNo">0</div></div><div class="card"><div class="small">EQUITY PAPER</div><div class="v" id="eq">$0</div></div><div class="card"><div class="small">POSICIONES</div><div class="v" id="pos">0/10</div></div><div class="card"><div class="small">BINANCE</div><div class="v" id="bin">—</div></div><div class="card"><div class="small">RESULTADO</div><div class="v" id="res">0 / 0</div></div></div>
<div class="card" style="margin-top:10px"><b>DECISIÓN DEL MOTOR</b><div id="decision" style="margin-top:8px">—</div></div>
<div class="card" style="margin-top:10px"><b>TOP SEÑALES</b><div class="scroll"><table><thead><tr><th>Símbolo</th><th>Lado</th><th>Score</th><th>RSI</th><th>RVOL</th><th>Book</th><th>Flow</th><th>Estado</th></tr></thead><tbody id="signals"></tbody></table></div></div>
<div class="card" style="margin-top:10px"><b>POSICIONES</b><div class="scroll"><table><thead><tr><th>Símbolo</th><th>Lado</th><th>Entrada</th><th>Mark</th><th>P&L</th><th></th></tr></thead><tbody id="positions"></tbody></table></div></div>
<div class="card" style="margin-top:10px"><b>LOG</b><pre id="log" class="scroll"></pre></div></div>
<script>
async function j(u,o){const r=await fetch(u,o);return r.json()}
async function act(u){await j(u,{method:'POST'});await refresh()}
function start(){act('/api/start')} function stop(){act('/api/stop')} function scan(){act('/api/scan')} function test(){act('/api/binance-check')} function closeAll(){act('/api/close-all')}
async function closeOne(s){await j('/api/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:s})});refresh()}
function money(x){return '$'+Number(x||0).toFixed(2)}
async function refresh(){try{const s=await j('/api/status');document.getElementById('mode').textContent=s.mode;document.getElementById('status').textContent=s.scanning?'SCANNING':(s.enabled?'ENCENDIDO':'PAUSADO');document.getElementById('markets').textContent=s.marketCount;document.getElementById('analyzed').textContent=s.analyzed;document.getElementById('scanNo').textContent=s.scan;document.getElementById('eq').textContent=money(s.equity);document.getElementById('pos').textContent=s.positions.length+'/'+s.config.MAX_POS;document.getElementById('bin').textContent=s.binance.ok?'OK '+s.binance.latency+'ms':'FALLA';document.getElementById('res').textContent=s.wins+' / '+s.losses;document.getElementById('decision').textContent=s.lastDecision+' — '+s.lastDecisionDetail;
document.getElementById('signals').innerHTML=s.candidates.map(c=>{const r=s.rejections.find(x=>x.symbol===c.symbol&&x.side===c.side);return '<tr><td>'+c.symbol+'</td><td>'+c.side+'</td><td>'+c.score+'</td><td>'+c.rsi+'</td><td>'+c.relVolume+'</td><td>'+c.obi+'</td><td>'+c.flow+'</td><td>'+((r&&!r.reason)?'<span class="ok">ACEPTADA</span>':'<span class="bad">'+(r?.reason||'—')+'</span>')+'</td></tr>'}).join('');
document.getElementById('positions').innerHTML=s.positions.map(p=>'<tr><td>'+p.symbol+'</td><td>'+p.side+'</td><td>'+p.entry.toFixed(6)+'</td><td>'+p.mark.toFixed(6)+'</td><td class="'+(p.pnl>=0?'ok':'bad')+'">'+money(p.pnl)+'</td><td><button class="btn btn2" onclick="closeOne(\\''+p.symbol+'\\')">CERRAR</button></td></tr>').join('');
document.getElementById('log').textContent=s.logs.join('\\n')}catch(e){}}
setInterval(refresh,3000);refresh()
</script></body></html>`;

function send(res,status,data,type='application/json'){
  res.writeHead(status,{'content-type':type,'cache-control':'no-store','access-control-allow-origin':'*'});
  res.end(type==='application/json'?JSON.stringify(data):data);
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(req.method==='GET'&&u.pathname==='/'){return send(res,200,HTML,'text/html; charset=utf-8')}
    if(req.method==='GET'&&u.pathname==='/api/status'){manage();return send(res,200,publicState())}
    if(req.method==='GET'&&u.pathname==='/api/positions'){return send(res,200,Object.values(state.positions))}
    if(req.method==='GET'&&u.pathname==='/api/signals'){return send(res,200,state.candidates)}
    if(req.method==='GET'&&u.pathname==='/api/health'){return send(res,200,{ok:true,mode:CFG.LIVE?'LIVE':'PAPER',uptime:Date.now()-state.startedAt})}
    if(req.method==='POST'&&u.pathname==='/api/start'){state.enabled=true;log('BOT START');scan();return send(res,200,{ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/stop'){state.enabled=false;log('BOT STOP');return send(res,200,{ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/scan'){scan();return send(res,200,{ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/binance-check'){return send(res,200,await binanceCheck())}
    if(req.method==='POST'&&u.pathname==='/api/close-all'){for(const s of Object.keys(state.positions))closePaper(s,'CLOSE ALL');return send(res,200,{ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/close'){
      let body='';for await(const c of req)body+=c;
      const {symbol}=JSON.parse(body||'{}');return send(res,200,{ok:closePaper(symbol,'MANUAL')})
    }
    return send(res,404,{error:'not found'})
  }catch(e){return send(res,500,{error:e.message})}
});

server.listen(CFG.PORT,()=>log('SERVER READY',`port=${CFG.PORT} mode=${CFG.LIVE?'LIVE':'PAPER'}`));

(async()=>{
  await binanceCheck();
  scan();
  setInterval(()=>scan(),CFG.POLL_MS);
  setInterval(()=>manage(),1000);
})();
