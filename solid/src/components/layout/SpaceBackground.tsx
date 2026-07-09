// The "space glass" backdrop: a fixed layer (z-0) behind all authed content.
// Stars are generated individually with random position / size / brightness /
// bloom (no tiled pattern, no clutter), a subset twinkles, and shooting stars
// cross occasionally. The nebula/aurora/planets are static (cheap). No pointer
// parallax — moving the whole field behind the frosted-glass cards forced a
// per-frame re-blur that felt laggy. All motion is skipped under motionReduced()
// (CSS honours the same via the html:not(.force-motion) reduced-motion guard).
import { onCleanup, onMount } from 'solid-js'
import { Satellite } from 'lucide-solid'

import { motionReduced } from '../../lib/motion'

const SHOOTER_DIRS = [
  { angle: 22, x: [0, 32], y: [-6, 18] },
  { angle: -24, x: [0, 32], y: [55, 82] },
  { angle: 158, x: [62, 96], y: [-6, 22] },
  { angle: 202, x: [62, 96], y: [52, 80] },
]

// A few tints so stars aren't all the same white — cool blues, warm gold, violet.
const STAR_TINTS = ['255,255,255', '180,210,255', '255,228,170', '210,185,255', '165,230,255']
const STAR_COUNT = 66
const STAR_TRAVELERS = 7 // stars that visibly glide across, satellite-style

function buildStars(): string {
  const rnd = Math.random
  const pick = () => STAR_TINTS[Math.floor(rnd() * STAR_TINTS.length)]
  let html = ''
  // Static + twinkling field.
  for (let i = 0; i < STAR_COUNT; i++) {
    const bright = rnd() < 0.12 // larger/brighter "hero" stars
    const size = bright ? 3 + rnd() * 1.8 : 1.2 + rnd() * 1.8
    const op = bright ? 0.85 + rnd() * 0.15 : 0.3 + rnd() * 0.55
    const bloom = bright ? 6 + rnd() * 8 : 1.5 + rnd() * 4
    const c = pick()
    const motion = rnd() < 0.4 ? `animation:twinkle ${(2.6 + rnd() * 3.5).toFixed(1)}s ease-in-out ${(rnd() * 4).toFixed(1)}s infinite;` : ''
    html +=
      `<span style="position:absolute;left:${(rnd() * 100).toFixed(2)}%;top:${(rnd() * 100).toFixed(2)}%;` +
      `width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;border-radius:50%;` +
      `background:rgba(${c},${op.toFixed(2)});box-shadow:0 0 ${bloom.toFixed(1)}px rgba(${c},${(op * 0.8).toFixed(2)});${motion}"></span>`
  }

  // A few "traveling" stars that visibly glide across the screen, like the
  // satellite: each is one small element moving via its own linear transform
  // (cheap). Starts off one edge and ends off the other, so the loop reset
  // happens off-screen (no jump). Negative delay spreads them out immediately.
  for (let i = 0; i < STAR_TRAVELERS; i++) {
    const c = pick()
    const size = (1.8 + rnd() * 1.8).toFixed(1)
    const op = (0.7 + rnd() * 0.3).toFixed(2)
    const bloom = (4 + rnd() * 6).toFixed(1)
    const top = (4 + rnd() * 86).toFixed(1)
    const rtl = rnd() < 0.5
    const startLeft = rtl ? '106%' : '-6%'
    const dx = rtl ? '-118vw' : '118vw'
    const dy = `${((rnd() * 2 - 1) * 16).toFixed(1)}vh`
    const dur = 26 + rnd() * 30 // ~satellite pace across the viewport
    const delay = (-rnd() * dur).toFixed(1)
    html +=
      `<span style="position:absolute;left:${startLeft};top:${top}%;` +
      `width:${size}px;height:${size}px;border-radius:50%;` +
      `background:rgba(${c},${op});box-shadow:0 0 ${bloom}px rgba(${c},${(Number(op) * 0.8).toFixed(2)});` +
      `--dx:${dx};--dy:${dy};animation:starDrift ${dur.toFixed(1)}s linear ${delay}s infinite;"></span>`
  }
  return html
}

