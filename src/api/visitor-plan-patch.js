'use strict';

/*
 * Visitor plan rail behaviour (injected by site.js when the page is served).
 *
 * - Scrolling or selecting a plan never changes the plan calculator.
 * - The plan button always reads "Choose plan".
 * - Clicking "Choose plan" opens Create account (with the Log in switch).
 * - The plan the visitor scrolls to is highlighted and its button glows
 *   immediately, as if it had just been pressed.
 */

const MARKER = 'zc-visitor-plan-flow-v1';

// Runs at the top of <head>, before the older swipe-selection script. That
// script checks this flag and skips itself, which stops it from relabelling
// the button "Selected" and from driving the calculator while scrolling.
const EARLY = '<script id="' + MARKER + '-early">window.__zcVisitorPlanSwipeSelectionV2=true;</script>';

const STYLE = `<style id="${MARKER}-css">
/* Card highlight for the plan the visitor has scrolled to. */
html body #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed.zc-scroll-pressed{
  border:2px solid rgba(104,255,190,.92)!important;
  box-shadow:0 0 0 1px rgba(104,255,190,.34),0 12px 34px rgba(25,214,139,.16)!important;
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

/* Glowing, pressed-looking button on the plan in view. No transition so it
   lights up the instant the plan is highlighted. */
html body #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed .gf-plan-select-button.gf-plan-select-button,
body[data-zc-theme] #public-plan-cards>.gf-plan-compact-card.zc-scroll-pressed .gf-plan-select-button.gf-plan-select-button{
  background:linear-gradient(135deg,color-mix(in srgb,var(--mint,#7cf0b8) 70%,var(--green,#20c783)),var(--green,#20c783))!important;
  border-color:var(--mint,#9be8c5)!important;
  color:#032116!important;
  box-shadow:0 0 0 2px color-mix(in srgb,var(--mint,#9be8c5) 40%,transparent),0 0 14px color-mix(in srgb,var(--green,#20c783) 80%,transparent),0 0 32px color-mix(in srgb,var(--green,#20c783) 48%,transparent),inset 0 2px 6px rgba(0,0,0,.28)!important;
  transform:translateY(1px)!important;
  filter:brightness(1.08)!important;
  transition:none!important;
}
</style>`;

const SCRIPT = `<script id="${MARKER}-js">
(function(){
 if(window.__zcVisitorPlanFlowV1)return;
 window.__zcVisitorPlanFlowV1=true;
 var RAIL_ID='public-plan-cards',BUTTON='.gf-plan-select-button';

 // 1. The visitor plan rail must never drive the calculator.
 var previousChoose=window.gfChoose;
 window.gfChoose=function(scope){
  if(scope==='pub')return;
  return typeof previousChoose==='function'?previousChoose.apply(this,arguments):undefined;
 };

 // 2. "Choose plan" opens Create account / Log in.
 function planButton(target){
  return target&&target.closest?target.closest('#'+RAIL_ID+' '+BUTTON):null;
 }
 document.addEventListener('click',function(event){
  if(!planButton(event.target))return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if(typeof window.showAuth==='function')window.showAuth('signup');
 },true);
 // Keep the card's own Enter/Space handler from swallowing the button's keys.
 document.addEventListener('keydown',function(event){
  if((event.key==='Enter'||event.key===' ')&&planButton(event.target))event.stopPropagation();
 },true);

 // 3. Highlight the plan in view and let its button glow straight away.
 var frame=0,boundRail=null;
 function rail(){return document.getElementById(RAIL_ID)}
 function update(){
  frame=0;
  var r=rail();
  if(!r)return;
  var cards=Array.prototype.filter.call(r.children,function(c){return c.classList&&c.classList.contains('gf-plan-compact-card')});
  var box=r.getBoundingClientRect(),active=null,best=Infinity;
  if(box.width>0){
   var centre=box.left+r.clientLeft+r.clientWidth/2;
   cards.forEach(function(c){
    var b=c.getBoundingClientRect();
    if(b.width<=0)return;
    var d=Math.abs((b.left+b.right)/2-centre);
    if(d<best){best=d;active=c}
   });
  }
  cards.forEach(function(c){c.classList.toggle('zc-scroll-pressed',c===active)});
 }
 function schedule(){if(!frame)frame=window.requestAnimationFrame(update)}
 function bind(){
  var r=rail();
  if(r&&r!==boundRail){
   boundRail=r;
   ['scroll','touchmove','wheel'].forEach(function(type){r.addEventListener(type,schedule,{passive:true})});
   new MutationObserver(schedule).observe(r,{childList:true});
  }
  schedule();
 }
 window.addEventListener('resize',schedule,{passive:true});
 window.addEventListener('orientationchange',schedule,{passive:true});
 window.addEventListener('load',bind);
 new MutationObserver(bind).observe(document.body,{childList:true,subtree:true});
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
