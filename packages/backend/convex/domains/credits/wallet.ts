import type { SubscriptionPlanId, TransactionType } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { creditTransactionMetadata, metadataContext } from './metadata'
import { insertCreditTransaction } from './storage'
import { transactionByReference } from './transactionByReference'
import { bindCreditTransactionPagination } from './transactionPagination'

export interface Wallet {
  paidMicroUsd: number
  monthlyMicroUsd: number
}

export interface WalletAllocation {
  monthlyDebitMicroUsd: number
  paidDebitMicroUsd: number
  monthlyCreditEpoch?: string
}

export interface WalletLedgerAmounts {
  monthlyAmountMicroUsd: number
  paidAmountMicroUsd: number
}

export interface ReservationWalletAdjustment {
  balances: Wallet
  actualAmounts: WalletLedgerAmounts
  forfeitedMonthlyMicroUsd: number
  walletDeltaMicroUsd: number
}

export function allocateSpend(
  wallet: Wallet,
  debitMicroUsd: number,
): { monthlyDebitMicroUsd: number; paidDebitMicroUsd: number } {
  const monthlyDebitMicroUsd = Math.min(wallet.monthlyMicroUsd, debitMicroUsd)
  return {
    monthlyDebitMicroUsd,
    paidDebitMicroUsd: debitMicroUsd - monthlyDebitMicroUsd,
  }
}

export function reservationAllocationForSpend(
  user: Doc<'users'>,
  debitMicroUsd: number,
): WalletAllocation {
  return {
    ...allocateSpend(walletOf(user), debitMicroUsd),
    ...(user.billing?.monthlyCreditEpoch === undefined
      ? {}
      : { monthlyCreditEpoch: user.billing.monthlyCreditEpoch }),
  }
}

export function walletLedgerAmountsForDebit(
  allocation: Pick<WalletAllocation, 'monthlyDebitMicroUsd' | 'paidDebitMicroUsd'>,
): WalletLedgerAmounts {
  return {
    monthlyAmountMicroUsd: negateWithoutNegativeZero(allocation.monthlyDebitMicroUsd),
    paidAmountMicroUsd: negateWithoutNegativeZero(allocation.paidDebitMicroUsd),
  }
}

export async function adjustWalletForReservationWithDb(
  ctx: Pick<MutationCtx, 'db'>,
  user: Doc<'users'>,
  args: { allocation: WalletAllocation; actualCostMicroUsd: number },
): Promise<ReservationWalletAdjustment> {
  const { allocation } = args
  if (
    allocation.monthlyDebitMicroUsd < 0 ||
    allocation.paidDebitMicroUsd < 0 ||
    args.actualCostMicroUsd < 0
  ) {
    throw new Error('Reservation wallet amounts must be nonnegative')
  }

  const heldMicroUsd = allocation.monthlyDebitMicroUsd + allocation.paidDebitMicroUsd
  const heldActualMicroUsd = Math.min(heldMicroUsd, args.actualCostMicroUsd)
  const heldMonthlyActualMicroUsd = Math.min(allocation.monthlyDebitMicroUsd, heldActualMicroUsd)
  const heldPaidActualMicroUsd = heldActualMicroUsd - heldMonthlyActualMicroUsd
  const refundableMonthlyMicroUsd = allocation.monthlyDebitMicroUsd - heldMonthlyActualMicroUsd
  const refundedPaidMicroUsd = allocation.paidDebitMicroUsd - heldPaidActualMicroUsd
  const sameEpoch = allocation.monthlyCreditEpoch === user.billing?.monthlyCreditEpoch
  const refundedMonthlyMicroUsd = sameEpoch ? refundableMonthlyMicroUsd : 0
  const forfeitedMonthlyMicroUsd = sameEpoch ? 0 : refundableMonthlyMicroUsd
  const excessAllocation = allocateSpend(
    walletOf(user),
    Math.max(0, args.actualCostMicroUsd - heldMicroUsd),
  )
  const current = walletOf(user)
  const balances = {
    paidMicroUsd: current.paidMicroUsd + refundedPaidMicroUsd - excessAllocation.paidDebitMicroUsd,
    monthlyMicroUsd:
      current.monthlyMicroUsd + refundedMonthlyMicroUsd - excessAllocation.monthlyDebitMicroUsd,
  }
  if (balances.monthlyMicroUsd < 0) throw new Error('Monthly credit balance cannot be negative')
  await writeWallet(ctx, user, balances)

  return {
    balances,
    actualAmounts: walletLedgerAmountsForDebit({
      monthlyDebitMicroUsd: heldMonthlyActualMicroUsd + excessAllocation.monthlyDebitMicroUsd,
      paidDebitMicroUsd: heldPaidActualMicroUsd + excessAllocation.paidDebitMicroUsd,
    }),
    forfeitedMonthlyMicroUsd,
    walletDeltaMicroUsd:
      refundedMonthlyMicroUsd +
      refundedPaidMicroUsd -
      excessAllocation.monthlyDebitMicroUsd -
      excessAllocation.paidDebitMicroUsd,
  }
}

