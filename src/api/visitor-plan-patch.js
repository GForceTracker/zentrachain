'use strict';

/*
 * Visitor plan rail behaviour (injected by site.js when the page is served).
 *
 * - Scrolling, tapping or choosing a plan never changes the plan calculator,
 *   and the calculator's own plan selector never highlights a card.
 * - Clicking "Choose plan" opens Create account (with the Log in switch).
 * - ONE highlighted card at a time (class zc-scroll-pressed). It is set by a
 *   tap, the Choose plan button, the keyboard, or by scrolling a card into
 *   focus, and it lights the border, glow, running edge animation and the
 *   Choose plan button all at once.
 */

const MARKER = 'zc-visitor-plan-flow-v2';

// Runs at the top of <head>, before the older swipe-selection script. That
// script checks this flag and skips itself, which stops it from relabelling
// the button "Selected" and from driving the calculator while scrolling.
const EARLY = '<script id="' + MARKER + '-early">window.__zcVisitorPlanSwipeSelectionV2=true;</script>';

const STYLE = `<style id="${MARKER}-css">
/* Highlighted card: border + glow + lift. */
html body #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed.zc-scroll-pressed{
  position:relative!important;z-index:6!important;
  border:2px solid color-mix(in srgb,var(--green,#20c783) 92%,white)!important;
  outline:1px solid color-mix(in srgb,var(--green,#20c783) 55%,transparent)!important;outline-offset:2px!important;
  box-shadow:0 0 0 1px color-mix(in srgb,var(--green,#20c783) 30%,transparent),0 0 16px color-mix(in srgb,var(--green,#20c783) 58%,transparent),0 0 34px color-mix(in srgb,var(--green,#20c783) 30%,transparent),0 14px 32px rgba(0,0,0,.34),inset 0 0 20px color-mix(in srgb,var(--green,#20c783) 10%,transparent)!important;
  transform:translateY(-3px)!important;
}
/* Running edge animation, together with the rest of the highlight. */
html body #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed.zc-scroll-pressed::after{
  opacity:1!important;animation:zc-theme-edge-run 2.6s linear infinite!important;
}
@media(prefers-reduced-motion:reduce){
  html body #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed.zc-scroll-pressed::after{animation:none!important}
}

/* Resting button: same look for every plan, nothing looks "selected". */
body[data-zc-theme] #public-plan-cards>.gf-plan-compact-card:not(.zc-scroll-pressed) .gf-plan-select-button.gf-plan-select-button{
  background:linear-gradient(135deg,var(--green,#20c783),var(--panel2,#0b2118))!important;
  border-color:var(--green,#20c783)!important;
  color:var(--text,#ecfff4)!important;
  box-shadow:0 7px 20px color-mix(in srgb,var(--green,#20c783) 20%,transparent)!important;
  transform:none!important;
  filter:none!important;
  transition:none!important;
}
body[data-zc-theme="emerald"] #public-plan-cards>.gf-plan-compact-card:not(.zc-scroll-pressed) .gf-plan-select-button.gf-plan-select-button{
  color:#032116!important;
}

/* Glowing, pressed-looking button on the highlighted plan. No transition so it
   lights up the instant the card is highlighted. */
html body #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed .gf-plan-select-button.gf-plan-select-button,
body[data-zc-theme] #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed .gf-plan-select-button.gf-plan-select-button{
  background:linear-gradient(135deg,color-mix(in srgb,var(--mint,#7cf0b8) 70%,var(--green,#20c783)),var(--green,#20c783))!important;
  border-color:var(--mint,#9be8c5)!important;
  color:#032116!important;
  box-shadow:0 0 0 2px color-mix(in srgb,var(--mint,#9be8c5) 40%,transparent),0 0 14px color-mix(in srgb,var(--green,#20c783) 80%,transparent),0 0 32px color-mix(in srgb,var(--green,#20c783) 48%,transparent),inset 0 2px 6px rgba(0,0,0,.28)!important;
  transform:translateY(1px)!important;
  filter:brightness(1.08)!important;
  transition:none!important;
  background-image:linear-gradient(115deg,#71efb8 0%,#b7ffe1 28%,#35d79a 52%,#a0f8ce 76%,#71efb8 100%)!important;
  background-size:240% 240%!important;
  animation:zcVisitorPlanButtonGlow 2.6s ease-in-out infinite!important;
}
@keyframes zcVisitorPlanButtonGlow{
  0%,100%{background-position:0% 50%;box-shadow:0 0 0 2px rgba(155,255,208,.28),0 0 12px rgba(32,199,131,.60),0 0 25px rgba(32,199,131,.30),inset 0 2px 6px rgba(0,0,0,.20)!important}
  50%{background-position:100% 50%;box-shadow:0 0 0 2px rgba(190,255,226,.48),0 0 18px rgba(32,199,131,.88),0 0 36px rgba(32,199,131,.46),inset 0 2px 6px rgba(0,0,0,.16)!important}
}
@media(prefers-reduced-motion:reduce){
  html body #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed .gf-plan-select-button.gf-plan-select-button{animation:none!important}
}
</style>`;