export function SpaceBackground() {
  let root!: HTMLDivElement

  onMount(() => {
    const cleanups: Array<() => void> = []
    const timers: number[] = []
    const bind = (target: EventTarget, type: string, handler: EventListener, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, handler, opts)
      cleanups.push(() => target.removeEventListener(type, handler, opts))
    }

    // Stars are rendered even under reduced motion (they just don't twinkle —
    // the global reduced-motion rule freezes the inline animations).
    const starfield = root.querySelector('#starfield')
    if (starfield) starfield.innerHTML = buildStars()

    // Launch a shooting star from (leftCss, topCss) at `angle`, with the given
    // length/travel/duration. fill:forwards holds the final (invisible) frame so
    // it can't flash back to its base style at the start position when it ends.
    const launchShooter = (
      leftCss: string,
      topCss: string,
      angle: number,
      len: number,
      dist: number,
      dur: number,
    ): void => {
      const el = document.createElement('div')
      el.className = 'shooter'
      el.style.width = `${len}px`
      el.style.left = leftCss
      el.style.top = topCss
      root.appendChild(el)
      const anim = el.animate(
        [
          { opacity: 0, transform: `rotate(${angle}deg) translateX(0px) scaleX(.4)` },
          { opacity: 1, transform: `rotate(${angle}deg) translateX(${dist * 0.35}px) scaleX(1)`, offset: 0.5 },
          { opacity: 0, transform: `rotate(${angle}deg) translateX(${dist}px) scaleX(1)` },
        ],
        { duration: dur, easing: 'cubic-bezier(.3,0,.15,1)', fill: 'forwards' },
      )
      anim.onfinish = () => el.remove()
      timers.push(window.setTimeout(() => el.remove(), dur + 250)) // safety net for cleanup
    }

    // Click on empty background → a shooting star from the click point in a
    // random direction/size. Deliberate action, so it runs even under reduced
    // motion; ignore clicks on interactive UI.
    const INTERACTIVE =
      'a, button, input, select, textarea, label, [role="button"], [role="tab"], [role="menuitem"], [role="dialog"], [contenteditable]'
    bind(document, 'click', ((e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.(INTERACTIVE)) return
      launchShooter(
        `${e.clientX}px`,
        `${e.clientY}px`,
        Math.random() * 360,
        80 + Math.random() * 120,
        300 + Math.random() * 380,
        700 + Math.random() * 700,
      )
    }) as EventListener)

    if (!motionReduced()) {
      // Ambient shooting stars from four varied directions.
      const spawnShooter = () => {
        const dir = SHOOTER_DIRS[Math.floor(Math.random() * SHOOTER_DIRS.length)]
        launchShooter(
          `${dir.x[0] + Math.random() * (dir.x[1] - dir.x[0])}vw`,
          `${dir.y[0] + Math.random() * (dir.y[1] - dir.y[0])}vh`,
          dir.angle + (Math.random() * 16 - 8),
          90 + Math.random() * 90,
          380 + Math.random() * 300,
          850 + Math.random() * 550,
        )
      }
      const loopShooter = () => {
        spawnShooter()
        timers.push(window.setTimeout(loopShooter, 4500 + Math.random() * 6000))
      }
      timers.push(window.setTimeout(loopShooter, 1500))

      // Cursor glow + magnetic buttons + card edge-glow (single pointermove).
      const glow = root.querySelector<HTMLElement>('#cursorGlow')
      bind(document, 'pointermove', ((e: PointerEvent) => {
        if (glow) {
          glow.style.opacity = '1'
          glow.style.left = `${e.clientX}px`
          glow.style.top = `${e.clientY}px`
        }
        const el = e.target as Element | null
        const magnetic = el?.closest?.('.magnetic') as HTMLElement | null
        if (magnetic) {
          const r = magnetic.getBoundingClientRect()
          const mx = (e.clientX - (r.left + r.width / 2)) / r.width
          const my = (e.clientY - (r.top + r.height / 2)) / r.height
          magnetic.style.transform = `translate(${(mx * 7).toFixed(1)}px, ${(my * 7).toFixed(1)}px)`
        }
        const card = el?.closest?.('.glow-edge') as HTMLElement | null
        if (card) {
          const r = card.getBoundingClientRect()
          card.style.setProperty('--mx', `${e.clientX - r.left}px`)
          card.style.setProperty('--my', `${e.clientY - r.top}px`)
        }
      }) as EventListener)
      bind(window, 'pointerleave', (() => {
        if (glow) glow.style.opacity = '0'
      }) as EventListener)
      bind(document, 'pointerout', ((e: PointerEvent) => {
        const magnetic = (e.target as Element | null)?.closest?.('.magnetic') as HTMLElement | null
        if (magnetic) magnetic.style.transform = ''
      }) as EventListener)
    }

    onCleanup(() => {
      cleanups.forEach((fn) => fn())
      timers.forEach((t) => clearTimeout(t))
    })
  })

  return (
    <div id="space" ref={root} aria-hidden="true">
      <div class="sky" />
      <div class="aurora" />
      <div id="starfield" />
      {/* Constellations (thin SVG lines between stars) */}
      <svg class="constellation" style="position:absolute;top:6%;left:58%;width:260px;height:170px" viewBox="0 0 260 170">
        <g class="cline" fill="none" stroke="hsl(199 89% 75%)" stroke-width="2">
          <line x1="12" y1="120" x2="70" y2="60" />
          <line x1="70" y1="60" x2="140" y2="80" />
          <line x1="140" y1="80" x2="205" y2="30" />
          <line x1="140" y1="80" x2="170" y2="140" />
        </g>
        <g class="cdot" fill="hsl(var(--foreground))">
          <circle cx="12" cy="120" r="3.6" />
          <circle cx="70" cy="60" r="4.2" />
          <circle cx="140" cy="80" r="3.6" />
          <circle cx="205" cy="30" r="3.8" />
          <circle cx="170" cy="140" r="3.4" />
        </g>
      </svg>
      <svg class="constellation" style="position:absolute;bottom:8%;left:10%;width:200px;height:130px" viewBox="0 0 200 130">
        <g class="cline" fill="none" stroke="hsl(199 89% 75%)" stroke-width="2">
          <line x1="10" y1="20" x2="60" y2="55" />
          <line x1="60" y1="55" x2="120" y2="40" />
          <line x1="120" y1="40" x2="180" y2="90" />
        </g>
        <g class="cdot" fill="hsl(var(--foreground))">
          <circle cx="10" cy="20" r="3.4" />
          <circle cx="60" cy="55" r="4" />
          <circle cx="120" cy="40" r="3.6" />
          <circle cx="180" cy="90" r="3.8" />
        </g>
      </svg>
      {/* Ringed planet (top-right) */}
      <div class="floaty slow" style="position:absolute;top:88px;right:-30px">
        <div class="planet" style="width:120px;height:120px;background:radial-gradient(circle at 32% 28%, hsl(217 91% 68%), hsl(217 80% 42%) 70%, hsl(222 60% 24%));opacity:.7;box-shadow:0 0 60px hsl(217 91% 60% / .35)" />
      </div>
      {/* Small planet (bottom-left) */}
      <div class="floaty" style="position:absolute;bottom:60px;left:-24px">
        <div class="planet-glow" style="width:72px;height:72px;background:radial-gradient(circle at 36% 30%, hsl(38 95% 70%), hsl(24 85% 48%) 72%, hsl(14 70% 30%));opacity:.6;box-shadow:0 0 44px hsl(38 92% 55% / .4)" />
      </div>
      {/* Distant moon (center-right) */}
      <div class="floaty slow" style="position:absolute;top:52%;right:6%">
        <div class="planet-glow" style="width:26px;height:26px;background:radial-gradient(circle at 35% 30%, hsl(199 60% 90%), hsl(210 30% 62%));opacity:.5" />
      </div>
      <div id="cursorGlow" style="position:absolute;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle, hsl(217 91% 60% / .10), transparent 70%);transform:translate(-50%,-50%);opacity:0;transition:opacity .4s ease" />
      <div id="satellite" style="position:absolute;top:14%;left:-6%;transform:rotate(-18deg);filter:drop-shadow(0 0 4px hsl(199 89% 70% / .8))">
        <Satellite style="width:28px;height:28px;color:hsl(199 60% 88%);opacity:.85" />
      </div>
    </div>
  )
}