function negateWithoutNegativeZero(value: number): number {
  return value === 0 ? 0 : -value
}

export function walletOf(user: Doc<'users'>): Wallet {
  return {
    paidMicroUsd: user.paidCreditBalanceMicroUsd,
    monthlyMicroUsd: user.monthlyCreditBalanceMicroUsd,
  }
}

export function spendableBalance(wallet: Wallet): number {
  return wallet.monthlyMicroUsd + wallet.paidMicroUsd
}

export function bucketFor(type: TransactionType): 'monthly' | 'paid' {
  return type === 'subscription_grant' || type === 'subscription_expiry' ? 'monthly' : 'paid'
}

export async function applyWalletDelta(
  ctx: Pick<MutationCtx, 'db'>,
  user: Doc<'users'>,
  args: { paidDeltaMicroUsd: number; monthlyDeltaMicroUsd: number },
): Promise<Wallet> {
  if (args.monthlyDeltaMicroUsd > 0) {
    throw new Error('Positive monthly credit is only allowed through resetMonthlyCreditsWithDb')
  }
  const wallet = walletOf(user)
  const updated = {
    paidMicroUsd: wallet.paidMicroUsd + args.paidDeltaMicroUsd,
    monthlyMicroUsd: wallet.monthlyMicroUsd + args.monthlyDeltaMicroUsd,
  }
  if (updated.monthlyMicroUsd < 0) throw new Error('Monthly credit balance cannot be negative')
  await writeWallet(ctx, user, updated)
  return updated
}

async function writeWallet(
  ctx: Pick<MutationCtx, 'db'>,
  user: Doc<'users'>,
  wallet: Wallet,
): Promise<void> {
  await ctx.db.patch(user._id, {
    paidCreditBalanceMicroUsd: wallet.paidMicroUsd,
    monthlyCreditBalanceMicroUsd: wallet.monthlyMicroUsd,
  })
}

export async function resetMonthlyCreditsWithDb(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    invoiceId: string
    plan: SubscriptionPlanId
    allotmentMicroUsd: number
    periodStart: number
    periodEnd: number
    invoiceCreatedAt?: number
    recordStaleInvoice?: boolean
    now: number
  },
): Promise<{
  applied: boolean
  expiredMicroUsd: number
  grantedMicroUsd: number
  balances: Wallet
}> {
  if (args.allotmentMicroUsd < 0) throw new Error('Monthly allotment must be nonnegative')
  if (args.periodEnd <= args.periodStart) throw new Error('Monthly credit period is invalid')
  const user = await ctx.db.get(args.userId)
  if (user === null) throw new Error('Account wallet not found')
  const expiryReference = `subscription_expiry:invoice:${args.invoiceId}`
  const grantReference = `subscription_grant:invoice:${args.invoiceId}`
  if (
    (await transactionByReference(ctx, { userId: args.userId, reference: expiryReference })) !==
      null ||
    (await transactionByReference(ctx, { userId: args.userId, reference: grantReference })) !== null
  ) {
    return {
      applied: false,
      expiredMicroUsd: 0,
      grantedMicroUsd: 0,
      balances: walletOf(user),
    }
  }

  const invoiceCreatedAt = args.invoiceCreatedAt ?? args.periodStart
  if (user.billing?.monthlyCreditEpoch !== undefined) {
    const currentGrant = await transactionByReference(ctx, {
      userId: args.userId,
      reference: `subscription_grant:invoice:${user.billing.monthlyCreditEpoch}`,
    })
    const metadata = metadataContext(currentGrant?.metadata?.context ?? currentGrant?.metadata)
    const currentKey: InvoiceOrderKey = [
      numberMetadata(metadata, 'periodEnd') || user.billing.monthlyCreditExpiresAt || 0,
      numberMetadata(metadata, 'invoiceCreatedAt'),
      user.billing.monthlyCreditEpoch,
    ]
    const incomingKey: InvoiceOrderKey = [args.periodEnd, invoiceCreatedAt, args.invoiceId]
    if (compareInvoiceOrder(incomingKey, currentKey) <= 0) {
      if (args.recordStaleInvoice === true) {
        const metadata = creditTransactionMetadata({
          plan: args.plan,
          periodStart: args.periodStart,
          periodEnd: args.periodEnd,
          invoiceCreatedAt,
          superseded: true,
        })
        for (const [type, reference] of [
          ['subscription_expiry', expiryReference],
          ['subscription_grant', grantReference],
        ] as const) {
          const transactionId = await insertCreditTransaction(ctx, {
            userId: args.userId,
            actorUserId: args.userId,
            amountMicroUsd: 0,
            monthlyAmountMicroUsd: 0,
            paidAmountMicroUsd: 0,
            type,
            reference,
            metadata,
            createdAt: args.now,
          })
          await bindCreditTransactionPagination(ctx, transactionId)
        }
        return {
          applied: false,
          expiredMicroUsd: 0,
          grantedMicroUsd: 0,
          balances: walletOf(user),
        }
      }
      throw new Error('Stale monthly credit invoice')
    }
  }

  const current = walletOf(user)
  const expiredMicroUsd = current.monthlyMicroUsd
  const expiryAmountMicroUsd = expiredMicroUsd === 0 ? 0 : -expiredMicroUsd
  const metadata = creditTransactionMetadata({
    plan: args.plan,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    invoiceCreatedAt,
  })
  const expiryTransactionId = await insertCreditTransaction(ctx, {
    userId: args.userId,
    actorUserId: args.userId,
    amountMicroUsd: expiryAmountMicroUsd,
    monthlyAmountMicroUsd: expiryAmountMicroUsd,
    paidAmountMicroUsd: 0,
    type: 'subscription_expiry',
    reference: expiryReference,
    metadata,
    createdAt: args.now,
  })
  await bindCreditTransactionPagination(ctx, expiryTransactionId)
  const grantTransactionId = await insertCreditTransaction(ctx, {
    userId: args.userId,
    actorUserId: args.userId,
    amountMicroUsd: args.allotmentMicroUsd,
    monthlyAmountMicroUsd: args.allotmentMicroUsd,
    paidAmountMicroUsd: 0,
    type: 'subscription_grant',
    reference: grantReference,
    metadata,
    createdAt: args.now,
  })
  await bindCreditTransactionPagination(ctx, grantTransactionId)
  const balances = { paidMicroUsd: current.paidMicroUsd, monthlyMicroUsd: args.allotmentMicroUsd }
  await ctx.db.patch(args.userId, {
    paidCreditBalanceMicroUsd: balances.paidMicroUsd,
    monthlyCreditBalanceMicroUsd: balances.monthlyMicroUsd,
    billing: {
      ...user.billing,
      monthlyCreditEpoch: args.invoiceId,
      monthlyCreditExpiresAt: args.periodEnd,
    },
  })
  return {
    applied: true,
    expiredMicroUsd,
    grantedMicroUsd: args.allotmentMicroUsd,
    balances,
  }
}

