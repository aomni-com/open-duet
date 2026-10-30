'use client'

import { ThemeProvider } from 'next-themes'

import { TooltipProvider } from '@repo/ui/components/shadcn/tooltip'

export function ProductProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider>{children}</TooltipProvider>
    </ThemeProvider>
  )
}
