import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"GET, OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
const assets:Record<string,{id:string;binance:string;coinbase:string;kraken:string;label:string}>={
 BTC:{id:"bitcoin",binance:"BTCUSDT",coinbase:"BTC-USD",kraken:"XBTUSD",label:"BTC"},
 ETH:{id:"ethereum",binance:"ETHUSDT",coinbase:"ETH-USD",kraken:"ETHUSD",label:"ETH"},
 SOL:{id:"solana",binance:"SOLUSDT",coinbase:"SOL-USD",kraken:"SOLUSD",label:"SOL"},
 BNB:{id:"binancecoin",binance:"BNBUSDT",coinbase:"",kraken:"BNBUSD",label:"BNB"},
 XRP:{id:"ripple",binance:"XRPUSDT",coinbase:"XRP-USD",kraken:"XRPUSD",label:"XRP"},
 ADA:{id:"cardano",binance:"ADAUSDT",coinbase:"ADA-USD",kraken:"ADAUSD",label:"ADA"},
 TRX:{id:"tron",binance:"TRXUSDT",coinbase:"TRX-USD",kraken:"TRXUSD",label:"TRX"},
 DOGE:{id:"dogecoin",binance:"DOGEUSDT",coinbase:"DOGE-USD",kraken:"DOGEUSD",label:"DOGE"}
};
async function getJson(url:string,ms=8000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{"Accept":"application/json","User-Agent":"ZentraChain-Market/1.0"}});if(!r.ok)throw new Error("Upstream HTTP "+r.status);return await r.json()}finally{clearTimeout(t)}}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="GET")return reply({error:"Method not allowed"},405);
 const u=new URL(req.url),action=u.searchParams.get("action")||"prices";
 try{
  if(action==="prices"){
   const ids=Object.values(assets).map(x=>x.id).join(",");
   try{
    const d=await getJson("https://api.coingecko.com/api/v3/simple/price?ids="+ids+"&vs_currencies=usd&include_24hr_change=true");
    const out:Record<string,{usd:number;usd_24h_change:number}>={};
    for(const [sym,a] of Object.entries(assets)){const x=d[a.id];if(x&&Number.isFinite(Number(x.usd)))out[a.id]={usd:Number(x.usd),usd_24h_change:Number(x.usd_24h_change||0)}}
    if(Object.keys(out).length>=7)return reply({provider:"CoinGecko",prices:out,updated_at:new Date().toISOString()});
   }catch(e){console.warn("CoinGecko prices unavailable",String(e))}
   const rows=await Promise.all(Object.entries(assets).map(async([sym,a])=>{try{const x=await getJson("https://api.binance.com/api/v3/ticker/24hr?symbol="+a.binance);return [a.id,{usd:Number(x.lastPrice),usd_24h_change:Number(x.priceChangePercent)}] as const}catch{return [a.id,null] as const}}));
   const out=Object.fromEntries(rows.filter(x=>x[1]&&Number.isFinite(x[1]!.usd)));
   if(Object.keys(out).length<4)return reply({error:"Market providers are temporarily unavailable"},503);
   return reply({provider:"Binance",prices:out,updated_at:new Date().toISOString()});
  }
  if(action==="candles"){
   const sym=(u.searchParams.get("asset")||"BTC").toUpperCase(),a=assets[sym];if(!a)return reply({error:"Unsupported asset"},400);
   try{
    const rows=await getJson("https://api.binance.com/api/v3/klines?symbol="+a.binance+"&interval=15m&limit=72");
    if(Array.isArray(rows)&&rows.length>2){const candles=rows.map((x:any)=>[Number(x[0]),Number(x[4])]).filter((x:number[])=>Number.isFinite(x[1])&&x[1]>0);return reply({asset:sym,provider:"Binance",candles,updated_at:new Date().toISOString()})}
   }catch(e){console.warn("Binance candles unavailable",sym,String(e))}
   if(a.coinbase){
    try{const rows=await getJson("https://api.exchange.coinbase.com/products/"+a.coinbase+"/candles?granularity=900");if(Array.isArray(rows)&&rows.length>2){const candles=rows.slice().sort((x:any,y:any)=>x[0]-y[0]).map((x:any)=>[Number(x[0])*1000,Number(x[4])]);return reply({asset:sym,provider:"Coinbase",candles,updated_at:new Date().toISOString()})}}catch(e){console.warn("Coinbase candles unavailable",sym,String(e))}
   }
   try{const d=await getJson("https://api.coingecko.com/api/v3/coins/"+a.id+"/market_chart?vs_currency=usd&days=1");const candles=(d.prices||[]).map((x:any)=>[Number(x[0]),Number(x[1])]).filter((x:number[])=>Number.isFinite(x[1])&&x[1]>0);if(candles.length>2)return reply({asset:sym,provider:"CoinGecko",candles,updated_at:new Date().toISOString()})}catch(e){console.warn("CoinGecko chart unavailable",sym,String(e))}
   return reply({error:"No public candle feed is currently available"},503);
  }
  return reply({error:"Unknown action"},400);
 }catch(e){console.error("Market service error",String(e));return reply({error:"Market service temporarily unavailable"},503)}
});