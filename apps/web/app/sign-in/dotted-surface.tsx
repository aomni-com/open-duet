'use client'

import { useReducedMotion } from 'framer-motion'
import { useTheme } from 'next-themes'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'

const GRID_X = 44
const GRID_Z = 50

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uPointSize;
  uniform float uPixelRatio;

  varying float vFade;

  void main() {
    vec3 point = position;
    float firstWave = sin(point.x * 0.72 + uTime * 0.58) * 0.18;
    float secondWave = sin(point.z * 0.52 + uTime * 0.42) * 0.14;
    point.y += firstWave + secondWave;

    vec4 viewPosition = modelViewMatrix * vec4(point, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = uPointSize * uPixelRatio * (4.6 / -viewPosition.z);

    float edgeX = smoothstep(5.2, 3.5, abs(point.x));
    float edgeZ = smoothstep(5.8, 3.8, abs(point.z));
    vFade = edgeX * edgeZ;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vFade;

  void main() {
    float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
    float circle = 1.0 - smoothstep(0.34, 0.5, distanceToCenter);
    float alpha = circle * vFade * uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`

export function DottedSurface({ onReady }: { onReady: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reduceMotion = useReducedMotion()
  const { resolvedTheme } = useTheme()
  const darkMode = resolvedTheme === 'dark'

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: 'high-performance',
      })
    } catch {
      return
    }

    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25))
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 30)
    camera.position.set(0, 4.35, 6.7)
    camera.lookAt(0, -0.18, 0)

    const positions = new Float32Array(GRID_X * GRID_Z * 3)
    let offset = 0
    for (let xIndex = 0; xIndex < GRID_X; xIndex += 1) {
      for (let zIndex = 0; zIndex < GRID_Z; zIndex += 1) {
        positions[offset] = (xIndex / (GRID_X - 1) - 0.5) * 10.8
        positions[offset + 1] = 0
        positions[offset + 2] = (zIndex / (GRID_Z - 1) - 0.5) * 11.8
        offset += 3
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const uniforms = {
      uTime: { value: 0 },
      uPointSize: { value: darkMode ? 3.4 : 2.25 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uColor: { value: new THREE.Color(darkMode ? 0x9aa6b5 : 0x576779) },
      uOpacity: { value: darkMode ? 0.48 : 0.2 },
    }

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms,
    })
    const points = new THREE.Points(geometry, material)
    points.rotation.y = -0.08
    scene.add(points)

    let frame = 0
    let elapsed = 0
    let previousTime = performance.now()
    let running = false
    let inView = true
    let documentVisible = !document.hidden

    const render = () => {
      uniforms.uTime.value = reduceMotion === true ? 0 : elapsed
      renderer.render(scene, camera)
    }

    const tick = (time: number) => {
      if (!inView || !documentVisible || reduceMotion === true) {
        running = false
        return
      }
      frame = window.requestAnimationFrame(tick)
      elapsed += Math.min((time - previousTime) / 1000, 0.05)
      previousTime = time
      render()
    }

    const start = () => {
      if (running || reduceMotion === true || !inView || !documentVisible) return
      running = true
      previousTime = performance.now()
      frame = window.requestAnimationFrame(tick)
    }

    const resize = () => {
      const { width, height } = container.getBoundingClientRect()
      if (width === 0 || height === 0) return
      renderer.setSize(width, height, false)
      uniforms.uPixelRatio.value = renderer.getPixelRatio()
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      render()
    }

    const onVisibilityChange = () => {
      documentVisible = !document.hidden
      if (documentVisible) start()
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    const intersectionObserver = new IntersectionObserver(entries => {
      inView = entries[0]?.isIntersecting ?? false
      if (inView) start()
    })
    intersectionObserver.observe(container)
    document.addEventListener('visibilitychange', onVisibilityChange)

    resize()
    onReady()
    start()

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
    }
  }, [darkMode, onReady, reduceMotion])

  return (
    <div ref={containerRef} className="size-full min-h-[24rem] xl:min-h-[27rem]">
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none size-full" />
    </div>
  )
}
