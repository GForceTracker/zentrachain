// Builds supabase/data/map-fragment.html: self-contained world map section.
const fs = require('fs');
const path = require('path');

const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'worldmap.json'), 'utf8'));
const dotsPacked = map.dots.map(([c, r]) => c + ',' + r).join(';');
const markers = map.markers.map((m) => ({ n: m.region, x: m.x, y: m.y, m: m.members }));

const css = `
<style id="zc-world-network-style">
#network .zc-map-shell{position:relative;border:1px solid var(--line);border-radius:18px;background:color-mix(in srgb,var(--panel) 88%,transparent);overflow:hidden}
#zc-world-svg{display:block;width:100%;height:auto;max-height:700px}
#zc-world-svg #zc-map-view{transform-box:fill-box;transform-origin:center;animation:zc-map-breathe 26s ease-in-out infinite}
@keyframes zc-map-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
#zc-world-svg .zc-dot{fill:var(--green);opacity:.34}
#zc-world-svg .zc-marker-core{fill:var(--green);stroke:var(--bg);stroke-width:1.2}
#zc-world-svg .zc-marker-pulse{fill:none;stroke:var(--green);stroke-width:1.4;opacity:0;transform-box:fill-box;transform-origin:center;animation:zc-marker-blink 2.8s ease-out infinite;animation-delay:calc(var(--i)*.22s)}
@keyframes zc-marker-blink{0%{opacity:0;transform:scale(.4)}25%{opacity:.9}100%{opacity:0;transform:scale(2.6)}}
#zc-world-svg .zc-arc{fill:none;stroke:var(--mint);stroke-width:1;opacity:.35;stroke-dasharray:5 7;animation:zc-arc-flow 3.2s linear infinite}
@keyframes zc-arc-flow{to{stroke-dashoffset:-48}}
#zc-world-svg .zc-scope{will-change:transform}
#zc-world-svg .zc-scope-ring{fill:none;stroke:var(--mint);stroke-width:1.6}
#zc-world-svg .zc-scope-ring.spin{transform-box:fill-box;transform-origin:center;animation:zc-scope-spin 9s linear infinite}
@keyframes zc-scope-spin{to{transform:rotate(360deg)}}
#zc-world-svg .zc-scope-cross{stroke:var(--mint);stroke-width:1.4;opacity:.9}
#zc-world-svg .zc-scope-dot{fill:var(--mint)}
#zc-world-svg .zc-scope.lock .zc-scope-ring{stroke-width:2.4}
.zc-map-card{position:absolute;left:14px;bottom:14px;max-width:min(320px,72%);border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(6px);padding:12px 14px;transform:scale(.9);opacity:.75;transition:transform .45s cubic-bezier(.2,.9,.3,1.4),opacity .45s ease}
.zc-map-card.is-lock{transform:scale(1);opacity:1}
.zc-map-card h3{margin:2px 0 4px;font-size:18px}
.zc-map-card p{margin:0 0 10px;font-size:12px;color:var(--muted)}
.zc-map-card .btn{padding:7px 12px;font-size:12px}
.zc-map-legend{position:absolute;right:14px;top:12px;display:flex;gap:12px;font-size:11px;color:var(--muted)}
.zc-map-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:5px;box-shadow:0 0 8px var(--green)}
@media (prefers-reduced-motion:reduce){#zc-world-svg .zc-marker-pulse,#zc-world-svg .zc-arc,#zc-world-svg .zc-scope-ring.spin,#zc-world-svg #zc-map-view{animation:none}}
@media (max-width:640px){.zc-map-card{position:static;max-width:none;margin:10px 12px 12px;transform:none;opacity:1}.zc-map-card.is-lock{transform:none}.zc-map-card h3{font-size:15px}.zc-map-legend{display:none}}
</style>`;

const section = `
<section class="section zc-worldmap" id="network">
  <div class="section-head"><div><div class="eyebrow">Global network</div><h2>One world. Every market.</h2><p class="muted">Live community presence across <b>${markers.length} regions</b> — watch the scope lock onto active locations.</p></div></div>
  <div class="zc-map-shell">
    <svg id="zc-world-svg" viewBox="0 0 ${map.w} ${map.h}" role="img" aria-label="World map of community regions"><g id="zc-map-view"><g id="zc-map-dots"></g><g id="zc-map-arcs"></g><g id="zc-map-markers"></g><g id="zc-map-scope" class="zc-scope" transform="translate(-100,-100)"><circle class="zc-scope-ring spin" r="26" stroke-dasharray="10 6" cx="0" cy="0"/><circle class="zc-scope-ring" r="15" cx="0" cy="0"/><line class="zc-scope-cross" x1="-34" y1="0" x2="-18" y2="0"/><line class="zc-scope-cross" x1="18" y1="0" x2="34" y2="0"/><line class="zc-scope-cross" x1="0" y1="-34" x2="0" y2="-18"/><line class="zc-scope-cross" x1="0" y1="18" x2="0" y2="34"/><circle class="zc-scope-dot" r="2.6" cx="0" cy="0"/></g></g></svg>
    <div class="zc-map-legend"><span><i></i>Active region</span><span>◉ Telescope lock</span></div>
    <div class="zc-map-card" id="zc-map-card"><div class="eyebrow">Telescope · Now viewing</div><h3 id="zc-map-card-name">Scanning…</h3><p id="zc-map-card-meta">Locking onto community regions.</p><button class="btn" type="button" onclick="document.getElementById('zc-public-activity').scrollIntoView({behavior:'smooth'})">View live activity</button></div>
  </div>
</section>`;

