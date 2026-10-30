import { render } from 'react-email'

import type { PreparedTransactionalEmail } from './prepare'

export async function renderPreparedTransactionalEmail(
  prepared: PreparedTransactionalEmail,
): Promise<string> {
  return await render(prepared.document)
}
