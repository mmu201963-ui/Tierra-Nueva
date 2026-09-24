/* TIERRA MASTER — PAPER FIRST / LIVE-READY
   Based on the verified TIERRA_LIVE.js source.
   LIVE_TRADING defaults to false.
   Multi-factor analysis: trend, momentum, RSI, ATR, volume, LONG/SHORT,
   dynamic market universe, SL/TP, break-even, trailing, recovery,
   Binance signed execution and protection orders.
*/
import express from 'express';
import crypto from 'crypto';

const app=express();
app.use(express.json());

const ENV=(k,d='')=>process.env[k]??d;
const BOOL=(k,d=false)=>String(process.env[k]??d).toLowerCase()==='true';
const NUM=(k,d)=>Number.isFinite(Number(process.env[k]))?Number(process.env[k]):d;

const KEY=ENV('BINANCE_API_KEY');
const SECRET=ENV('BINANCE_API_SECRET');
const LIVE=BOOL('LIVE_TRADING',false);

const FUT_HOSTS=['https://fapi.binance.com','https://fapi1.binance.com','https://fapi2.binance.com','https://fapi3.binance.com'];
const MAX_POS=NUM('MAX_FUTURES',10);
const LEV=Math.max(1,Math.min(5,NUM('FUTURES_LEVERAGE',3)));
const TP=Math.max(0.003,Math.min(0.03,NUM('TAKE_PROFIT_PCT',0.006)));
const SL=Math.max(0.0025,Math.min(0.02,NUM('STOP_AT_LOSS_PCT',0.004)));
const TRAIL=Math.max(0.0015,Math.min(0.015,NUM('TRAILING_PCT',0.0025)));
const MIN_SCORE=Math.max(0.45,Math.min(0.90,NUM('MIN_SIGNAL_SCORE',0.55)));
const MARGIN=NUM('MARGIN_PER_TRADE',5);
const POLL=Math.max(10,NUM('POLL_SECONDS',15))*1000;
const MAX_LONG=Math.min(6,MAX_POS);
const MAX_SHORT=Math.min(6,MAX_POS);
const MAX_DAILY_LOSS=Math.max(5,MARGIN*MAX_POS*SL*LEV*4);

const S={
  running:false,live:LIVE,equity:0,available:0,realized:0,unrealized:0,
  positions:[],signals:[],history:[],regime:'UNKNOWN',lastCycle:null,
  lastError:null,warning:LIVE?'LIVE TRADING ENABLED':'PAPER MODE'
};

let busy=false,hostIndex=0,mode='BOTH';

