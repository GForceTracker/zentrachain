import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ethers } from "npm:ethers@6.13.5";
import { Connection, PublicKey, SystemProgram, Transaction } from "npm:@solana/web3.js@1.95.3";

const EVM_RPC: Record<string,string> = {
  ERC20:"https://ethereum-rpc.publicnode.com",
  ETHEREUM:"https://ethereum-rpc.publicnode.com",
  BEP20:"https://bsc-rpc.publicnode.com",
};
const USDT_ADDR: Record<string,string> = {
  ERC20:"0xdAC17F958D2ee523a2206206994597C13D831ec7",
  BEP20:"0x55d398326f99059fF775485246999027B3197955",
};
const TRON_USDT="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const BTC_API="https://mempool.space/api";
const DOGE_API="https://dogechain.com/api/v3";
const DOGE_BLOCKBOOK="https://blockbook.doge.zelcore.io";
const SOLANA_RPC="https://solana-rpc.publicnode.com";
const COINGECKO:Record<string,string>={BTC:"bitcoin",ETH:"ethereum",TRX:"tron",DOGE:"dogecoin",SOL:"solana",BNB:"binancecoin"};
const KRAKEN:Record<string,string>={BTC:"XBTUSD",ETH:"ETHUSD",TRX:"TRXUSD",DOGE:"XDGUSD",SOL:"SOLUSD",BNB:"BNBUSD"};

