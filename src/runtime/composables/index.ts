import { hash } from 'ohash'
import type { Ref } from 'vue'
import type { AsyncData } from 'nuxt/dist/app/composables'
import { extractOperation } from 'ohmygql/utils'
import type { GqlState, GqlConfig, GqlError, OnGqlError } from '../../types'
// @ts-ignore
import { GqlOperations, GqlInstance } from '#build/gql'
import type { GqlClients, GqlFunc } from '#build/gql'
import { gqlSdk } from '#build/gql-sdk'
import { useState, useNuxtApp, useAsyncData, useRuntimeConfig } from '#imports'

const useGqlState = (): Ref<GqlState> => {
  const nuxtApp = useNuxtApp() as Partial<{ _gqlState: Ref<GqlState> }>

  return nuxtApp?._gqlState
}

/**
 *
 * @param {object} options Changes to be made to gqlState
 *
 * */
const setGqlState = ({ client = 'default', patch }: {client: GqlClients, patch: RequestInit}) => {
  const state = useGqlState()

  state.value[client].instance.setOptions(patch)
}

/**
 * `useGqlHeaders` allows you to set headers for all subsequent requests.
 *
 * @param {object} headers
 * @param {string} client
 *
 * @example
 * - Set headers for default client
 * ```ts
 * useGqlHeaders({ 'X-Custom-Header': 'Custom Value' })
 * ```
 *
 * - Set headers for a specific client (multi-client mode)
 * ```ts
 * useGqlHeaders({'X-Custom-Header': 'Custom Value'}, 'my-client')
 * ```
 *
 * - Reset headers for a specific client
 * ```ts
 * useGqlHeaders(null, 'my-client')
 * ```
 * */
export function useGqlHeaders (headers: Record<string, string>, client?: GqlClients): void
export function useGqlHeaders (opts :{headers: Record<string, string>, client?: GqlClients, respectDefaults?: boolean}): void
export function useGqlHeaders (...args: any[]) {
  const client = args[1] || args?.[0]?.client
  const headers = (args[0] && typeof args[0] !== 'undefined' && 'headers' in args[0]) ? args[0].headers : args[0]
  const respectDefaults = args?.[0]?.respectDefaults

  setGqlState({ client, patch: { headers } })

  if (respectDefaults && !Object.keys(headers).length) {
    const clientHeaders = (useRuntimeConfig()?.public?.['graphql-client'] as GqlConfig)?.clients?.[client || 'default']?.headers

    const serverHeaders = (process.server && (typeof clientHeaders?.serverOnly === 'object' && clientHeaders?.serverOnly)) || undefined
    if (clientHeaders?.serverOnly) { delete clientHeaders.serverOnly }

    setGqlState({ client, patch: { headers: { ...(clientHeaders as Record<string, string>), ...serverHeaders } } })
  }
}

interface GqlTokenConfig {
  /**
   * The name of the Authentication token header.
   *
   * @default 'Authorization'
   * */
  name?: string

  /**
   * The HTTP Authentication scheme.
   *
   * @default "Bearer"
   * */
  type?: string
}

const DEFAULT_AUTH: GqlTokenConfig = { type: 'Bearer', name: 'Authorization' }

type GqlTokenOptions = {
  /**
   * Configure the auth token
   *
   * @default
   * `{ type: 'Bearer', name: 'Authorization' }`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Authorization
   * */
  config?: GqlTokenConfig

  /**
   * The name of your GraphQL clients.
   * @note defined in `nuxt.config`
   * */
  client?: GqlClients
}

type GqlToken = string | null

/**
 * `useGqlToken` adds an Authorization header to every request.
 *
 * @param {GqlToken} token The token to be used for authentication
 * @param {object} opts Options for the auth token
 * */
export function useGqlToken (token: GqlToken, opts?: GqlTokenOptions): void
/**
 * `useGqlToken` adds an Authorization header to every request.
 *
 * @param {object} opts Options for the auth token
 * */
