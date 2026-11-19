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
const EARLY = '<script id="' + MARKER + '-early">window.__zcVisitorPlanSwipeSelectionV2=true;window.__zcVisitorPlanFlowV2Controller=true;window.__zcVisitorPlanScrollHighlightV11=true;window.__zcVisitorPlanScrollHighlightV10=true;</script>';

const STYLE = `<style id="${MARKER}-css">
#public-plan-cards>.gf-plan-compact-card{position:relative!important;isolation:isolate!important}
html body #public-plan-cards>.gf-plan-compact-card.zc-plan-active-v3{
 z-index:12!important;border:2px solid #73efb9!important;
 outline:1px solid rgba(155,255,208,.72)!important;outline-offset:2px!important;
 box-shadow:0 0 0 2px rgba(72,235,158,.18),0 0 18px rgba(32,199,131,.68),0 0 38px rgba(32,199,131,.38),0 14px 34px rgba(0,0,0,.36),inset 0 0 18px rgba(32,199,131,.12)!important;
 transform:translateY(-3px)!important;
}
#public-plan-cards>.gf-plan-compact-card.zc-plan-active-v3::after{
 content:""!important;display:block!important;position:absolute!important;inset:0!important;
 z-index:30!important;pointer-events:none!important;border-radius:inherit!important;padding:3px!important;
 background:conic-gradient(from 0deg,transparent 0deg,transparent 225deg,rgba(70,255,174,.25) 245deg,#62ffb5 270deg,#eafff4 286deg,#62ffb5 302deg,rgba(70,255,174,.2) 325deg,transparent 350deg,transparent 360deg)!important;
 -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0)!important;
 -webkit-mask-composite:xor!important;mask-composite:exclude!important;
 opacity:1!important;animation:zcPlanActiveEdgeSpinV3 2.1s linear infinite!important;
}
@keyframes zcPlanActiveEdgeSpinV3{to{transform:rotate(1turn)}}
#public-plan-cards>.gf-plan-compact-card.zc-plan-active-v3 .gf-plan-select-button{
 background:linear-gradient(115deg,#71efb8 0%,#b7ffe1 28%,#35d79a 52%,#a0f8ce 76%,#71efb8 100%)!important;
 background-size:240% 240%!important;border:1px solid #b7ffe1!important;color:#032116!important;
 box-shadow:0 0 0 2px rgba(155,255,208,.32),0 0 14px rgba(32,199,131,.76),0 0 30px rgba(32,199,131,.42)!important;
 animation:zcPlanActiveButtonGlowV3 2.3s ease-in-out infinite!important;
}
@keyframes zcPlanActiveButtonGlowV3{
 0%,100%{background-position:0% 50%;box-shadow:0 0 0 2px rgba(155,255,208,.25),0 0 12px rgba(32,199,131,.65),0 0 24px rgba(32,199,131,.3)!important}
 50%{background-position:100% 50%;box-shadow:0 0 0 3px rgba(190,255,226,.5),0 0 20px rgba(32,199,131,.95),0 0 38px rgba(32,199,131,.55)!important}
}
#public-plan-cards>.gf-plan-compact-card:not(.zc-plan-active-v3) .gf-plan-select-button{
 animation:none!important;filter:none!important;transform:none!important;
}
@media(prefers-reduced-motion:reduce){
 #public-plan-cards>.gf-plan-compact-card.zc-plan-active-v3::after,
 #public-plan-cards>.gf-plan-compact-card.zc-plan-active-v3 .gf-plan-select-button{animation:none!important}
}
</style>`

const SCRIPT = `<script id="${MARKER}-js">
(function(){
 if(window.__zcVisitorPlanFlowV2)return;
 window.__zcVisitorPlanFlowV2=true;
 var RAIL_ID='public-plan-cards',BUTTON='.gf-plan-select-button',CARD='.gf-plan-compact-card';
 var LEGACY=['is-scroll-active','is-selected','is-tap-selected','is-tap-focus','zc-plan-selected','zc-plan-auto-active-v9'];
 var pressedId='',frame=0,busy=false,boundRail=null,resizeObserver=null;
 var raf=window.requestAnimationFrame?window.requestAnimationFrame.bind(window):function(fn){return window.setTimeout(fn,16)};

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
   var list=cardsOf(r);
   if(pressedId&&!list.some(function(c){return c.getAttribute('data-gf-plan-id')===pressedId}))pressedId='';
   list.forEach(function(c){
    var on=!!pressedId&&c.getAttribute('data-gf-plan-id')===pressedId;
    LEGACY.forEach(function(cls){if(c.classList.contains(cls))c.classList.remove(cls)});
    c.classList.remove('zc-scroll-pressed');
    c.classList.toggle('zc-plan-active-v3',on);
    var button=c.querySelector(BUTTON);
    if(button){
     if(button.textContent.trim()!=='Choose plan')button.textContent='Choose plan';
     button.removeAttribute('aria-pressed');
    }
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
  if(card)press(card);
  if(!planButton(event.target))return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if(typeof window.showAuth==='function')window.showAuth('signup');
 },true);
 // Keyboard activation highlights the same plan as a pointer tap.
 document.addEventListener('keydown',function(event){
  if(event.key!=='Enter'&&event.key!==' ')return;
  var card=planCard(event.target);
  if(card)press(card);
  if(planButton(event.target))event.stopPropagation();
 },true);

 // 4. Scrolling a card into focus highlights it the same way.
 function update(){
  frame=0;
  var r=rail();
  if(!r)return;
  var cards=cardsOf(r),box=r.getBoundingClientRect(),active=null,best=Infinity;
  if(box.width<=0||box.bottom<=0||box.top>=window.innerHeight||!cards.length)return;
  var snapStart=box.left+r.clientLeft;
  cards.forEach(function(c){
   var b=c.getBoundingClientRect();
   if(b.width<=0||b.height<=0)return;
   var visibleW=Math.max(0,Math.min(b.right,box.right)-Math.max(b.left,box.left));
   if(visibleW<Math.min(20,b.width*.10))return;
   var d=Math.abs(b.left-snapStart);
   if(d<best){best=d;active=c}
  });
  if(active)press(active);
 }
 function schedule(){
  if(!frame)frame=raf(update);
 }
 function bind(){
  var r=rail();
  if(r&&r!==boundRail){
   boundRail=r;
   ['scroll','scrollend','touchend','pointerup','wheel','touchmove'].forEach(function(type){r.addEventListener(type,schedule,{passive:true})});
   document.addEventListener('scroll',schedule,{capture:true,passive:true});
   if('ResizeObserver'in window){resizeObserver=new ResizeObserver(schedule);resizeObserver.observe(r)}
   // Re-check when the data reloads or a plan card is replaced.
   new MutationObserver(function(){
    if(busy)return;
    paint();
    schedule();
   }).observe(r,{childList:true,subtree:true});
  }
  paint();
  schedule();
 }
 window.addEventListener('scroll',schedule,{passive:true});
 window.addEventListener('resize',schedule,{passive:true});
 window.addEventListener('orientationchange',schedule,{passive:true});
 window.addEventListener('pageshow',schedule,{passive:true});
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
