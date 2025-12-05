/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'

type Bindings = {
  BEARER_TOKEN: string
  INFURA_API_KEY: string
  ENS_CACHE: KVNamespace
}

type EnsProfile = {
  name: string | null
  address: string | null
  avatar: string | null
  records: Record<string, string | null>
  cached: boolean
}

const CACHE_TTL_SECONDS = 3600

const TEXT_RECORDS = [
  'description',
  'url',
  'com.twitter',
  'com.github',
  'org.telegram',
  'com.discord',
  'social.bsky',
  'email',
  'location',
  'pronouns',
  'timezone',
]

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', async (c, next) => {
  const auth = bearerAuth({ token: c.env.BEARER_TOKEN })
  return auth(c, next)
})

app.get('/', async (c) => {
  const input = c.req.query('input')

  if (!input) {
    return c.json({ error: 'Missing input parameter' }, 400)
  }

  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(input)

  const cached = await c.env.ENS_CACHE.get(input)
  if (cached !== null) {
    return c.json({ ...JSON.parse(cached), cached: true })
  }

  const client = createPublicClient({
    chain: mainnet,
    transport: http(`https://mainnet.infura.io/v3/${c.env.INFURA_API_KEY}`),
  })

  if (isAddress) {
    const name = await client.getEnsName({ address: input as `0x${string}` })

    const profile = { address: input, name: name ?? null, cached: false }

    await c.env.ENS_CACHE.put(input, JSON.stringify(profile), {
      expirationTtl: CACHE_TTL_SECONDS,
    })

    return c.json(profile)
  }

  let normalized: string
  try {
    normalized = normalize(input.trim())
  } catch {
    return c.json({ error: 'Invalid ENS name' }, 400)
  }

  const [addressResult, avatarResult, ...textResults] = await Promise.allSettled([
    client.getEnsAddress({ name: normalized }),
    client.getEnsAvatar({ name: normalized }),
    ...TEXT_RECORDS.map((key) => client.getEnsText({ name: normalized, key })),
  ])

  const address = addressResult.status === 'fulfilled' ? (addressResult.value ?? null) : null
  const avatar = avatarResult.status === 'fulfilled' ? (avatarResult.value ?? null) : null

  const records = Object.fromEntries(
    TEXT_RECORDS.map((key, i) => {
      const result = textResults[i]
      return [key, result?.status === 'fulfilled' ? (result.value ?? null) : null]
    })
  )

  const profile: EnsProfile = { name: normalized, address, avatar, records, cached: false }

  if (address) {
    await c.env.ENS_CACHE.put(normalized, JSON.stringify(profile), {
      expirationTtl: CACHE_TTL_SECONDS,
    })
  }

  return c.json(profile)
})

export default app