export function useGqlToken (opts: GqlTokenOptions & {token: GqlToken}): void
export function useGqlToken (...args: any[]) {
  args = args || []

  const token = typeof args[0] === 'string' ? args[0] : args?.[0]?.token
  const client = args[0]?.client || args?.[1]?.client
  let config = args[0]?.config || args?.[1]?.config

  const clientConfig = (useRuntimeConfig()?.public?.['graphql-client'] as GqlConfig)?.clients?.[client || 'default']

  config = {
    ...DEFAULT_AUTH,
    ...(clientConfig?.token?.name && { name: clientConfig.token.name }),
    ...(clientConfig?.token?.type !== undefined && { type: clientConfig.token.type }),
    ...config
  }

  setGqlState({
    client,
    patch: { headers: { [config.name]: !token ? undefined : `${config.type} ${token}`.trim() } }
  })
}

interface GqlCors {
  mode?: RequestMode
  credentials?: RequestCredentials

  /**
   * The name of your GraphQL client.
   * @note defined in `nuxt.config`
   * */
  client?: GqlClients
}

/**
 * `useGqlCors` adds CORS headers to every request.
 *
 * @param {object} cors Options for the CORS headers
 * */
export const useGqlCors = (cors: GqlCors) => {
  const { mode, credentials, client } = cors || {}

  setGqlState({ client, patch: { mode, credentials } })
}

export const useGql = () => {
  const state = useGqlState()
  const errState = useGqlErrorState()

  const handle = (client?: GqlClients): ReturnType<typeof gqlSdk> => {
    client = client || 'default'
    const { instance } = state.value?.[client]

    instance.setMiddleware({
      // eslint-disable-next-line require-await
      onResponseError: async ({ options, response }) => {
        errState.value = {
          client,
          status: response?.status,
          operation: extractOperation(JSON.parse(options?.body as string)?.query || ''),
          gqlErrors: Array.isArray(response?._data?.errors) ? response?._data?.errors : [response?._data]
        }

        if (state.value.onError) {
          state.value.onError(errState.value)
        }
      }
    })

    return gqlSdk(instance)
  }

  return { handle }
}

/**
 * `useGqlError` captures GraphQL Errors.
 *
 * @param {OnGqlError} onError Gql error handler
 *
 * @example <caption>Log error to console.</caption>
 * ```ts
 * useGqlError((err) => {
 *    console.error(err)
 * })
 * ```
 * */
export const useGqlError = (onError: OnGqlError) => {
  // proactive measure to prevent context reliant calls
  useGqlState().value.onError = process.client
    ? onError
    : process.env.NODE_ENV !== 'production' && (e => console.error('[nuxt-graphql-client] [GraphQL error]', e))

  const errState = useGqlErrorState()

  if (!errState.value) { return }

  onError(errState.value)
}

const useGqlErrorState = () => useState<GqlError>('_gqlErrors', () => null)

/**
 * Asynchronously query data that is required to load a page or component.
 *
 * @param {Object} options
 * @param {string} options.operation Name of the query to be executed.
 * @param {string} options.variables Variables to be passed to the query.
 * @param {Object} options.options AsyncData options.
 */
export function useAsyncGql<
T extends keyof GqlFunc,
P extends Parameters<GqlFunc[T]>['0'],
R extends AsyncData<Awaited<ReturnType<GqlFunc[T]>>, GqlError>,
O extends Parameters<typeof useAsyncData>['2']> (options: { operation: T, variables?: P, options?: O }): Promise<R>

/**
 * Asynchronously query data that is required to load a page or component.
 *
 * @param {string} operation Name of the query to be executed.
 * @param {string} variables Variables to be passed to the query.
 * @param {Object} options AsyncData options.
 */
export function useAsyncGql<
T extends keyof GqlFunc,
P extends Parameters<GqlFunc[T]>['0'],
R extends AsyncData<Awaited<ReturnType<GqlFunc[T]>>, GqlError>,
O extends Parameters<typeof useAsyncData>['2']> (operation: T, variables?: P, options?: O): Promise<R>

export function useAsyncGql (...args: any[]) {
  const operation = (typeof args?.[0] !== 'string' && 'operation' in args?.[0] ? args[0].operation : args[0]) ?? undefined
  const variables = (typeof args?.[0] !== 'string' && 'variables' in args?.[0] ? args[0].variables : args[1]) ?? undefined
  const options = (typeof args?.[0] !== 'string' && 'options' in args?.[0] ? args[0].options : args[2]) ?? undefined
  const client = Object.keys(GqlOperations).find(k => GqlOperations[k].includes(operation)) ?? 'default'
  const key = hash({ operation, client, variables })
  return useAsyncData(key, () => GqlInstance().handle(client as GqlClients)[operation](variables), options)
}
