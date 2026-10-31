/**
 * Account binding policy for applications that use Sign in with CoinPay.
 * One local account can keep one CoinPay identity, while one CoinPay identity
 * can be deliberately linked to several local accounts. When a sign-in maps
 * to multiple accounts, the relying party must ask the person to choose.
 */
export type CoinPayAccountBinding = { sub: string; userId: string }

export type CoinPayLinkDecision =
  | { kind: 'link' }
  | { kind: 'already_linked' }
  | { kind: 'account_has_other_identity' }

/** Resolve a signed-in account's request to connect a CoinPay identity. */
export function resolveCoinPayAccountLink(input: {
  bindings: readonly CoinPayAccountBinding[]
  sub: string
  userId: string
}): CoinPayLinkDecision {
  const accountBinding = input.bindings.find((binding) => binding.userId === input.userId)
  if (!accountBinding) return { kind: 'link' }
  return accountBinding.sub === input.sub ? { kind: 'already_linked' } : { kind: 'account_has_other_identity' }
}

export type CoinPaySignInDecision =
  | { kind: 'create_account' }
  | { kind: 'sign_in'; userId: string }
  | { kind: 'choose_account'; userIds: string[] }

/** Resolve login without silently selecting between multiple linked accounts. */
export function resolveCoinPaySignIn(userIds: readonly string[]): CoinPaySignInDecision {
  const unique = [...new Set(userIds.filter((userId) => typeof userId === 'string' && userId.length > 0))]
  if (unique.length === 0) return { kind: 'create_account' }
  if (unique.length === 1) return { kind: 'sign_in', userId: unique[0]! }
  return { kind: 'choose_account', userIds: unique }
}
