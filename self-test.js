'use strict';
const http=require('http');
const {URL}=require('url');
process.env.PORT='8799';
process.env.POLL_MS='60000';
process.env.ANALYZE_TOP='20';
process.env.CONCURRENCY='4';
process.env.PAPER_CAPITAL='10000';
process.env.LIVE_TRADING='false';

const symbols=Array.from({length:20},(_,i)=>i===0?'BTCUSDT':`TEST${String(i).padStart(2,'0')}USDT`);
const basePrices=Object.fromEntries(symbols.map((s,i)=>[s,100+i*5]));
function json(data){return {ok:true,status:200,text:async()=>JSON.stringify(data)}}
function klines(symbol,interval,limit){
  const base=basePrices[symbol]||100;
  const mult=interval==='15m'?0.0010:interval==='5m'?0.0009:0.0008;
  const out=[];
  let prev=base;
  for(let i=0;i<limit;i++){
    const close=base*(1+mult*i+0.012*Math.sin(i*0.9));
    const open=prev;
    const high=Math.max(open,close)*1.0015;
    const low=Math.min(open,close)*0.9985;
    const vol=1000000*(1+(i===limit-1?0.8:0.2));
    out.push([Date.now()-((limit-i)*60000),open,high,low,close,vol,0,0,0,0,0,0]);
    prev=close;
  }
  return out;
}

global.fetch=async (input,opts)=>{
  const u=new URL(String(input));
  const p=u.pathname;
  const s=u.searchParams.get('symbol')||'BTCUSDT';
  if(p==='/fapi/v1/time') return json({serverTime:Date.now()});
  if(p==='/fapi/v1/exchangeInfo') return json({symbols:symbols.map(symbol=>({symbol,status:'TRADING',quoteAsset:'USDT',contractType:'PERPETUAL',filters:[]}))});
  if(p==='/fapi/v1/ticker/24hr') return json(symbols.map((symbol,i)=>({symbol,lastPrice:String(basePrices[symbol]*(1+0.0008*119)),priceChangePercent:'8.5',quoteVolume:String(10000000-i*100000),count:'1000'})));
  if(p==='/fapi/v1/klines') return json(klines(s,u.searchParams.get('interval')||'1m',Number(u.searchParams.get('limit')||120)));
  if(p==='/fapi/v1/premiumIndex') return json({lastFundingRate:'0.00005'});
  if(p==='/fapi/v1/openInterest') return json({openInterest:'100000'});
  if(p==='/fapi/v1/depth'){
    const price=basePrices[s]||100;
    return json({bids:[[String(price), '100']],asks:[[String(price*1.00002),'60']]});
  }
  if(p==='/futures/data/takerlongshortRatio') return json([{buySellRatio:'1.15'}]);
  return {ok:false,status:404,text:async()=>JSON.stringify({code:-404,msg:'not mocked'})};
};

require('./server.js');

function req(path,method='GET',body=''){
  return new Promise((resolve,reject)=>{
    const r=http.request({hostname:'127.0.0.1',port:8799,path,method,headers:body?{'content-type':'application/json'}:{}},res=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve(d)}});
    });
    r.on('error',reject); if(body)r.write(body);r.end();
  });
}
(async()=>{
  await new Promise(r=>setTimeout(r,1200));
  const h=await req('/api/health');
  const s=await req('/api/status');
  const checks={
    healthOk:h.ok===true,
    paper:s.mode==='PAPER',
    markets:s.marketCount===20,
    analyzed:s.analyzed===20,
    scanned:s.scan>=1,
    meshDone:s.mesh?.SCAN?.status==='DONE' && s.mesh?.VET?.status==='DONE',
    positionsOpened:s.positions.length>0,
    equityPositive:s.equity>0,
    liveOff:s.config?.LIVE===false,
    individualCloseRoute:!!s.positions[0]
  };
  console.log('SELF-TEST',JSON.stringify(checks,null,2));
  console.log('STATUS',JSON.stringify({scan:s.scan,markets:s.marketCount,analyzed:s.analyzed,positions:s.positions.length,equity:s.equity,decision:s.lastDecision,detail:s.lastDecisionDetail,mesh:s.mesh},null,2));
  if(s.positions[0]){
    const c=await req('/api/close','POST',JSON.stringify({symbol:s.positions[0].symbol}));
    console.log('CLOSE_ONE',JSON.stringify(c));
  }
  const failed=Object.entries(checks).filter(([,v])=>!v);
  process.exitCode=failed.length?1:0;
  setTimeout(()=>process.exit(),200);
})();
