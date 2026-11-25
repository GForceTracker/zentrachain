(function(){
'use strict';
const $=id=>document.getElementById(id), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8});
const pc=(v,t)=>t>0?Math.max(0,Math.min(100,Number(v||0)/t*100)):100;
let locked=false;
async function syncMenu(){
 const n=$('zc-tap-earn-nav');if(!n)return;
 if(typeof currentUser==='undefined'||!currentUser||!currentUser.id||typeof db==='undefined'){n.classList.add('hidden');return}
 try{const r=await db.rpc('tap_earn_is_enabled');const on=!r.error&&r.data===true;n.classList.toggle('hidden',!on);if(!on&&typeof page!=='undefined'&&page==='tap-earn')navigate('overview')}catch(e){n.classList.add('hidden')}
}
window.zcSyncTapEarnMenu=syncMenu;
const progress=(title,label,value,note)=>'<div class="zc-tap-progress-item"><div class="zc-tap-progress-top"><b>'+title+'</b><span>'+label+'</span></div><div class="zc-tap-progress-track"><i style="width:'+pc(value,100)+'%"></i></div><small>'+note+'</small></div>';
const tag=s=>'<span class="zc-tap-status '+(s==='paid'?'good':s==='approved'?'warn':s==='declined'?'rejected':'')+'">'+esc(String(s||'pending').replace(/_/g,' '))+'</span>';
function history(items){return !items||!items.length?'<div class="empty">No Tap To Earn withdrawals yet.</div>':items.map(x=>'<div class="zc-tap-history-row"><div><b>'+usd(x.amount)+'</b><small>'+esc(x.network)+' · '+esc(x.created_at?new Date(x.created_at).toLocaleString():'—')+'</small>'+(x.tx_hash?'<small>TX: '+esc(x.tx_hash)+'</small>':'')+'</div>'+tag(x.status)+'</div>').join('')}
async function renderTapEarn(state){
 const c=$('app-content');if(!c)return;c.innerHTML='<section class="card panel"><p class="muted">Loading Tap To Earn…</p></section>';
 try{
  if(!state||typeof state.tap_balance==='undefined'){const r=await db.rpc('tap_earn_state');if(r.error)throw r.error;state=r.data}
  if(!state||!state.enabled)throw Error('Tap To Earn is currently disabled.');
  const daily=Number(state.daily_free_taps||100),used=Number(state.free_taps_used||0),free=Number(state.free_taps_remaining||0),bonus=Number(state.bonus_taps_available||0),invites=Number(state.invite_count||0),required=Number(state.minimum_invites||15),min=Number(state.minimum_withdrawal_usd||1),available=Number(state.available_balance||0),reward=Number(state.reward_per_tap||.0003),bonusRate=Number(state.bonus_taps_per_referral||50),canTap=free>0||bonus>0;
  const link=typeof zcReferralLink==='function'?zcReferralLink():(profile&&profile.referral_code?location.origin+'/?ref='+encodeURIComponent(profile.referral_code):'');
  c.innerHTML=
   '<div class="page-title zc-tap-page-title"><div><div class="eyebrow">REWARDS CENTRE</div><h1>Tap To Earn</h1><p class="muted">Earn '+usd(reward)+' for each confirmed tap.</p></div><span class="zc-tap-live-pill"><i></i>'+(canTap?'READY TO EARN':'TAPS COMPLETE')+'</span></div>'+
   '<section class="card panel zc-tap-hero"><div class="zc-tap-hero-copy"><div class="eyebrow">YOUR DAILY REWARD</div><h2>Tap the Bitcoin logo to earn.</h2><p>Each confirmed tap is credited to your separate Tap Balance. This larger coin stays whole and does not break apart.</p></div><button type="button" id="zc-tap-hit-target" class="zc-tap-logo-button" onclick="zcTapEarnClick()" '+(canTap?'':'disabled')+'><span class="zc-tap-logo-circle"><span class="zc-tap-logo-glyph">₿</span></span></button><div class="zc-tap-cta-label" id="zc-tap-cta-label">'+(canTap?'TAP BITCOIN TO EARN':'DAILY AND BONUS TAPS COMPLETE')+'</div><div class="zc-tap-earn-rate">+ '+usd(reward)+' <span>per tap</span></div><div class="zc-tap-hero-progress">'+progress('Daily taps',used+' / '+daily,daily?used/daily*100:100,free+' free taps remaining today · resets at 00:00 UTC')+'</div></section>'+
   '<div class="zc-tap-balance-grid"><section class="card panel zc-tap-balance-card"><small>TAP BALANCE</small><strong>'+usd(state.tap_balance)+'</strong><span>Separate reward balance</span></section><section class="card panel zc-tap-balance-card"><small>AVAILABLE TO WITHDRAW</small><strong>'+usd(available)+'</strong><span>After pending requests are reserved</span></section><section class="card panel zc-tap-balance-card"><small>TOTAL EARNED</small><strong>'+usd(state.total_earned)+'</strong><span>Lifetime tap rewards</span></section></div>'+
   '<section class="card panel zc-tap-progress-panel"><div class="eyebrow">YOUR PROGRESS</div><h3>Tap and withdrawal goals</h3>'+
   progress('Daily free taps',used+' / '+daily,daily?used/daily*100:100,free+' free taps remain today · resets at 00:00 UTC')+
   progress('Withdraw threshold',usd(available)+' / '+usd(min),min?available/min*100:100,available>=min?'Minimum balance reached.':'You need '+usd(min-available)+' more.')+
   progress('Verified invites',invites+' / '+required,required?invites/required*100:100,invites>=required?'Invite requirement completed.':'Invite '+(required-invites)+' more before withdrawing.')+
   '<div class="zc-tap-bonus-note"><b>'+bonus+' extra taps available</b><small>Each verified referral adds '+bonusRate+' bonus taps. They are used after your daily free taps.</small></div></section>'+
   '<section class="card panel zc-tap-invite-panel"><div class="eyebrow">INVITE & EARN</div><h3>Share your referral link</h3><p class="muted">A new member who signs up through your referral link adds '+bonusRate+' bonus taps after the referral is linked.</p><div class="zc-tap-referral-row"><input id="zc-tap-referral-link" readonly value="'+esc(link)+'"><button class="btn primary" onclick="zcTapCopyReferral()">Copy link</button></div></section>'+
   '<section class="card panel zc-tap-withdraw-panel"><div class="eyebrow">TAP REWARDS PAYOUT</div><h3>Withdraw Tap Balance</h3><p class="muted">USDT payout. Minimum '+required+' verified invites and '+usd(min)+' Tap Balance. Requests are reviewed by an administrator.</p>'+
   '<form onsubmit="return zcTapEarnSubmitWithdrawal(event)"><div class="zc-tap-form-grid"><div class="field"><label>Amount (USD)</label><input id="zc-tap-withdraw-amount" type="number" min="'+min+'" max="'+Number(state.maximum_withdrawal_usd||10000000)+'" step="0.00000001" required></div><div class="field"><label>USDT network</label><select id="zc-tap-withdraw-network"><option>TRC20</option><option>BEP20</option><option>ERC20</option></select></div><div class="field zc-tap-address-field"><label>USDT wallet address</label><input id="zc-tap-withdraw-address" minlength="20" maxlength="150" required></div></div><p class="muted">'+(invites<required?'Invite requirement not met.':available<min?'Tap balance below minimum.':'You meet the requirements.')+'</p><button class="btn primary" id="zc-tap-withdraw-submit" type="submit" '+(invites<required||available<min?'disabled':'')+'>Request withdrawal</button></form></section>'+
   '<section class="card panel zc-tap-history-panel"><h3>Withdrawal history</h3>'+history(state.recent_withdrawals||[])+'</section>';
 }catch(e){c.innerHTML='<section class="card panel"><h3>Tap To Earn is unavailable</h3><p class="muted">'+esc(e.message||'Please retry.')+'</p><button class="btn" onclick="zcOpenTapEarnPage()">Retry</button></section>'}
}
window.renderTapEarnPage=renderTapEarn;
window.zcOpenTapEarnPage=async()=>{if(!currentUser||!currentUser.id){toast('Please sign in.',true);return}page='tap-earn';document.querySelectorAll('.side-nav button').forEach(b=>b.classList.toggle('active',b.dataset.page==='tap-earn'));if(typeof closeDrawer==='function')closeDrawer();if(typeof zcApplyDashboardStyle==='function')zcApplyDashboardStyle();await renderTapEarn()};
window.zcTapEarnClick=async()=>{if(locked)return;locked=true;const b=$('zc-tap-hit-target');if(b){b.disabled=true;b.classList.add('is-tapping')}const l=$('zc-tap-cta-label');if(l)l.textContent='CONFIRMING TAP…';try{const r=await db.rpc('tap_earn_claim',{p_taps:1});if(r.error)throw r.error;toast('Tap confirmed: +'+usd(r.data.last_claim_reward||0));await renderTapEarn(r.data)}catch(e){toast(e.message||'Tap failed.',true);await renderTapEarn()}finally{locked=false}};
window.zcTapCopyReferral=async()=>{const i=$('zc-tap-referral-link');if(!i||!i.value){toast('Referral link not available.',true);return}try{if(navigator.clipboard&&navigator.clipboard.writeText)await navigator.clipboard.writeText(i.value);else{i.select();if(!document.execCommand('copy'))throw Error('copy')}toast('Referral link copied.')}catch(e){i.select();toast('Long-press the selected link to copy it.',true)}};
window.zcTapEarnSubmitWithdrawal=async e=>{if(e&&e.preventDefault)e.preventDefault();const amount=Number($('zc-tap-withdraw-amount').value),network=$('zc-tap-withdraw-network').value,address=$('zc-tap-withdraw-address').value.trim(),b=$('zc-tap-withdraw-submit');if(!amount||amount<=0){toast('Enter a valid amount.',true);return false}if(typeof zcValidateAddress==='function'&&!zcValidateAddress(network,address)){toast('Invalid '+network+' USDT address.',true);return false}b.disabled=true;b.textContent='Submitting…';try{const r=await db.rpc('tap_earn_request_withdrawal',{p_amount:amount,p_network:network,p_destination:address});if(r.error)throw r.error;toast('Tap withdrawal request submitted.');await renderTapEarn()}catch(x){toast(x.message||'Withdrawal request failed.',true);b.disabled=false;b.textContent='Request withdrawal'}return false};