export async function expireMonthlyCreditsWithDb(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    reference: string
    reason: string
    replaceReference?: string
    now: number
  },
): Promise<{ applied: boolean; expiredMicroUsd: number; balances: Wallet }> {
  const user = await ctx.db.get(args.userId)
  if (user === null) throw new Error('Account wallet not found')
  if ((await transactionByReference(ctx, args)) !== null) {
    return { applied: false, expiredMicroUsd: 0, balances: walletOf(user) }
  }
  const current = walletOf(user)
  const expiryAmountMicroUsd = current.monthlyMicroUsd === 0 ? 0 : -current.monthlyMicroUsd
  const priorLapse =
    args.replaceReference === undefined
      ? null
      : await transactionByReference(ctx, {
          userId: args.userId,
          reference: args.replaceReference,
        })
  if (priorLapse !== null) {
    // A newer paid invoice can arrive after deletion. Re-project the same lapse
    // row onto the winning epoch so delivery order cannot create two expiries.
    await ctx.db.patch(priorLapse._id, {
      amountMicroUsd: expiryAmountMicroUsd,
      monthlyAmountMicroUsd: expiryAmountMicroUsd,
      reference: args.reference,
      metadata: creditTransactionMetadata({ reason: args.reason }),
      createdAt: args.now,
    })
    const balances = { paidMicroUsd: current.paidMicroUsd, monthlyMicroUsd: 0 }
    await ctx.db.patch(args.userId, {
      monthlyCreditBalanceMicroUsd: 0,
      billing: { ...user.billing, monthlyCreditExpiresAt: args.now },
    })
    return { applied: true, expiredMicroUsd: current.monthlyMicroUsd, balances }
  }
  const transactionId = await insertCreditTransaction(ctx, {
    userId: args.userId,
    actorUserId: args.userId,
    amountMicroUsd: expiryAmountMicroUsd,
    monthlyAmountMicroUsd: expiryAmountMicroUsd,
    paidAmountMicroUsd: 0,
    type: 'subscription_expiry',
    reference: args.reference,
    metadata: creditTransactionMetadata({ reason: args.reason }),
    createdAt: args.now,
  })
  await bindCreditTransactionPagination(ctx, transactionId)
  const balances = { paidMicroUsd: current.paidMicroUsd, monthlyMicroUsd: 0 }
  await ctx.db.patch(args.userId, {
    monthlyCreditBalanceMicroUsd: 0,
    billing: { ...user.billing, monthlyCreditExpiresAt: args.now },
  })
  return { applied: true, expiredMicroUsd: current.monthlyMicroUsd, balances }
}

type InvoiceOrderKey = readonly [periodEnd: number, invoiceCreatedAt: number, invoiceId: string]

function compareInvoiceOrder(left: InvoiceOrderKey, right: InvoiceOrderKey): number {
  if (left[0] !== right[0]) return left[0] - right[0]
  if (left[1] !== right[1]) return left[1] - right[1]
  return left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : 0
}

function numberMetadata(metadata: Record<string, unknown> | undefined, key: string): number {
  const value = metadata?.[key]
  return typeof value === 'number' ? value : 0
}
