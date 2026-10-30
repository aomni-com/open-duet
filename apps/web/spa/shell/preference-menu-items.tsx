'use client'

import { Desktop, Globe, Moon, SignOut, Sun } from '@phosphor-icons/react'
import { useLocale, useTranslations } from 'next-intl'
import { useTheme } from 'next-themes'

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import type { DuetLocale } from '@repo/web-locale'

/**
 * The preference tail shared by every account-ish menu: Theme and Language
 * submenus, then Sign out. Renders inside a `DropdownMenuContent`; the host
 * menu owns its trigger and whatever items come before these, and may slot
 * host-specific items between Language and Sign out via `children`.
 */
export function PreferenceMenuItems({
  onLocale,
  onLogout,
  children,
}: {
  onLocale(locale: DuetLocale): void
  onLogout(): void
  children?: React.ReactNode
}) {
  const t = useTranslations('duetApp')
  const locale = useLocale()
  const { setTheme, theme } = useTheme()
  const selectedTheme = theme === 'light' || theme === 'dark' ? theme : 'system'
  const ThemeIcon = selectedTheme === 'light' ? Sun : selectedTheme === 'dark' ? Moon : Desktop
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <ThemeIcon aria-hidden size={17} />
          <span>{t('theme')}</span>
          <DropdownMenuShortcut className="normal-case tracking-normal opacity-60">
            {t(selectedTheme)}
          </DropdownMenuShortcut>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent sideOffset={8} className="w-44">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t('theme')}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={selectedTheme} onValueChange={setTheme}>
            <DropdownMenuRadioItem value="light" className="gap-1.5">
              <Sun aria-hidden size={16} />
              {t('light')}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark" className="gap-1.5">
              <Moon aria-hidden size={16} />
              {t('dark')}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system" className="gap-1.5">
              <Desktop aria-hidden size={16} />
              {t('system')}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Globe aria-hidden size={17} />
          <span>{t('language')}</span>
          <DropdownMenuShortcut className="normal-case tracking-normal opacity-60">
            {locale === 'es-419' ? t('spanish') : t('english')}
          </DropdownMenuShortcut>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent sideOffset={8} className="w-44">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t('language')}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={locale === 'es-419' ? 'es-419' : 'en'}
            onValueChange={value => onLocale(value as DuetLocale)}
          >
            <DropdownMenuRadioItem value="en">{t('english')}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="es-419">{t('spanish')}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {children}
      <DropdownMenuItem onSelect={onLogout}>
        <SignOut size={17} /> {t('signOut')}
      </DropdownMenuItem>
    </>
  )
}
