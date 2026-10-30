'use client'

import { Check, Code, Link as LinkIcon, LinkedinLogo, XLogo } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/shadcn/tooltip'
import { cn } from '@repo/ui/lib/utils'

type SocialShareProps = {
  title: string
  url: string
  content?: string
  className?: string
}

export function SocialShare({ title, url, content, className }: SocialShareProps) {
  const t = useTranslations('blogUi')
  const [copied, setCopied] = useState(false)
  const [agentCopied, setAgentCopied] = useState(false)

  const encodedTitle = encodeURIComponent(title)
  const encodedUrl = encodeURIComponent(url)

  const twitterUrl = `https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`

  const agentPrompt = `Read this article and give me a summary: ${url}

I want a one paragraph overview followed by bullet points of the key takeaways. Assume I have no context. After that, offer to dive deeper into any section.`
  const claudeUrl = `https://claude.ai/new?q=${encodeURIComponent(agentPrompt)}`
  const chatgptUrl = `https://chatgpt.com/?q=${encodeURIComponent(agentPrompt)}`

  const openInNewTab = (shareUrl: string) => {
    window.open(shareUrl, '_blank', 'noopener,noreferrer')
  }

  const copyForAgent = async () => {
    try {
      const markdownContent = `# ${title}\n\n${content ?? ''}`
      await navigator.clipboard.writeText(markdownContent)
      setAgentCopied(true)
      setTimeout(() => setAgentCopied(false), 2000)
    } catch {
      setAgentCopied(true)
      setTimeout(() => setAgentCopied(false), 2000)
    }
  }

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea')
      textArea.value = url
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className={cn('flex items-center gap-1 sm:gap-3', className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-lv2-muted hover:bg-[color:var(--lv2-line)] hover:text-[color:var(--lv2-fg)] [&_svg]:size-6 sm:h-11 sm:w-11 sm:[&_svg]:size-7"
            onClick={() => openInNewTab(twitterUrl)}
            aria-label={t('shareOnX')}
          >
            <XLogo className="h-7 w-7" weight="fill" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('shareOnX')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-lv2-muted hover:bg-[color:var(--lv2-line)] hover:text-[color:var(--lv2-fg)] [&_svg]:size-6 sm:h-11 sm:w-11 sm:[&_svg]:size-7"
            onClick={() => openInNewTab(linkedinUrl)}
            aria-label={t('shareOnLinkedIn')}
          >
            <LinkedinLogo className="h-7 w-7" weight="fill" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('shareOnLinkedIn')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-lv2-muted hover:bg-[color:var(--lv2-line)] hover:text-[color:var(--lv2-fg)] [&_svg]:size-6 sm:h-11 sm:w-11 sm:[&_svg]:size-7"
            onClick={copyToClipboard}
            aria-label={t('copyLink')}
          >
            {copied ? (
              <Check className="h-7 w-7 text-green-400" weight="bold" />
            ) : (
              <LinkIcon className="h-7 w-7" weight="bold" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? t('copied') : t('copyLink')}</TooltipContent>
      </Tooltip>

      {content && (
        <>
          <div className="mx-1 h-7 w-px bg-white/20 sm:mx-2" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-lv2-muted hover:bg-[color:var(--lv2-line)] hover:text-[color:var(--lv2-fg)] [&_svg]:size-6 sm:h-11 sm:w-11 sm:[&_svg]:size-7"
                onClick={() => openInNewTab(claudeUrl)}
                aria-label={t('readWithClaude')}
              >
                <Image
                  src="/landing/integrations/claude.png"
                  alt="Claude"
                  width={32}
                  height={32}
                  className="rounded-sm grayscale dark:brightness-150 dark:contrast-125"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('readWithClaude')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-lv2-muted hover:bg-[color:var(--lv2-line)] hover:text-[color:var(--lv2-fg)] [&_svg]:size-6 sm:h-11 sm:w-11 sm:[&_svg]:size-7"
                onClick={() => openInNewTab(chatgptUrl)}
                aria-label={t('readWithChatGPT')}
              >
                <Image
                  src="/landing/integrations/openai.webp"
                  alt="ChatGPT"
                  width={32}
                  height={32}
                  className="rounded-sm grayscale opacity-85 dark:invert"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('readWithChatGPT')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-lv2-muted hover:bg-[color:var(--lv2-line)] hover:text-[color:var(--lv2-fg)] [&_svg]:size-6 sm:h-11 sm:w-11 sm:[&_svg]:size-7"
                onClick={copyForAgent}
                aria-label={t('copyForAgent')}
              >
                {agentCopied ? (
                  <Check className="h-7 w-7 text-green-400" weight="bold" />
                ) : (
                  <Code className="h-7 w-7" weight="bold" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{agentCopied ? t('copied') : t('copyForAgent')}</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  )
}
