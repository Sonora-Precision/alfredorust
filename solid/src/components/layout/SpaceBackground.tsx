// The animated "space glass" backdrop: a fixed layer (z-0) behind all authed
// content. It renders the starfield / nebula / planets / satellite markup that
// styles/space-theme.css styles, then wires the JS-driven motion (parallax,
// shooting stars, twinkles, cursor glow, magnetic buttons, card edge-glow).
// Every listener/timer/rAF is torn down in onCleanup, and all motion is skipped
// when motionReduced() is true (CSS honours the same via the
// html:not(.force-motion) reduced-motion guard).
import { onCleanup, onMount } from 'solid-js'
import { Satellite } from 'lucide-solid'

import { motionReduced } from '../../lib/motion'

const SHOOTER_DIRS = [
  { angle: 22, x: [0, 32], y: [-6, 18] },
  { angle: -24, x: [0, 32], y: [55, 82] },
  { angle: 158, x: [62, 96], y: [-6, 22] },
  { angle: 202, x: [62, 96], y: [52, 80] },
]

export function SpaceBackground() {
  let root!: HTMLDivElement

  onMount(() => {
    const cleanups: Array<() => void> = []
    const timers: number[] = []
    let rafId = 0

    const bind = (
      target: EventTarget,
      type: string,
      handler: EventListener,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler, opts)
      cleanups.push(() => target.removeEventListener(type, handler, opts))
    }

    if (!motionReduced()) {
      // Twinkling stars
      const twinkles = root.querySelector('#twinkles')
      if (twinkles) {
        let html = ''
        for (let i = 0; i < 40; i++) {
          html += `<span class="twinkle" style="top:${(Math.random() * 100).toFixed(1)}%;left:${(
            Math.random() * 100
          ).toFixed(1)}%;animation-delay:${(Math.random() * 3.2).toFixed(2)}s"></span>`
        }
        twinkles.innerHTML = html
      }

      // Shooting stars from four varied directions (native WAAPI, no dep)
      const spawnShooter = () => {
        const el = document.createElement('div')
        el.className = 'shooter'
        const dir = SHOOTER_DIRS[Math.floor(Math.random() * SHOOTER_DIRS.length)]
        const angle = dir.angle + (Math.random() * 16 - 8)
        const len = 90 + Math.random() * 90
        const dist = 380 + Math.random() * 300
        const dur = 850 + Math.random() * 550
        el.style.width = `${len}px`
        el.style.left = `${dir.x[0] + Math.random() * (dir.x[1] - dir.x[0])}vw`
        el.style.top = `${dir.y[0] + Math.random() * (dir.y[1] - dir.y[0])}vh`
        root.appendChild(el)
        el.animate(
          [
            { opacity: 0, transform: `rotate(${angle}deg) translateX(0px) scaleX(.4)` },
            {
              opacity: 1,
              transform: `rotate(${angle}deg) translateX(${dist * 0.35}px) scaleX(1)`,
              offset: 0.5,
            },
            { opacity: 0, transform: `rotate(${angle}deg) translateX(${dist}px) scaleX(1)` },
          ],
          { duration: dur, easing: 'cubic-bezier(.3,0,.15,1)' },
        )
        timers.push(window.setTimeout(() => el.remove(), dur + 160))
      }
      const loopShooter = () => {
        spawnShooter()
        timers.push(window.setTimeout(loopShooter, 3800 + Math.random() * 5200))
      }
      timers.push(window.setTimeout(loopShooter, 1200))

      // Cursor glow + magnetic buttons + card edge-glow (single pointermove)
      const glow = root.querySelector<HTMLElement>('#cursorGlow')
      bind(document, 'pointermove', ((e: PointerEvent) => {
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
      bind(document, 'pointerout', ((e: PointerEvent) => {
        const magnetic = (e.target as Element | null)?.closest?.('.magnetic') as HTMLElement | null
        if (magnetic) magnetic.style.transform = ''
      }) as EventListener)

      // Parallax on the STAR layers only. A single rAF owns their transform, so
      // it never fights a CSS keyframe animation on the same property — that
      // double-ownership is what made the motion look "robotic". Planets and
      // asteroids keep their own CSS float (not touched here). The loop eases
      // toward the cursor and then SLEEPS once settled, so it costs nothing when
      // the pointer is idle (and stays asleep on touch devices with no hover).
      const layers: Array<{ el: HTMLElement; depth: number }> = []
      root.querySelectorAll<HTMLElement>('.stars').forEach((el, i) => layers.push({ el, depth: 10 + i * 12 }))
      const sky = root.querySelector<HTMLElement>('.sky')
      let tx = 0
      let ty = 0
      let cx = 0
      let cy = 0
      let running = false
      const tick = () => {
        cx += (tx - cx) * 0.08
        cy += (ty - cy) * 0.08
        for (const l of layers) {
          l.el.style.transform = `translate3d(${(-cx * l.depth).toFixed(2)}px, ${(-cy * l.depth).toFixed(2)}px, 0)`
        }
        if (Math.abs(tx - cx) < 0.0004 && Math.abs(ty - cy) < 0.0004) {
          running = false // settled → stop scheduling frames until the next input
          return
        }
        rafId = requestAnimationFrame(tick)
      }
      const wake = () => {
        if (!running) {
          running = true
          rafId = requestAnimationFrame(tick)
        }
      }
      bind(window, 'pointermove', ((e: PointerEvent) => {
        tx = (e.clientX / window.innerWidth - 0.5) * 2
        ty = (e.clientY / window.innerHeight - 0.5) * 2
        if (glow) {
          glow.style.opacity = '1'
          glow.style.left = `${e.clientX}px`
          glow.style.top = `${e.clientY}px`
        }
        wake()
      }) as EventListener)
      bind(window, 'pointerleave', (() => {
        if (glow) glow.style.opacity = '0'
      }) as EventListener)
      bind(
        window,
        'scroll',
        (() => {
          if (sky) sky.style.transform = `translateY(${window.scrollY * 0.06}px)`
        }) as EventListener,
        { passive: true },
      )
    }

    onCleanup(() => {
      cleanups.forEach((fn) => fn())
      timers.forEach((t) => clearTimeout(t))
      if (rafId) cancelAnimationFrame(rafId)
    })
  })

  return (
    <div id="space" ref={root} aria-hidden="true">
      <div class="sky" />
      <div class="aurora" />
      <div class="stars" />
      <div class="stars s2" />
      <div class="stars s3" />
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
      {/* Asteroid belt (top-left) */}
      <div class="floaty" style="position:absolute;top:8%;left:2%">
        <div class="asteroid" style="width:10px;height:8px;animation:asteroidDrift 9s ease-in-out infinite" />
      </div>
      <div class="floaty slow" style="position:absolute;top:14%;left:7%">
        <div class="asteroid" style="width:6px;height:5px;animation:asteroidDrift 12s ease-in-out infinite .8s" />
      </div>
      <div class="floaty" style="position:absolute;top:5%;left:11%">
        <div class="asteroid" style="width:14px;height:11px;animation:asteroidDrift 10.5s ease-in-out infinite .3s" />
      </div>
      <div class="floaty slow" style="position:absolute;top:18%;left:3.5%">
        <div class="asteroid" style="width:7px;height:6px;animation:asteroidDrift 8s ease-in-out infinite 1.2s" />
      </div>
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
      <div id="twinkles" />
      <div id="cursorGlow" style="position:absolute;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle, hsl(217 91% 60% / .10), transparent 70%);transform:translate(-50%,-50%);opacity:0;transition:opacity .4s ease" />
      <div id="satellite" style="position:absolute;top:14%;left:-6%;transform:rotate(-18deg);filter:drop-shadow(0 0 4px hsl(199 89% 70% / .8))">
        <Satellite style="width:28px;height:28px;color:hsl(199 60% 88%);opacity:.85" />
      </div>
    </div>
  )
}
