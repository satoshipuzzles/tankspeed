// The Nostr layer, kept deliberately small: login, profile, and the shared
// skin record. TankSpeed is one of a family of tank games, so the skin lives
// in a GAME-NEUTRAL addressable event — kind 30078 with d `tank-games/skin` —
// that every game in the family can read and write. Pick chrome here, drive
// chrome everywhere.
//
// Relay etiquette (a standing house rule): one pool, queries only at login
// and on save, one signature per save. Nothing here ticks or polls.

import { SimplePool, type Event, type EventTemplate } from 'nostr-tools'
import { asSkin, type SkinId } from './skins'

export const DEFAULT_RELAYS = [
  'wss://coolfeed.feeds.relay.tools',
  'wss://relay.mostr.pub',
  'wss://relay.primal.net',
  'wss://purplerelay.com',
]

export const SKIN_D = 'tank-games/skin'

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(template: EventTemplate): Promise<Event>
    }
  }
}

const pool = new SimplePool()

export interface Profile {
  name: string | null
  picture: string | null
}

export function hasNip07(): boolean {
  return typeof window.nostr?.getPublicKey === 'function'
}

export async function loginNip07(): Promise<string> {
  if (!window.nostr) throw new Error('No NIP-07 extension found')
  return window.nostr.getPublicKey()
}

/** The kind-0 profile, or nulls — a missing profile is not an error. */
export async function fetchProfile(pubkey: string): Promise<Profile> {
  try {
    const ev = await pool.get(DEFAULT_RELAYS, { kinds: [0], authors: [pubkey] }, { maxWait: 4000 })
    if (!ev) return { name: null, picture: null }
    const meta = JSON.parse(ev.content) as Record<string, unknown>
    return {
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim().slice(0, 16) : null,
      picture: typeof meta.picture === 'string' ? meta.picture : null,
    }
  } catch {
    return { name: null, picture: null }
  }
}

/** The player's shared cross-game skin, or null if they never saved one. */
export async function fetchSharedSkin(pubkey: string): Promise<SkinId | null> {
  try {
    const ev = await pool.get(
      DEFAULT_RELAYS,
      { kinds: [30078], authors: [pubkey], '#d': [SKIN_D] },
      { maxWait: 4000 },
    )
    if (!ev) return null
    const body = JSON.parse(ev.content) as Record<string, unknown>
    return typeof body.skin === 'string' ? asSkin(body.skin) : null
  } catch {
    return null
  }
}

/**
 * Publish the skin for the whole game family. One signature, fire-and-forget
 * to every default relay; a relay that refuses just means another one holds
 * the record.
 */
export async function publishSharedSkin(skin: SkinId): Promise<void> {
  if (!window.nostr) return
  const signed = await window.nostr.signEvent({
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', SKIN_D],
      ['t', 'tank-games'],
    ],
    content: JSON.stringify({ skin, game: 'tankspeed' }),
  })
  await Promise.allSettled(pool.publish(DEFAULT_RELAYS, signed))
}