async function adminPage(){
 const c=$('app-content');if(!c)return;if(typeof profile==='undefined'||profile?.role!=='admin'){toast('Administrator access required.',true);return}
 c.innerHTML='<section class="card panel">Loading Tap To Earn settings…</section>';
 try{
  const r=await db.rpc('tap_earn_admin_state');if(r.error)throw r.error;const s=r.data.settings||{},rows=r.data.withdrawals||[];
  c.innerHTML='<div class="zc-admin-page-head"><button class="zc-admin-back" onclick="zcAdminBackToMenu()">‹</button><div class="eyebrow">ADMIN ACCESS</div><h1>Tap To Earn</h1><p class="muted">Feature controls and payout review.</p></div>'+
   '<section class="card panel"><div class="zc-tap-admin-feature-toggle"><div><h3>Enable Tap To Earn</h3><p class="muted">When off, it is hidden from the customer hamburger menu and new taps and withdrawal requests are blocked.</p></div><label class="zc-tap-toggle"><input id="zc-tap-admin-enabled" type="checkbox" '+(s.enabled?'checked':'')+'><span></span></label></div>'+
   '<div class="zc-tap-admin-grid">'+
   '<div class="field"><label>Daily free taps</label><input id="zc-tap-admin-daily" type="number" min="1" max="10000" value="'+s.daily_free_taps+'"></div>'+
   '<div class="field"><label>USD reward per tap</label><input id="zc-tap-admin-reward" type="number" min=".00000001" max="1" step=".00000001" value="'+s.reward_per_tap+'"></div>'+
   '<div class="field"><label>Bonus taps per verified invite</label><input id="zc-tap-admin-bonus" type="number" min="0" max="10000" value="'+s.bonus_taps_per_referral+'"></div>'+
   '<div class="field"><label>Minimum invites to withdraw</label><input id="zc-tap-admin-invites" type="number" min="0" max="100000" value="'+s.minimum_invites+'"></div>'+
   '<div class="field"><label>Minimum withdrawal USD</label><input id="zc-tap-admin-min" type="number" min=".00000001" step=".00000001" value="'+s.minimum_withdrawal_usd+'"></div>'+
   '<div class="field"><label>Maximum withdrawal USD</label><input id="zc-tap-admin-max" type="number" min=".00000001" step=".00000001" value="'+s.maximum_withdrawal_usd+'"></div>'+
   '</div><div class="zc-tap-admin-actions"><button class="btn primary" onclick="zcTapEarnSaveAdminSettings()">Save settings</button></div></section>'+
   '<section class="card panel"><h3>Tap To Earn withdrawals</h3><div class="table-wrap zc-tap-admin-table"><table><thead><tr><th>Member</th><th>Amount</th><th>Network</th><th>Address</th><th>Status</th><th>Action</th></tr></thead><tbody>'+
   (rows.length?rows.map(w=>{let a='—';if(['pending','under_review'].includes(w.status))a='<button class="btn" onclick="zcTapAdminAction(&quot;approve&quot;,&quot;'+esc(w.id)+'&quot;)">Approve</button> <button class="btn danger" onclick="zcTapAdminAction(&quot;decline&quot;,&quot;'+esc(w.id)+'&quot;)">Decline</button>';if(w.status==='approved')a='<button class="btn primary" onclick="zcTapAdminAction(&quot;pay&quot;,&quot;'+esc(w.id)+'&quot;)">Mark paid</button> <button class="btn danger" onclick="zcTapAdminAction(&quot;decline&quot;,&quot;'+esc(w.id)+'&quot;)">Decline</button>';return '<tr><td>'+esc(w.name||'Member')+'<small>'+esc(w.email||'')+'</small></td><td>'+usd(w.amount)+'</td><td>'+esc(w.asset)+' · '+esc(w.network)+'</td><td>'+esc(w.destination_address)+'</td><td>'+tag(w.status)+'</td><td>'+a+'</td></tr>'}).join(''):'<tr><td colspan="6">No payout requests yet.</td></tr>')+'</tbody></table></div></section>';
 }catch(e){c.innerHTML='<section class="card panel">'+esc(e.message||'Unable to load Tap To Earn admin settings.')+'</section>'}
}
window.zcOpenTapEarnAdminPage=adminPage;
window.zcTapEarnSaveAdminSettings=async()=>{const n=id=>Number($(id).value),b=document.querySelector('.zc-tap-admin-actions .btn');b.disabled=true;try{const r=await db.rpc('tap_earn_admin_save_settings',{p_enabled:$('zc-tap-admin-enabled').checked,p_daily_free_taps:n('zc-tap-admin-daily'),p_reward_per_tap:n('zc-tap-admin-reward'),p_bonus_taps_per_referral:n('zc-tap-admin-bonus'),p_minimum_invites:n('zc-tap-admin-invites'),p_minimum_withdrawal_usd:n('zc-tap-admin-min'),p_maximum_withdrawal_usd:n('zc-tap-admin-max')});if(r.error)throw r.error;toast('Tap To Earn settings saved.');await syncMenu();await adminPage()}catch(e){toast(e.message||'Could not save settings.',true);b.disabled=false}};
window.zcTapAdminAction=async(action,id)=>{try{let r;if(action==='approve'){if(!confirm('Approve this withdrawal?'))return;r=await db.rpc('tap_earn_admin_approve_withdrawal',{p_request_id:id})}else if(action==='decline'){const note=prompt('Reason for declining (optional):','');if(note===null)return;r=await db.rpc('tap_earn_admin_decline_withdrawal',{p_request_id:id,p_note:note})}else if(action==='pay'){const hash=prompt('Enter the USDT transaction hash:','');if(hash===null)return;if(hash.trim().length<20){toast('Enter a valid transaction hash.',true);return}const note=prompt('Optional payout note:','');if(note===null)return;r=await db.rpc('tap_earn_admin_pay_withdrawal',{p_request_id:id,p_tx_hash:hash.trim(),p_note:note})}if(r.error)throw r.error;toast('Withdrawal status updated.');await adminPage()}catch(e){toast(e.message||'Could not update withdrawal.',true)}};

