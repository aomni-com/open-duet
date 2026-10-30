'use client'

import Image from 'next/image'
import { useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { DARK_IMAGE_SOURCES } from '@/lib/dark-image-variants'

/**
 * Renders a light and dark variant of an image, toggling visibility
 * via Tailwind `dark:` utilities. The dark variant is derived by
 * inserting `-dark` before the file extension (e.g. cover.png ->
 * cover-dark.png). If the dark variant fails to load, falls back to
 * showing the light image in both modes.
 */
type ThemedImageProps = Omit<React.ComponentProps<typeof Image>, 'src'> & {
  src: string
}

function getDarkSrc(src: string): string {
  return src.replace(/\.(png|jpe?g|gif|webp)$/i, '-dark.$1')
}

export function ThemedImage({ src, className, alt, ...props }: ThemedImageProps) {
  const [darkFailed, setDarkFailed] = useState(false)
  const hasDark = DARK_IMAGE_SOURCES.has(src) && !darkFailed
  const darkSrc = getDarkSrc(src)

  return (
    <>
      <Image src={src} alt={alt} className={cn(className, hasDark && 'dark:hidden')} {...props} />
      {hasDark && (
        <Image
          src={darkSrc}
          alt={alt}
          className={cn(className, 'hidden dark:block')}
          onError={() => setDarkFailed(true)}
          {...props}
        />
      )}
    </>
  )
}