const script = `
<script id="zc-world-network-v1">
(function(){
  if(window.__zcWorldNetworkV1)return;
  window.__zcWorldNetworkV1=true;
  var NS='http://www.w3.org/2000/svg';
  var W=${map.w},H=${map.h},COLS=${map.cols},ROWS=${map.rows},CELL_X=(W/COLS),CELL_Y=(H/ROWS);
  var DOTS='${dotsPacked}'.split(';');
  var MARKERS=${JSON.stringify(markers)};
  var svg=document.getElementById('zc-world-svg');
  if(!svg)return;
  var view=document.getElementById('zc-map-view');
  var dotsG=document.getElementById('zc-map-dots');
  var arcsG=document.getElementById('zc-map-arcs');
  var markersG=document.getElementById('zc-map-markers');
  var scope=document.getElementById('zc-map-scope');
  var card=document.getElementById('zc-map-card');
  var cardName=document.getElementById('zc-map-card-name');
  var cardMeta=document.getElementById('zc-map-card-meta');
  function el(tag,attrs,parent){var n=document.createElementNS(NS,tag);for(var k in attrs)n.setAttribute(k,attrs[k]);if(parent)parent.appendChild(n);return n}
  var frag=document.createDocumentFragment();
  for(var i=0;i<DOTS.length;i++){var p=DOTS[i].split(','),c=+p[0],r=+p[1];el('circle',{cx:(c+.5)*CELL_X,cy:(r+.5)*CELL_Y,r:2,'class':'zc-dot'},frag)}
  dotsG.appendChild(frag);
  var hub=null,mi;
  for(mi=0;mi<MARKERS.length;mi++){if(!hub||MARKERS[mi].m>hub.m)hub=MARKERS[mi]}
  for(mi=0;mi<MARKERS.length;mi++){
    (function(mk,idx){
      var g=el('g',{},markersG);
      el('circle',{cx:mk.x,cy:mk.y,r:9,'class':'zc-marker-pulse',style:'--i:'+idx},g);
      el('circle',{cx:mk.x,cy:mk.y,r:3.2,'class':'zc-marker-core'},g);
    })(MARKERS[mi],mi);
  }
  if(hub){
    var others=MARKERS.filter(function(m){return m!==hub}).sort(function(a,b){return b.m-a.m}).slice(0,8);
    others.forEach(function(m){
      var mx=(hub.x+m.x)/2,my=Math.min(hub.y,m.y)-70;
      el('path',{d:'M'+hub.x+' '+hub.y+' Q'+mx+' '+my+' '+m.x+' '+m.y,'class':'zc-arc'},arcsG);
    });
  }
  var order=MARKERS.slice().sort(function(a,b){return b.m-a.m});
  var at=0,reduceMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var scopePos={x:-100,y:-100},scopeAnim=null;
  function moveScope(x,y){
    if(!scope)return;
    if(scopeAnim)cancelAnimationFrame(scopeAnim);
    if(reduceMotion){scopePos.x=x;scopePos.y=y;scope.setAttribute('transform','translate('+x+','+y+')');return}
    var sx=scopePos.x,sy=scopePos.y,dx=x-sx,dy=y-sy,t0=null,DUR=1200;
    function step(t){
      if(t0===null)t0=t;
      var p=Math.min(1,(t-t0)/DUR),e=p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2;
      scopePos.x=sx+dx*e;scopePos.y=sy+dy*e;
      scope.setAttribute('transform','translate('+scopePos.x.toFixed(1)+','+scopePos.y.toFixed(1)+')');
      if(p<1&&!document.hidden)scopeAnim=requestAnimationFrame(step);
      else{scopePos.x=x;scopePos.y=y;scope.setAttribute('transform','translate('+x+','+y+')');scopeAnim=null}
    }
    scopeAnim=requestAnimationFrame(step);
  }
  function lock(m){
    if(!m||!scope)return;
    moveScope(m.x,m.y);
    scope.classList.remove('lock');
    if(card){
      card.classList.remove('is-lock');
      void card.offsetWidth;
      if(cardName)cardName.textContent=m.n;
      if(cardMeta)cardMeta.textContent=m.m+' community member'+(m.m===1?'':'s')+' · Active node · '+m.x.toFixed(0)+' / '+m.y.toFixed(0);
      card.classList.add('is-lock');
    }
    setTimeout(function(){if(scope)scope.classList.add('lock')},1150);
  }
  function cycle(){if(document.hidden||!order.length)return;lock(order[at%order.length]);at++}
  lock(order[0]);at=1;
  if(!reduceMotion)window.setInterval(cycle,4500);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)cycle()});
})();
</script>`;

fs.writeFileSync(path.join(__dirname, 'map-fragment.html'), css + '\n' + section + '\n' + script + '\n');
console.log('map-fragment.html written');
