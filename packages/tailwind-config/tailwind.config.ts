import containerQueries from '@tailwindcss/container-queries'
import typography from '@tailwindcss/typography'
import scrollbar from 'tailwind-scrollbar'
import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'
import colors from 'tailwindcss/colors'
import plugin from 'tailwindcss/plugin'

import { screens } from './screens'

const oklch = (variable: string) => `oklch(var(${variable}) / <alpha-value>)`

const config: Config = {
  darkMode: ['class'],
  content: [
    'app/**/*.{ts,tsx}',
    'spa/**/*.{ts,tsx}',
    'constants/**/*.{ts,tsx}',
    'components/**/*.{ts,tsx}',
    '../../packages/ui/src/components/**/*.{ts,tsx}',
    '../../packages/ui/src/lib/**/*.{ts,tsx}',
  ],
  theme: {
    screens,
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['var(--font-serif)', 'ui-serif', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        border: oklch('--border'),
        input: oklch('--input'),
        ring: oklch('--ring'),
        background: oklch('--background'),
        foreground: oklch('--foreground'),
        primary: {
          DEFAULT: oklch('--primary'),
          foreground: oklch('--primary-foreground'),
        },
        secondary: {
          DEFAULT: oklch('--secondary'),
          foreground: oklch('--secondary-foreground'),
        },
        destructive: {
          DEFAULT: oklch('--destructive'),
          foreground: oklch('--destructive-foreground'),
        },
        muted: {
          DEFAULT: oklch('--muted'),
          foreground: oklch('--muted-foreground'),
        },
        accent: {
          DEFAULT: oklch('--accent'),
          foreground: oklch('--accent-foreground'),
        },
        // Work state: in flight, waiting on the reader, unread (see globals.css).
        live: 'hsl(var(--live))',
        ask: 'hsl(var(--ask))',
        unread: 'hsl(var(--unread))',
        brand: {
          DEFAULT: 'hsl(var(--brand))',
          foreground: 'hsl(var(--brand-foreground))',
          subtle: 'hsl(var(--brand) / var(--brand-subtle-alpha))',
        },
        popover: {
          DEFAULT: oklch('--popover'),
          foreground: oklch('--popover-foreground'),
        },
        card: {
          DEFAULT: oklch('--card'),
          foreground: oklch('--card-foreground'),
        },
        header: {
          DEFAULT: oklch('--header'),
          foreground: oklch('--header-foreground'),
          accent: oklch('--header-accent'),
          'accent-foreground': oklch('--header-accent-foreground'),
          border: oklch('--header-border'),
          ring: oklch('--header-ring'),
        },
        sidebar: {
          DEFAULT: oklch('--sidebar'),
          foreground: oklch('--sidebar-foreground'),
          primary: oklch('--sidebar-primary'),
          'primary-foreground': oklch('--sidebar-primary-foreground'),
          accent: oklch('--sidebar-accent'),
          'accent-foreground': oklch('--sidebar-accent-foreground'),
          border: oklch('--sidebar-border'),
          ring: oklch('--sidebar-ring'),
        },
        // Chart colors for data visualization
        chart: {
          1: oklch('--chart-1'),
          2: oklch('--chart-2'),
          3: oklch('--chart-3'),
          4: oklch('--chart-4'),
          5: oklch('--chart-5'),
        },
        // Success colors for compatibility
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
      },
      boxShadow: {
        '2xs': 'var(--shadow-2xs)',
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        '2xl': 'var(--shadow-2xl)',
      },
      backgroundImage: {
        'gradient-primary': `linear-gradient(to right, ${colors.violet[500]}, ${colors.blue[400]}, ${colors.indigo[700]})`,
        'gradient-grayscale': `linear-gradient(to bottom, ${colors.gray[400]}, ${colors.gray[500]}, ${colors.gray[950]}, ${colors.black})`,
      },
      keyframes: {
        aurora: {
          from: {
            backgroundPosition: '50% 50%, 50% 50%',
          },
          to: {
            backgroundPosition: '350% 50%, 350% 50%',
          },
        },
        'gradient-rotate': {
          '0%, 100%': { backgroundPosition: '0% 0%' },
          '50%': { backgroundPosition: '100% 100%' },
        },
        /* A document arriving into room a listing has just given up. Opacity and
           transform only: the width it lands in is the listing's business, and
           animating both would be two things competing for the same pixels. */
        'document-in': {
          from: { opacity: '0', transform: 'translateX(10px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        wiggle: {
          '0%, 100%': { transform: 'rotate(-12deg)' },
          '50%': { transform: 'rotate(12deg)' },
        },
        marquee: {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(calc(-100% - var(--gap)))' },
        },
        'marquee-vertical': {
          from: { transform: 'translateY(0)' },
          to: { transform: 'translateY(calc(-100% - var(--gap)))' },
        },
        blob: {
          '0%': {
            transform: 'translate(0px, 0px) scale(1)',
          },
          '33%': {
            transform: 'translate(30px, -50px) scale(1.1)',
          },
          '66%': {
            transform: 'translate(-20px, 20px) scale(0.9)',
          },
          '100%': {
            transform: 'translate(0px, 0px) scale(1)',
          },
        },
        'border-beam': {
          '0%': { offsetDistance: '0%' },
          '100%': { offsetDistance: '100%' },
        },
        fadeOut: {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        highlight: {
          '0%': { opacity: '0.65' },
          '100%': { opacity: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { transform: 'scale(0.85)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
        'count-change': {
          '0%': { transform: 'scale(1.5)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        aurora: 'aurora 60s linear infinite',
        'gradient-rotate': 'gradient-rotate 2s ease-in-out infinite',
        wiggle: 'wiggle 0.3s steps(5, jump-both)',
        marquee: 'marquee var(--duration) linear infinite',
        'marquee-vertical': 'marquee-vertical var(--duration) linear infinite',
        blob: 'blob 7s infinite',
        'animation-delay-2000': 'blob 7s infinite 2s',
        'animation-delay-4000': 'blob 7s infinite 4s',
        'border-beam': 'border-beam calc(var(--duration)*1s) linear infinite',
        highlight: 'highlight 1.5s ease-out forwards',
        'fade-in': 'fade-in 0.2s ease-in-out',
        'scale-in': 'scale-in 0.2s ease-out',
        'count-change': 'count-change 0.12s cubic-bezier(0.26, 0.8, 0.34, 1)',
        /* Same curve as the listing's width beside it, started a beat later and
           filling backwards so it holds at zero through the delay. The order is
           the point: the listing gives up the room *first*, and the document
           arrives into room the reader has already watched open. Landed
           together they read as two things that both happened; staggered they
           read as one thing causing another. */
        'document-in': 'document-in 0.26s cubic-bezier(0.32, 0.72, 0, 1) 0.07s both',
      },
    },
  },
  plugins: [
    tailwindcssAnimate,
    typography,
    scrollbar,
    containerQueries,
    plugin(({ addUtilities }) => {
      addUtilities({
        '.debug': {
          border: '1px solid red',
        },
      })
    }),
    plugin(({ addUtilities }) => {
      addUtilities({
        '.highlight-white': {
          'box-shadow': 'inset 0 1px 0 0 hsla(0, 0%, 100%, 5%)',
        },
      })
    }),
    plugin(({ addUtilities, theme }) => {
      const newUtilities = {
        '.text-gradient-grayscale': {
          background: theme('backgroundImage.gradient-grayscale'),
          'background-clip': 'text',
          '-webkit-background-clip': 'text',
          color: 'transparent',
        },
      } as any
      addUtilities(newUtilities)
    }),
  ],
} satisfies Config

export default config