function response(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"}})}
async function getJson(url:string,init?:RequestInit):Promise<any>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  try{const r=await fetch(url,{...init,signal:controller.signal});const raw=await r.text();let d:any={};try{d=raw?JSON.parse(raw):{}}catch{d={raw}}if(!r.ok)throw new Error(String(d?.error?.message||d?.error||d?.message||raw||("HTTP "+r.status)));return d}
  finally{clearTimeout(timer)}
}
async function price(asset:string):Promise<number>{
  const a=asset.toUpperCase();if(a==="USDT")return 1;const id=COINGECKO[a];if(!id)throw new Error("No USD quote for "+a);
  try{const d=await getJson("https://api.coingecko.com/api/v3/simple/price?ids="+id+"&vs_currencies=usd");const p=Number(d?.[id]?.usd||0);if(p>0&&Number.isFinite(p))return p}catch{}
  try{const d=await getJson("https://api.coinbase.com/v2/exchange-rates?currency="+a);const p=Number(d?.data?.rates?.USD||0);if(p>0&&Number.isFinite(p))return p}catch{}
  try{const d=await getJson("https://api.kraken.com/0/public/Ticker?pair="+KRAKEN[a]);const p=Number(Object.values(d?.result||{})[0]?.c?.[0]||0);if(!d?.error?.length&&p>0&&Number.isFinite(p))return p}catch{}
  throw new Error("Live USD price for "+a+" is unavailable");
}
function unitsFromUsd(usd:number,p:number,decimals:number):bigint{
  const n=usd/p;if(!Number.isFinite(n)||n<=0)throw new Error("Unable to calculate coin amount");
  const u=ethers.parseUnits(n.toFixed(decimals),decimals);if(u<=0n)throw new Error("Amount is too small to transfer");return u;
}
function feeData(feeNative:number,unit:string,feeUsd:number,extra:Record<string,unknown>={}){
  return {ok:true,native:feeNative, native_unit:unit, usd:feeUsd, ...extra};
}
function base58Decode(value:string):Uint8Array{
  const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=0n;
  for(const ch of value){const digit=alphabet.indexOf(ch);if(digit<0)throw new Error("Invalid TRON address");n=n*58n+BigInt(digit)}
  let body:number[]=[];while(n>0n){body.unshift(Number(n&255n));n>>=8n}let zeros=0;while(zeros<value.length&&value[zeros]==="1")zeros++;
  return new Uint8Array([...new Array(zeros).fill(0),...body]);
}
function tronHex(address:string):string{
  const bytes=base58Decode(address);if(bytes.length!==25)throw new Error("Invalid TRON address");
  const payload=bytes.slice(0,21),first=ethers.getBytes(ethers.sha256(payload)),sum=ethers.getBytes(ethers.sha256(first)).slice(0,4);
  for(let i=0;i<4;i++)if(bytes[21+i]!==sum[i])throw new Error("Invalid TRON address checksum");
  if(payload[0]!==0x41)throw new Error("Invalid TRON address prefix");
  return Array.from(payload.slice(1),x=>x.toString(16).padStart(2,"0")).join("");
}
async function tronUsdtBalance(address:string):Promise<number>{
  const parameter=tronHex(address).padStart(64,"0");
  const d=await getJson("https://api.trongrid.io/wallet/triggerconstantcontract",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({owner_address:address,contract_address:TRON_USDT,function_selector:"balanceOf(address)",parameter,visible:true}),
  });
  const hex=String(d?.constant_result?.[0]||"0");
  const units=BigInt("0x"+(hex||"0"));
  return Number(ethers.formatUnits(units,6));
}
async function tronState(address:string){
  const [a,r,p]=await Promise.all([
    getJson("https://api.trongrid.io/wallet/getaccount",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({address,visible:true})}),
    getJson("https://api.trongrid.io/wallet/getaccountresource",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({address,visible:true})}),
    getJson("https://api.trongrid.io/wallet/getchainparameters"),
  ]);
  const params=p?.chainParameter||[];
  return {
    trx:Number(a?.balance||0)/1e6,
    freeNet:Number(r?.freeNetLimit||600),
    freeUsed:Number(r?.freeNetUsed||0),
    energyFee:Number(params.find((x:any)=>x.key==="getEnergyFee")?.value||420),
    txFeeSun:Number(params.find((x:any)=>x.key==="getTransactionFee")?.value||1000),
  };
}
function tronFee(state:any,rawDataHex:string,energy:number){
  const bytes=Math.ceil(rawDataHex.length/2)+67,free=Math.max(0,state.freeNet-state.freeUsed);
  return Math.max(0,energy*state.energyFee+Math.max(0,bytes-free)*state.txFeeSun)/1e6;
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return response({ok:true});
  if(req.method!=="POST")return response({error:"Method not allowed"},405);
  try{
    const b=await req.json().catch(()=>({}));
    const asset=String(b?.asset||"").toUpperCase(),network=String(b?.network||"").toUpperCase();
    const from=String(b?.from_address||"").trim(),to=String(b?.to_address||"").trim()||from;
    const amountUsd=Number(b?.amount_usd??b?.amount_coin??0);
    const valid=(
      (asset==="USDT"&&["TRC20","ERC20","BEP20"].includes(network))||
      (asset==="BTC"&&network==="BITCOIN")||
      (asset==="ETH"&&network==="ETHEREUM")||
      (asset==="TRX"&&network==="TRON")||
      (asset==="DOGE"&&network==="DOGECOIN")||
      (asset==="SOL"&&network==="SOLANA")
    );
    if(!valid)return response({error:"This asset and network are not enabled for automatic treasury withdrawals"},400);
    if(!Number.isFinite(amountUsd)||amountUsd<0)return response({error:"Enter a valid USD amount"},400);
    const decimals=network==="BEP20"?18:(asset==="USDT"?6:(asset==="BTC"||asset==="DOGE"?8:asset==="SOL"?9:asset==="TRX"?6:18));
    const p=await price(asset);
    const units=amountUsd>0?unitsFromUsd(amountUsd,p,decimals):0n;
    const coin=amountUsd>0?Number(ethers.formatUnits(units,decimals)):0;
    let native=0,unit="",extra:Record<string,unknown>={network,asset,price_usd:p,crypto_amount:coin,detail:"Estimated live network fee; final fee and available balance are rechecked immediately before broadcast."};

    if(["ERC20","BEP20","ETHEREUM"].includes(network)){
      const provider=new ethers.JsonRpcProvider(EVM_RPC[network]);
      const chain=await provider.getNetwork();
      const expectedChainId=network==="BEP20"?56n:1n;
      if(chain.chainId!==expectedChainId)throw new Error("The RPC endpoint is connected to the wrong blockchain network");
      const fd=await provider.getFeeData(),gasPrice=[fd.gasPrice,fd.maxFeePerGas].find((x:any)=>x!=null&&x>0n);
      if(!gasPrice||gasPrice<=0n)throw new Error("The EVM network fee service returned no usable gas price");
      let gas=21000n;
      const sender=from&&/^0x[a-fA-F0-9]{40}$/.test(from)?from:"0x0000000000000000000000000000000000000001";
      const recipient=to&&/^0x[a-fA-F0-9]{40}$/.test(to)?to:sender;
      if(asset==="USDT"){
        const contract=new ethers.Contract(USDT_ADDR[network],["function transfer(address,uint256) returns (bool)","function balanceOf(address) view returns(uint256)"],provider);
        const tokenBalance:bigint=from&&/^0x[a-fA-F0-9]{40}$/.test(from)?await contract.balanceOf(from):0n;
        if(from&&/^0x[a-fA-F0-9]{40}$/.test(from)){
          extra.wallet_asset_balance=Number(ethers.formatUnits(tokenBalance,decimals));
          extra.wallet_usdt_balance=extra.wallet_asset_balance;
        }
        const estimateUnits=tokenBalance>0n&&tokenBalance<units?tokenBalance:units;
        gas=await contract.transfer.estimateGas(recipient,estimateUnits,{from:sender});
      }else{
        gas=await provider.estimateGas({from:sender,to:recipient,value:units||1n});
      }
      gas=(gas*115n+99n)/100n;
      native=Number(gas*gasPrice)/1e18;
      unit=network==="BEP20"?"BNB":"ETH";
      if(from&&/^0x[a-fA-F0-9]{40}$/.test(from)){
        const bal=await provider.getBalance(from);extra.wallet_native=Number(ethers.formatEther(bal));
        if(asset==="USDT"){
          const token=new ethers.Contract(USDT_ADDR[network],["function balanceOf(address) view returns(uint256)"],provider);
          const tokenBalance:bigint=await token.balanceOf(from);
          extra.wallet_asset_balance=Number(ethers.formatUnits(tokenBalance,decimals));
          extra.wallet_usdt_balance=extra.wallet_asset_balance;
        }else{
          extra.wallet_asset_balance=Number(ethers.formatUnits(bal,decimals));
        }
      }
    }else if(network==="TRC20"||network==="TRON"){
      if(!from)throw new Error("The source TRON deposit address is not available");
      const state=await tronState(from);
      const recipient=/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(to)?to:from;
      const amountSun=Number(units);
      let tx:any,energy=0;
      if(network==="TRON"){
        tx=await getJson("https://api.trongrid.io/wallet/createtransaction",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner_address:from,to_address:recipient,amount:Math.max(1,amountSun),visible:true})});
        if(!tx?.raw_data_hex)throw new Error("TRON could not estimate a native transfer");
      }else{
        const parameter=tronHex(recipient).padStart(64,"0")+units.toString(16).padStart(64,"0");
        const d=await getJson("https://api.trongrid.io/wallet/triggersmartcontract",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner_address:from,contract_address:TRON_USDT,function_selector:"transfer(address,uint256)",parameter,fee_limit:400000000,visible:true})});
        if(d?.result?.result!==true||!d?.transaction?.raw_data_hex)throw new Error("TRON could not estimate the USDT transfer");
        tx=d.transaction;energy=Number(d?.energy_used||0);
      }
      native=tronFee(state,String(tx.raw_data_hex),energy);unit="TRX";extra.wallet_trx=state.trx;
      if(asset==="USDT"){
        extra.wallet_asset_balance=await tronUsdtBalance(from);
        extra.wallet_usdt_balance=extra.wallet_asset_balance;
      }else{
        extra.wallet_asset_balance=state.trx;
      }
    }else if(network==="SOLANA"){
      const conn=new Connection(SOLANA_RPC,"confirmed");
      const sender=from&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(from)?new PublicKey(from):new PublicKey("11111111111111111111111111111111");
      const recipient=to&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)?new PublicKey(to):sender;
      if(!PublicKey.isOnCurve(recipient.toBytes()))throw new Error("Solana native transfers require a normal wallet address");
      const info=await conn.getAccountInfo(recipient,"confirmed");
      if(info&&!info.owner.equals(SystemProgram.programId))throw new Error("This Solana address is a program account, not a normal native SOL receiving wallet");
      const block=await conn.getLatestBlockhash("confirmed");
      const tx=new Transaction({feePayer:sender,recentBlockhash:block.blockhash}).add(SystemProgram.transfer({fromPubkey:sender,toPubkey:recipient,lamports:Number(units||1n)}));
      const fee=await conn.getFeeForMessage(tx.compileMessage(),"confirmed");
      if(fee===null)throw new Error("Solana did not return a fee estimate");
      native=fee/1e9;unit="SOL";
      if(from){extra.wallet_native=(await conn.getBalance(sender,"confirmed"))/1e9};extra.wallet_asset_balance=extra.wallet_native
    }else if(network==="BITCOIN"){
      const [fees,utxos]=await Promise.all([
        getJson(BTC_API+"/v1/fees/recommended"),
        from?getJson(BTC_API+"/address/"+encodeURIComponent(from)+"/utxo"):Promise.resolve([]),
      ]);
      const rate=Number(fees?.halfHourFee??fees?.fastestFee??0);
      if(!Number.isFinite(rate)||rate<=0)throw new Error("Bitcoin fee estimates are unavailable");
      const inputs=(Array.isArray(utxos)?utxos:[]).filter((x:any)=>x?.status?.confirmed).length||1;
      const vbytes=10+68*inputs+31*2;
      native=Math.ceil(vbytes*rate)/1e8;unit="BTC";
      extra.wallet_native=(Array.isArray(utxos)?utxos:[]).reduce((sum:number,x:any)=>sum+(x?.status?.confirmed?Number(x.value||0):0),0)/1e8;
      extra.wallet_asset_balance=extra.wallet_native;
    }else if(network==="DOGECOIN"){
      const [fees,utxos]=await Promise.all([
        getJson(DOGE_API+"/fees"),
        from?getJson(DOGE_BLOCKBOOK+"/api/v2/utxo/"+encodeURIComponent(from)):Promise.resolve([]),
      ]);
      const rate=Number(fees?.data?.fee_rate_koinu_per_byte?.median??fees?.data?.fee_rate_koinu_per_byte?.min??0);
      if(!Number.isFinite(rate)||rate<=0)throw new Error("Dogecoin fee estimates are unavailable");
      const rows=Array.isArray(utxos)?utxos:(utxos?.utxos||utxos?.data||[]);
      const inputs=rows.length||1;
      const bytes=10+148*inputs+34*2;
      native=Math.ceil(bytes*rate)/1e8;unit="DOGE";
      extra.wallet_native=rows.reduce((sum:number,x:any)=>sum+(Number(x?.height??x?.confirmations??0)>0?Number(x.value||0):0),0)/1e8;
      extra.wallet_asset_balance=extra.wallet_native;
    }
    if(["ERC20","BEP20","ETHEREUM"].includes(network)&&(!Number.isFinite(native)||native<=0))throw new Error("The live EVM gas estimate is zero or unavailable; no fee-free withdrawal quote can be returned.");
    if(["ERC20","BEP20","ETHEREUM"].includes(network)&&(!Number.isFinite(native)||native<=0))throw new Error("The live EVM gas estimate is zero or unavailable; a fee-free quote cannot be returned.");
    const feeUsd=native*await price(unit);
    if(!Number.isFinite(feeUsd)||feeUsd<0)throw new Error("The live network fee USD conversion is unavailable.");
    if(!Number.isFinite(feeUsd)||feeUsd<0)throw new Error("The live fee USD conversion is unavailable.");
    return response(feeData(native,unit,feeUsd,extra));
  }catch(e){
    return response({error:"Could not estimate the live network fee: "+String((e as any)?.message??e)},502);
  }
});