function sign(q){return crypto.createHmac('sha256',SECRET).update(q).digest('hex')}
function qs(obj){return new URLSearchParams(obj).toString()}
async function publicGet(path){
  let last;
  for(let i=0;i<FUT_HOSTS.length;i++){
    const h=FUT_HOSTS[(hostIndex+i)%FUT_HOSTS.length];
    try{
      const r=await fetch(h+path,{headers:{'User-Agent':'TIERRA/MASTER'});
      const text=await r.text();
      if(!r.ok)throw new Error(`${r.status}: ${text}`);
      hostIndex=(hostIndex+i)%FUT_HOSTS.length;
      return JSON.parse(text);
    }catch(e){last=e}
  }
  throw last||new Error('Binance sin respuesta');
}
async function signed(method,path,params={}){
  if(!KEY||!SECRET)throw new Error('Faltan BINANCE_API_KEY/BINANCE_API_SECRET');
  const p={...params,timestamp:Date.now(),recvWindow:5000};
  const q=qs(p);
  const url=FUT_HOSTS[hostIndex]+path+'?'+q+'&signature='+sign(q);
  const r=await fetch(url,{method,headers:{'X-MBX-APIKEY':KEY,'User-Agent':'TIERRA/MASTER'}});
  const text=await r.text();
  if(!r.ok)throw new Error(`${r.status}: ${text}`);
  return JSON.parse(text);
}
function pctMove(a,b){return a?((b/a)-1):0}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function ema(values,n){
  if(!values.length)return 0;
  const k=2/(n+1);let e=values[0];
  for(let i=1;i<values.length;i++)e=values[i]*k+e*(1-k);
  return e;
}
function rsi(values,n=14){
  if(values.length<n+1)return 50;
  let g=0,l=0;
  for(let i=1;i<=n;i++){
    const d=values[i]-values[i-1];
    if(d>=0)g+=d;else l-=d;
  }
  let ag=g/n,al=l/n;
  for(let i=n+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    ag=((ag*(n-1))+Math.max(d,0))/n;
    al=((al*(n-1))+Math.max(-d,0))/n;
  }
  if(al===0)return 100;
  return 100-(100/(1+ag/al));
}
function atr(arr,n=14){
  if(arr.length<n+1)return 0;
  const tr=[];
  for(let i=1;i<arr.length;i++){
    const h=Number(arr[i][2]),l=Number(arr[i][3]),pc=Number(arr[i-1][4]);
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return avg(tr.slice(-n));
}
function regimeFrom(score){return score>0.18?'BULL':score<-0.18?'BEAR':'RANGE'}
async function klines(symbol,interval='5m',limit=120){return publicGet(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)}
async function ticker(symbol){return publicGet(`/fapi/v1/ticker/price?symbol=${symbol}`)}
async function exchangeInfo(){return publicGet('/fapi/v1/exchangeInfo')}
async function ticker24h(){return publicGet('/fapi/v1/ticker/24hr')}

function feature(symbol,arr,liq=0){
  const closes=arr.map(x=>Number(x[4])),vols=arr.map(x=>Number(x[5]));
  const price=closes.at(-1);
  const e9=ema(closes.slice(-60),9),e21=ema(closes.slice(-60),21),e50=ema(closes.slice(-80),50);
  const rsi14=rsi(closes,14),a=atr(arr,14),atrPct=price?a/price:0;
  const r5=pctMove(closes.at(-2),price),r15=pctMove(closes.at(-4),price);
  const r30=pctMove(closes.at(-7),price),r60=pctMove(closes.at(-13),price);
  const vAvg=avg(vols.slice(-21,-1)),vr=vols.at(-1)/Math.max(vAvg,1e-9);
  const trend=clamp(((e9/e21)-1)*180+((e21/e50)-1)*120,-1,1);
  const mom=clamp(r5*18+r15*8+r30*5+r60*3,-1,1);
  const vol=clamp((vr-1)*0.18,-0.35,0.35);
  const longScore=clamp(
    0.34*trend+0.27*mom+0.18*clamp((rsi14-50)/25,-1,1)+
    0.11*vol+0.10*clamp(liq/1e7,0,1),-1,1);
  const shortScore=clamp(
    -0.34*trend-0.27*mom+0.18*clamp((50-rsi14)/25,-1,1)+
    0.11*vol+0.10*clamp(liq/1e7,0,1),-1,1);
  const side=longScore>=MIN_SCORE&&longScore>shortScore?'LONG':
    shortScore>=MIN_SCORE&&shortScore>longScore?'SHORT':'WAIT';
  return {symbol,price,r5,r15,r30,r60,volumeRatio:vr,atr:a,atrPct,rsi:rsi14,
    ema9:e9,ema21:e21,ema50:e50,trend,momentum:mom,longScore,shortScore,
    score:Math.max(longScore,shortScore),side,quoteVolume:liq};
}

async function mapLimit(items,limit,fn){
  const out=[];let i=0;
  async function worker(){
    while(true){
      const n=i++;if(n>=items.length)return;
      try{const v=await fn(items[n]);if(v)out.push(v)}catch{}
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));
  return out;
}

async function topSignals(){
  const [info,t24]=await Promise.all([exchangeInfo(),ticker24h()]);
  const liquid=new Map(t24.filter(x=>x.symbol.endsWith('USDT'))
    .map(x=>[x.symbol,Number(x.quoteVolume||0)]));
  const syms=info.symbols
    .filter(x=>x.status==='TRADING'&&x.quoteAsset==='USDT'&&x.contractType==='PERPETUAL')
    .filter(x=>(liquid.get(x.symbol)||0)>=1000000)
    .sort((a,b)=>(liquid.get(b.symbol)||0)-(liquid.get(a.symbol)||0))
    .slice(0,120);
  const out=await mapLimit(syms,8,async x=>
    feature(x.symbol,await klines(x.symbol,'5m',120),liquid.get(x.symbol)||0));
  return out.sort((a,b)=>b.score-a.score).slice(0,30);
}

async function account(){return signed('GET','/fapi/v2/account')}
async function positionsRemote(){return signed('GET','/fapi/v2/positionRisk')}
async function dual(){
  try{
    const d=await signed('GET','/fapi/v1/positionSide/dual');
    mode=d.dualSidePosition?'HEDGE':'BOTH';return mode;
  }catch{return mode}
}
function qDown(q,step){return Math.floor(q/step)*step}
function decimals(step){
  const s=String(step);
  if(s.includes('e-'))return Number(s.split('e-')[1]);
  return (s.split('.')[1]||'').length;
}
function fmtQty(q,step){return qDown(q,step).toFixed(decimals(step))}
async function symbolRules(symbol){
  const info=await exchangeInfo();
  const s=info.symbols.find(x=>x.symbol===symbol);
  if(!s)throw new Error('Símbolo no encontrado '+symbol);
  const lot=s.filters.find(f=>f.filterType==='LOT_SIZE');
  const not=s.filters.find(f=>f.filterType==='MIN_NOTIONAL'||f.filterType==='NOTIONAL');
  return {step:Number(lot?.stepSize||1),minQty:Number(lot?.minQty||0),
    minNotional:Number(not?.notional||not?.minNotional||0)};
}
async function setLeverage(symbol){
  return signed('POST','/fapi/v1/leverage',{symbol,leverage:LEV});
}
async function order(symbol,side,quantity,reduceOnly=false){
  const p={symbol,side,type:'MARKET',quantity};
  if(mode==='BOTH'&&reduceOnly)p.reduceOnly='true';
  if(mode==='HEDGE')p.positionSide=side==='BUY'?'LONG':'SHORT';
  return signed('POST','/fapi/v1/order',p);
}
async function open(symbol,side,price,signal){
  if(S.positions.length>=MAX_POS||S.positions.some(p=>p.symbol===symbol))return null;
  const a=await account();
  const available=Number(a.availableBalance||0);
  const margin=Math.min(MARGIN,available*0.05);
  const rules=await symbolRules(symbol);
  const qty=fmtQty(margin*LEV/price,rules.step);
  if(Number(qty)<rules.minQty||Number(qty)*price<rules.minNotional)
    throw new Error(`${symbol}: tamaño mínimo Binance supera el margen configurado`);
  await setLeverage(symbol);

  if(!LIVE){
    const p={symbol,side,entry:price,current:price,qty:Number(qty),margin,
      sl:side==='LONG'?price*(1-SL):price*(1+SL),
      tp:side==='LONG'?price*(1+TP):price*(1-TP),opened:Date.now(),
      high:price,low:price,pnl:0,paper:true,score:signal.score};
    S.positions.push(p);return p;
  }

  const resp=await order(symbol,side==='LONG'?'BUY':'SELL',qty,false);
  const fill=Number(resp.avgPrice||price);
  const p={symbol,side,entry:fill,current:fill,qty:Number(qty),margin,
    sl:side==='LONG'?fill*(1-SL):fill*(1+SL),
    tp:side==='LONG'?fill*(1+TP):fill*(1-TP),opened:Date.now(),
    high:fill,low:fill,pnl:0,orderId:resp.orderId,score:signal.score};
  S.positions.push(p);
  p._protectedSL=p.sl;p._protectedTP=p.tp;
  await protect(p);
  return p;
}
async function cancelBotProtection(symbol){
  try{
    const o=await signed('GET','/fapi/v1/openOrders',{symbol});
    for(const x of o){
      const cid=String(x.clientOrderId||'');
      if(cid.startsWith('TIERRA_'))
        await signed('DELETE','/fapi/v1/order',{symbol,orderId:x.orderId});
    }
  }catch(e){S.lastError=e.message}
}
async function protect(p){
  if(!LIVE)return;
  await cancelBotProtection(p.symbol);
  const closeSide=p.side==='LONG'?'SELL':'BUY';
  const ps=mode==='HEDGE'?{positionSide:p.side}:{reduceOnly:'true'};
  const tag=`TIERRA_${p.symbol}_${p.orderId||Date.now()}`;
  await signed('POST','/fapi/v1/order',{
    symbol:p.symbol,side:closeSide,type:'STOP_MARKET',stopPrice:p.sl,
    closePosition:'true',newClientOrderId:(tag+'_SL').slice(0,36),...ps});
  await signed('POST','/fapi/v1/order',{
    symbol:p.symbol,side:closeSide,type:'TAKE_PROFIT_MARKET',stopPrice:p.tp,
    closePosition:'true',newClientOrderId:(tag+'_TP').slice(0,36),...ps});
}
async function close(p,reason){
  if(LIVE){
    await cancelBotProtection(p.symbol);
    const side=p.side==='LONG'?'SELL':'BUY';
    await order(p.symbol,side,p.qty,mode!=='HEDGE');
  }
  S.realized+=Number(p.pnl||0);
  S.history.unshift({time:new Date().toISOString(),symbol:p.symbol,side:p.side,
    pnl:p.pnl||0,reason});
  S.history=S.history.slice(0,200);
  S.positions=S.positions.filter(x=>x!==p);
}
async function manage(){
  for(const p of [...S.positions]){
    try{
      const t=await ticker(p.symbol);p.current=Number(t.price);
      p.pnl=p.side==='LONG'?(p.current-p.entry)*p.qty:(p.entry-p.current)*p.qty;
      p.high=Math.max(p.high,p.current);p.low=Math.min(p.low,p.current);
      const profitPct=p.side==='LONG'?(p.current/p.entry-1):(p.entry/p.current-1);
      const halfTP=TP*0.5;
      if(profitPct>=halfTP){
        if(p.side==='LONG')p.sl=Math.max(p.sl,p.entry*1.0005);
        else p.sl=Math.min(p.sl,p.entry*0.9995);
      }
      const trail=p.side==='LONG'&&p.high>=p.entry*(1+halfTP)&&p.current<=p.high*(1-TRAIL) ||
        p.side==='SHORT'&&p.low<=p.entry*(1-halfTP)&&p.current>=p.low*(1+TRAIL);
      const sl=p.side==='LONG'?p.current<=p.sl:p.current>=p.sl;
      const tp=p.side==='LONG'?p.current>=p.tp:p.current<=p.tp;
      const stale=Date.now()-p.opened>30*60*1000&&profitPct<halfTP&&
        Math.abs(p.pnl)<Math.max(0.05,p.margin*0.01);
      if(sl||tp||trail||stale)await close(p,tp?'TP':sl?'SL':trail?'TRAIL':'STALE');
      else if(LIVE&&(p.sl!==p._protectedSL||p.tp!==p._protectedTP)){
        p._protectedSL=p.sl;p._protectedTP=p.tp;await protect(p);
      }
    }catch(e){S.lastError=e.message}
  }
}
async function cycle(){
  if(busy||!S.running)return;busy=true;
  try{
    await dual();
    if(LIVE){
      const a=await account();
      S.equity=Number(a.totalWalletBalance||0);
      S.available=Number(a.availableBalance||0);
    }
    await manage();
    const sig=await topSignals();S.signals=sig;
    const lead=sig[0];
    S.regime=regimeFrom(lead?lead.longScore-lead.shortScore:0);

    const dayPnl=S.history.filter(x=>Date.now()-new Date(x.time).getTime()<86400000)
      .reduce((a,x)=>a+Number(x.pnl||0),0);
    if(dayPnl<=-MAX_DAILY_LOSS){
      S.lastError=`Límite diario alcanzado: ${dayPnl.toFixed(4)} USDT`;
      S.unrealized=S.positions.reduce((a,p)=>a+(p.pnl||0),0);
      S.lastCycle=new Date().toISOString();return;
    }

    const candidates=sig.filter(x=>x.side!=='WAIT'&&Math.max(x.longScore,x.shortScore)>=MIN_SCORE);
    for(const x of candidates){
      if(S.positions.length>=MAX_POS)break;
      if(S.positions.some(p=>p.symbol===x.symbol))continue;
      if(x.side==='LONG'&&S.positions.filter(p=>p.side==='LONG').length>=MAX_LONG)continue;
      if(x.side==='SHORT'&&S.positions.filter(p=>p.side==='SHORT').length>=MAX_SHORT)continue;
      try{await open(x.symbol,x.side,x.price,x)}catch(e){S.lastError=e.message}
    }
    S.unrealized=S.positions.reduce((a,p)=>a+(p.pnl||0),0);
    S.lastCycle=new Date().toISOString();
  }catch(e){S.lastError=e.message}
  finally{busy=false}
}
async function sync(){
  if(!LIVE)return;
  try{
    const a=await account();
    S.equity=Number(a.totalWalletBalance||0);
    S.available=Number(a.availableBalance||0);
    const pr=await positionsRemote();
    for(const r of pr){
      const amt=Number(r.positionAmt);if(!amt)continue;
      const symbol=r.symbol;
      const side=mode==='HEDGE'?r.positionSide:(amt>0?'LONG':'SHORT');
      let existing=S.positions.find(p=>p.symbol===symbol&&p.side===side);
      if(!existing){
        existing={symbol,side,entry:Number(r.entryPrice),current:Number(r.markPrice),
          qty:Math.abs(amt),margin:Math.abs(Number(r.positionInitialMargin||0)),
          sl:side==='LONG'?Number(r.entryPrice)*(1-SL):Number(r.entryPrice)*(1+SL),
          tp:side==='LONG'?Number(r.entryPrice)*(1+TP):Number(r.entryPrice)*(1-TP),
          opened:Date.now(),high:Number(r.markPrice),low:Number(r.markPrice),
          pnl:Number(r.unRealizedProfit||0),recovered:true};
        S.positions.push(existing);
      }
      existing.current=Number(r.markPrice);
      existing.pnl=Number(r.unRealizedProfit||0);
      existing.high=Math.max(existing.high,existing.current);
      existing.low=Math.min(existing.low,existing.current);
      await protect(existing);
    }
  }catch(e){S.lastError=e.message}
}
function summary(){
  const h=S.history,wins=h.filter(x=>x.pnl>0),loss=h.filter(x=>x.pnl<0);
  return {generatedAt:new Date().toISOString(),regime:S.regime,
    openPositions:S.positions.length,realized:S.realized,unrealized:S.unrealized,
    trades:h.length,wins:wins.length,losses:loss.length,
    winRate:h.length?wins.length/h.length:0,
    avgWin:wins.length?wins.reduce((a,x)=>a+x.pnl,0)/wins.length:0,
    avgLoss:loss.length?loss.reduce((a,x)=>a+x.pnl,0)/loss.length:0,
    topSignals:S.signals.slice(0,10)};
}

app.get('/api/health',(req,res)=>res.json({ok:true,live:LIVE,running:S.running,lastError:S.lastError,warning:S.warning}));
app.get('/api/status',(req,res)=>res.json({...S,summary:summary()}));
app.get('/api/positions',(req,res)=>res.json(S.positions));
app.get('/api/signals',(req,res)=>res.json(S.signals));
app.get('/api/ai-summary',(req,res)=>res.json(summary()));
app.get('/api/binance-check',async(req,res)=>{
  try{
    const pub=await publicGet('/ping');let priv=null;
    if(KEY&&SECRET){
      const a=await account();
      priv={canTrade:a.canTrade,availableBalance:Number(a.availableBalance||0),
        totalWalletBalance:Number(a.totalWalletBalance||0),mode:await dual()};
    }
    res.json({ok:true,public:pub,private:priv,live:LIVE,host:FUT_HOSTS[hostIndex],
      maxPositions:MAX_POS,leverage:LEV});
  }catch(e){
    S.lastError=e.message;res.status(502).json({ok:false,error:e.message,live:LIVE});
  }
});
app.post('/api/start',(req,res)=>{S.running=true;res.json({ok:true,running:true,live:LIVE})});
app.post('/api/stop',(req,res)=>{S.running=false;res.json({ok:true,running:false})});
app.post('/api/close',async(req,res)=>{
  try{for(const p of [...S.positions])await close(p,'MANUAL');res.json({ok:true})}
  catch(e){S.lastError=e.message;res.status(500).json({ok:false,error:e.message})}
});

const port=Number(process.env.PORT||8080);
app.listen(port,()=>console.log(`TIERRA MASTER listening on ${port} | LIVE=${LIVE}`));
setInterval(()=>{sync();cycle()},POLL);
