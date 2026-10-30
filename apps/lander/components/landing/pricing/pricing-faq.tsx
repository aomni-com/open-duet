'use client'

import { useTranslations } from 'next-intl'

import BlurFade from '@repo/ui/components/magicui/blur-fade'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@repo/ui/components/shadcn/accordion'

import { serifStyle } from '@/components/landing/landing-styles'

export function PricingFaq() {
  const t = useTranslations('pricingPage.faq')
  const faqs = [
    { question: t('q1'), answer: t('a1') },
    { question: t('q2'), answer: t('a2') },
    { question: t('q3'), answer: t('a3') },
    { question: t('q4'), answer: t('a4') },
    { question: t('q5'), answer: t('a5') },
    { question: t('q6'), answer: t('a6') },
    { question: t('q7'), answer: t('a7') },
  ]
  return (
    <section className="border-t border-white/10 px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <BlurFade delay={0.08} inView>
          <div className="mb-12 text-center">
            <p className="mb-4 text-[11px] uppercase tracking-[0.3em] text-white/55">
              {t('eyebrow')}
            </p>
            <h2
              className="text-4xl font-normal leading-[1.05] tracking-[-0.75px] text-white sm:text-5xl"
              style={serifStyle}
            >
              {t('heading')}
            </h2>
          </div>
        </BlurFade>

        <BlurFade delay={0.1} inView className="flex flex-col items-center">
          <Accordion type="single" collapsible className="w-full max-w-3xl">
            {faqs.map((faq, idx) => (
              <AccordionItem
                key={faq.question}
                value={`faq-${idx}`}
                className="liquid-glass mb-3 rounded-2xl border-0 px-5"
              >
                <AccordionTrigger
                  className="py-5 text-left text-base text-white hover:text-white hover:no-underline md:text-lg"
                  style={serifStyle}
                >
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="pb-5 text-white/75">{faq.answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </BlurFade>
      </div>
    </section>
  )
}
