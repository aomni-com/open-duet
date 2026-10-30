import { z } from 'zod'

const MAX_FEEDBACK_CONTENT_BYTES = 8 * 1024
const MAX_FEEDBACK_SOURCE_LENGTH = 128

export const FeedbackRequestSchema = z.object({
  content: z
    .string()
    .min(1)
    .refine(content => new TextEncoder().encode(content).byteLength <= MAX_FEEDBACK_CONTENT_BYTES),
  source: z.string().max(MAX_FEEDBACK_SOURCE_LENGTH).optional(),
})

// Accepted for async processing; the body is intentionally empty.
export const FeedbackAcceptedResponseSchema = z.object({})