const SCRIPT = `<script id="${MARKER}-js">
(function(){
 if(window.__zcVisitorPlanFlowV2)return;
 window.__zcVisitorPlanFlowV2=true;
 var RAIL_ID='public-plan-cards',BUTTON='.gf-plan-select-button',CARD='.gf-plan-compact-card';
 var LEGACY=['is-scroll-active','is-selected','is-tap-selected','is-tap-focus','zc-plan-selected','zc-plan-auto-active-v9'];
 var pressedId='',lastTap=0,frame=0,settle=0,busy=false,boundRail=null;

 // 1. The visitor plan rail must never drive the calculator.
 var previousChoose=window.gfChoose;
 window.gfChoose=function(scope){
  if(scope==='pub')return;
  return typeof previousChoose==='function'?previousChoose.apply(this,arguments):undefined;
 };

 function rail(){return document.getElementById(RAIL_ID)}
 function cardsOf(r){return Array.prototype.filter.call(r.children,function(c){return c.classList&&c.classList.contains('gf-plan-compact-card')})}

 // 2. One highlighted card. Legacy highlight classes (which are derived from the
 //    calculator's own plan selector) are removed from the visitor rail.
 function paint(){
  var r=rail();
  if(!r||busy)return;
  busy=true;
  try{
   cardsOf(r).forEach(function(c){
    var on=!!pressedId&&c.getAttribute('data-gf-plan-id')===pressedId;
    LEGACY.forEach(function(cls){if(c.classList.contains(cls))c.classList.remove(cls)});
    if(c.classList.contains('zc-scroll-pressed')!==on)c.classList.toggle('zc-scroll-pressed',on);
   });
  }finally{busy=false}
 }
 function press(card){
  var id=card&&card.getAttribute('data-gf-plan-id');
  if(!id)return;
  pressedId=id;
  paint();
 }

 // 3. "Choose plan" opens Create account / Log in, and highlights its card.
 function planButton(target){
  return target&&target.closest?target.closest('#'+RAIL_ID+' '+BUTTON):null;
 }
 function planCard(target){
  return target&&target.closest?target.closest('#'+RAIL_ID+' '+CARD):null;
 }
 document.addEventListener('click',function(event){
  var card=planCard(event.target);
  if(card){lastTap=Date.now();press(card)}
  if(!planButton(event.target))return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if(typeof window.showAuth==='function')window.showAuth('signup');
 },true);
 // Keep the card's own Enter/Space handler from swallowing the button's keys;
 // Enter/Space on the card itself highlights it.
 document.addEventListener('keydown',function(event){
  if(event.key!=='Enter'&&event.key!==' ')return;
  if(planButton(event.target)){event.stopPropagation();return}
  var card=planCard(event.target);
  if(card&&event.target===card){lastTap=Date.now();press(card)}
 },true);

 // 4. Scrolling a card into focus highlights it the same way.
 function update(){
  frame=0;
  var r=rail();
  if(!r||Date.now()-lastTap<700)return;
  var cards=cardsOf(r),box=r.getBoundingClientRect(),active=null,best=Infinity;
  if(box.width<=0||box.bottom<=0||box.top>=window.innerHeight)return;
  var horizontal=r.scrollWidth>r.clientWidth+4;
  var cx=box.left+r.clientLeft+r.clientWidth/2,cy=window.innerHeight/2;
  cards.forEach(function(c){
   var b=c.getBoundingClientRect();
   if(b.width<=0||b.height<=0)return;
   var d;
   if(horizontal){
    var vw=Math.max(0,Math.min(b.right,box.right)-Math.max(b.left,box.left));
    if(vw<Math.min(24,b.width*.12))return;
    d=Math.abs((b.left+b.right)/2-cx);
   }else{
    if(b.bottom<=0||b.top>=window.innerHeight)return;
    d=Math.abs((b.top+b.bottom)/2-cy);
   }
   if(d<best){best=d;active=c}
  });
  if(active)press(active);
 }
 function schedule(){
  if(settle)clearTimeout(settle);
  settle=setTimeout(function(){if(!frame)frame=window.requestAnimationFrame(update)},90);
 }
 function bind(){
  var r=rail();
  if(r&&r!==boundRail){
   boundRail=r;
   ['scroll','touchend','pointerup','wheel'].forEach(function(type){r.addEventListener(type,schedule,{passive:true})});
   // Re-apply after cards re-render and strip highlight classes other scripts add.
   new MutationObserver(function(){
    if(busy)return;
    var first=!pressedId;
    paint();
    if(first)schedule();
   }).observe(r,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  }
  paint();
  schedule();
 }
 window.addEventListener('scroll',schedule,{passive:true});
 window.addEventListener('resize',schedule,{passive:true});
 window.addEventListener('orientationchange',schedule,{passive:true});
 window.addEventListener('load',bind);
 new MutationObserver(function(){if(rail()&&rail()!==boundRail)bind()}).observe(document.body,{childList:true,subtree:true});
 bind();
})();
</script>`;

function applyVisitorPlanPatch(html) {
  if (typeof html !== 'string' || html.indexOf(MARKER) !== -1) return html;
  const headAt = html.indexOf('<head>');
  const withEarly = headAt === -1
    ? html
    : html.slice(0, headAt + 6) + EARLY + html.slice(headAt + 6);
  return withEarly + '\n' + STYLE + '\n' + SCRIPT + '\n';
}

module.exports = { applyVisitorPlanPatch };