// Dashboard B: 18 real clipped fragments; 8 random lightning bolts flash every 10s; B reassembles on a 5s cycle.
function initBitcoin(el){
 if(!el||el.dataset.zcBitcoin18V2==='1')return;
 el.dataset.zcBitcoin18V2='1';
 const coin=document.createElement('span');coin.className='zc-bitcoin-coin';
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','zc-bitcoin-bolts');svg.setAttribute('viewBox','0 0 240 240');
 const paths=document.createElementNS('http://www.w3.org/2000/svg','g');svg.appendChild(paths);el.replaceChildren(coin,svg);
 // The original Bitcoin glyph is divided into 18 irregular, interlocking pieces.
 const cols=3,rows=6;let seed=24119;
 const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
 const jitter=v=>v+(rand()-.5)*2.2;
 const xs=[0,100/3,200/3,100],ys=[0,100/6,200/6,50,400/6,500/6,100];
 const corners=Array.from({length:rows+1},(_,r)=>Array.from({length:cols+1},(_,c)=>({x:c===0||c===cols?xs[c]:jitter(xs[c]),y:r===0||r===rows?ys[r]:jitter(ys[r])})));
 const horizontal=Array.from({length:rows+1},(_,r)=>Array.from({length:cols},(_,c)=>({x:(corners[r][c].x+corners[r][c+1].x)/2+(rand()-.5)*1.3,y:corners[r][c].y+(rand()-.5)*1.1})));
 const vertical=Array.from({length:rows},(_,r)=>Array.from({length:cols+1},(_,c)=>({x:corners[r][c].x+(rand()-.5)*1.1,y:(corners[r][c].y+corners[r+1][c].y)/2+(rand()-.5)*1.3})));
 const pieces=[];
 for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
  const a=corners[r][c],b=corners[r][c+1],d=corners[r+1][c],e=corners[r+1][c+1];
  const poly=[a,horizontal[r][c],b,vertical[r][c+1],e,horizontal[r+1][c],d,vertical[r][c]].map(p=>p.x.toFixed(2)+'% '+p.y.toFixed(2)+'%').join(',');
  const n=document.createElement('span');n.className='zc-bitcoin-piece';n.textContent='₿';n.style.clipPath='polygon('+poly+')';n.style.webkitClipPath='polygon('+poly+')';
  const cx=(a.x+b.x+d.x+e.x)/4,cy=(a.y+b.y+d.y+e.y)/4;
  pieces.push({n,x:(cx-50)/50*3.25+(rand()-.5)*.9,y:(cy-50)/50*3.25+(rand()-.5)*.9,rot:(rand()-.5)*13});coin.appendChild(n);
 }
 // Eight independent jagged lightning bolts flash at random directions every 10 seconds.
 // Their tips stop in the gap around the B; the ring and B are never covered.
 const NS='http://www.w3.org/2000/svg',between=(a,b)=>a+Math.random()*(b-a);
 function makeBolt(angle){
  const pts=[],outer=109,inner=84,steps=5;
  for(let i=0;i<=steps;i++){
   const f=i/steps,r=outer+(inner-outer)*f,a=angle+(i===0?0:between(-.19,.19)),rr=r+(i===0||i===steps?0:between(-4,4));
   pts.push([120+Math.cos(a)*rr,120+Math.sin(a)*rr]);
  }
  const d=pts.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join(' ');
  ['zc-btc-bolt-glow','zc-btc-bolt-core'].forEach(cls=>{const p=document.createElementNS(NS,'path');p.setAttribute('class',cls);p.setAttribute('d',d);paths.appendChild(p)});
 }
 function flashLightning(){
  if(!el.isConnected)return;
  paths.replaceChildren();
  Array.from({length:8},()=>between(0,Math.PI*2)).forEach(makeBolt);
  svg.classList.remove('flash');void svg.getBoundingClientRect();svg.classList.add('flash');
  window.setTimeout(()=>svg.classList.remove('flash'),720);
 }
 const boltTimer=window.setInterval(flashLightning,10000);
 // Fragments move out, remain separated briefly, then fit back into the intact B.
 const cycle=5000,separation=650,stagger=42,duration=230,repair=2750,ease=v=>{v=Math.max(0,Math.min(1,v));return v*v*(3-2*v)};
 let epoch=performance.now();
 function frame(now){
  if(!el.isConnected){window.clearInterval(boltTimer);return}
  const t=(now-epoch)%cycle;
  pieces.forEach((p,i)=>{
   const out=separation+i*stagger,back=repair+(pieces.length-1-i)*stagger;let k=0;
   if(t>=out&&t<out+duration)k=ease((t-out)/duration);
   else if(t>=out+duration&&t<back)k=1;
   else if(t>=back&&t<back+duration)k=1-ease((t-back)/duration);
   p.n.style.transform='translate3d('+ (p.x*k).toFixed(2)+'px,'+(p.y*k).toFixed(2)+'px,'+(8*k).toFixed(2)+'px) rotate('+(p.rot*k).toFixed(2)+'deg)';
   p.n.style.filter=k>.02?'drop-shadow(0 0 2px var(--mint)) drop-shadow(0 0 3px var(--green))':'drop-shadow(0 0 3px color-mix(in srgb,var(--green) 40%,transparent))';
  });
  window.requestAnimationFrame(frame);
 }
 window.requestAnimationFrame(frame);
}
function scan(node){if(!node)return;if(node.matches&&node.matches('.zc-mobile-bitcoin-emblem'))initBitcoin(node);if(node.querySelectorAll)node.querySelectorAll('.zc-mobile-bitcoin-emblem').forEach(initBitcoin);const hero=node.matches&&node.matches('.app-hero-row')?node:node.querySelector&&node.querySelector('.app-hero-row');if(hero&&!hero.querySelector('.zc-mobile-bitcoin-emblem')){const logo=document.createElement('span');logo.className='zc-mobile-bitcoin-emblem';logo.setAttribute('role','img');logo.setAttribute('aria-label','Bitcoin emblem');hero.insertBefore(logo,hero.querySelector('.app-quick-actions')||null);initBitcoin(logo)}}
const app=$('app-content');if(app){scan(app);const mo=new MutationObserver(rs=>rs.forEach(r=>r.addedNodes.forEach(n=>{if(n.nodeType===1)scan(n)})));mo.observe(app,{childList:true,subtree:true})}
const old=window.showApp;if(typeof old==='function')window.showApp=function(){const r=old.apply(this,arguments);syncMenu();return r};
if(typeof currentUser!=='undefined'&&currentUser&&currentUser.id)syncMenu();
})();