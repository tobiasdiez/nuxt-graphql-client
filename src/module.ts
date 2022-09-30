import { existsSync, statSync, readFileSync } from 'fs'
import { defu } from 'defu'
import { parse } from 'graphql'
import { mockPlugin } from 'ohmygql/plugin'
import { useLogger, addPlugin, addImportsDir, addTemplate, resolveFiles, createResolver, defineNuxtModule } from '@nuxt/kit'
import type { NameNode, DefinitionNode } from 'graphql'
import { name, version } from '../package.json'
import generate from './generate'
import { deepmerge } from './runtime/utils'
import type { GqlConfig, GqlClient, TokenOpts } from './types'
import { prepareContext, GqlContext, prepareOperations, prepareTemplate } from './context'

const logger = useLogger('nuxt-graphql-client')

export default defineNuxtModule<GqlConfig>({
  meta: {
    name,
    version,
    configKey: 'graphql-client',
    compatibility: {
      nuxt: '^3.0.0-rc.9'
    }
  },
  defaults: {
    clients: {},
    watch: true,
    silent: true,
    codegen: true,
    autoImport: true,
    functionPrefix: 'Gql',
    onlyOperationTypes: true
  },
  async setup (opts, nuxt) {
    const resolver = createResolver(import.meta.url)
    const srcResolver = createResolver(nuxt.options.srcDir)

    nuxt.options.build.transpile.push(resolver.resolve('runtime'))

    const config: GqlConfig<string | GqlClient> = defu(
      {},
      nuxt.options.runtimeConfig.public['graphql-client'],
      nuxt.options.runtimeConfig.public.gql,
      opts)

    const ctx: GqlContext = { clientOps: {}, fnImports: [], codegen: config?.codegen, clients: Object.keys(config.clients) }

    if (!ctx?.clients?.length) {
      const host =
        process.env.GQL_HOST || nuxt.options.runtimeConfig.public.GQL_HOST

      const clientHost =
        process.env.GQL_CLIENT_HOST || nuxt.options.runtimeConfig.public.GQL_CLIENT_HOST

      if (!host) { throw new Error('GQL_HOST is not set in public runtimeConfig') }

      ctx.clients = ['default']
      config.clients = !clientHost ? { default: host } : { default: { host, clientHost } }
    }

    // @ts-ignore
    nuxt.options.runtimeConfig['graphql-client'] = { clients: {} }
    nuxt.options.runtimeConfig.public['graphql-client'] = defu(nuxt.options.runtimeConfig.public['graphql-client'], { clients: {} })

    for (const [k, v] of Object.entries(config.clients)) {
      const runtimeHost = k === 'default' ? process.env.GQL_HOST : process.env?.[`GQL_${k.toUpperCase()}_HOST`]
      const runtimeClientHost = k === 'default' ? process.env.GQL_CLIENT_HOST : process.env?.[`GQL_${k.toUpperCase()}_CLIENT_HOST`]

      const host = runtimeHost || (typeof v === 'string' ? v : v?.host)
      const clientHost = runtimeClientHost || (typeof v !== 'string' && v.clientHost)

      if (!host) { throw new Error(`GraphQL client (${k}) is missing it's host.`) }

      const runtimeToken = k === 'default' ? process.env.GQL_TOKEN : process.env?.[`GQL_${k.toUpperCase()}_TOKEN`]

      const token = runtimeToken || (
        typeof v !== 'string' && ((typeof v?.token === 'object' && v.token?.value) || (typeof v?.token === 'string' && v.token))
      )

      const runtimeTokenName = k === 'default' ? process.env.GQL_TOKEN_NAME : process.env?.[`GQL_${k.toUpperCase()}_TOKEN_NAME`]
      const tokenName = runtimeTokenName || (typeof v !== 'string' && typeof v?.token === 'object' && v.token.name) || 'Authorization'
      const tokenType = (typeof v !== 'string' && typeof v?.token === 'object' && v?.token?.type !== undefined) ? v?.token?.type : 'Bearer'

      const schema = (typeof v !== 'string' && v?.schema) && srcResolver.resolve(v.schema)

      if (schema && !existsSync(schema)) {
        logger.warn(`[nuxt-graphql-client] The Schema provided for the (${k}) GraphQL Client does not exist. \`host\` will be used as fallback.`)
      }

      const conf: GqlClient<TokenOpts> = {
        ...(typeof v !== 'string' && { ...v }),
        host,
        ...(clientHost && { clientHost }),
        ...(schema && existsSync(schema) && { schema }),
        token: {
          ...(token && { value: token }),
          ...(tokenName && { name: tokenName }),
          type: typeof tokenType !== 'string' ? '' : tokenType
        },
        proxyCookies: (typeof v !== 'string' && v?.proxyCookies !== undefined) ? v.proxyCookies : true
      }

      ctx.clientOps[k] = []
      config.clients[k] = deepmerge({}, conf)
      nuxt.options.runtimeConfig.public['graphql-client'].clients[k] = deepmerge({}, conf)

      if (conf.token?.value) {
        nuxt.options.runtimeConfig['graphql-client'].clients[k] = { token: conf.token }

        if (!(typeof v !== 'string' && v?.retainToken)) {
          (nuxt.options.runtimeConfig.public['graphql-client'] as GqlConfig).clients[k].token.value = undefined
        }
      }
    }

    const documentPaths = [srcResolver.resolve()]

    if (config.documentPaths) {
      for (const path of config.documentPaths) {
        const dir = srcResolver.resolve(path)

        if (existsSync(dir)) {
          documentPaths.push(dir)
        } else {
          logger.warn(`[nuxt-graphql-client] Invalid document path: ${dir}`)
        }
      }
    }

    const gqlMatch = '**/*.{gql,graphql}'
    async function generateGqlTypes () {
      const documents: string[] = []
      for await (const path of documentPaths) {
        const files = (await resolveFiles(path, [gqlMatch, '!**/schemas'], { followSymbolicLinks: false })).filter(allowDocument)

        documents.push(...files)
      }

      const plugins = ['typescript']

      if (documents?.length) {
        plugins.push('typescript-operations', 'ohmygql/plugin')
      }

      ctx.template = config?.codegen
        ? await generate({
          clients: config.clients as GqlConfig['clients'],
          file: 'gql-sdk.ts',
          silent: config.silent,
          plugins,
          documents,
          onlyOperationTypes: config.onlyOperationTypes,
          resolver: srcResolver
        })
        : mockPlugin(documents.reduce<Record<string, string>>((acc, d) => {
          const definitions = parse(readFileSync(d, 'utf-8'))?.definitions as (DefinitionNode & { name: NameNode })[]

          for (const op of definitions) {
            const name: string = op?.name?.value
            const operation = op.loc?.source.body.slice(op.loc.start, op.loc.end) || undefined

            if (name && operation) { acc[name] = operation }
          }

          return acc
        }, {}))

      await prepareOperations(ctx, documents)

      if (Object.keys(config.clients).length > 1 || !config.clients?.default) {
        prepareTemplate(ctx)
      }

      prepareContext(ctx, config.functionPrefix)
    }

    addTemplate({
      write: true,
      filename: 'gql-sdk.ts',
      getContents: () => ctx.template
    })

    addPlugin(resolver.resolve('runtime/plugin'))

    if (config.autoImport) {
      addTemplate({
        filename: 'gql.mjs',
        getContents: () => ctx.generateImports()
      })

      addTemplate({
        filename: 'gql.d.ts',
        getContents: () => ctx.generateDeclarations()
      })

      nuxt.hook('imports:extend', (autoimports) => {
        autoimports.push(...ctx.fnImports)
      })

      addImportsDir(resolver.resolve('runtime/composables'))
    }

    const allowDocument = (f: string) => {
      const isSchema = f.match(/([^/]+)\.(gql|graphql)$/)?.[0]?.toLowerCase().includes('schema')

      return !isSchema && !!statSync(srcResolver.resolve(f)).size
    }

    if (config.watch) {
      nuxt.hook('builder:watch', async (event, path) => {
        if (!path.match(/\.(gql|graphql)$/)) { return }

        if (event !== 'unlink' && !allowDocument(path)) { return }

        const start = Date.now()
        await generateGqlTypes()
        await nuxt.callHook('builder:generateApp')

        const time = Date.now() - start
        logger.success(`[GraphQL Client]: Generation completed in ${time}ms`)
      })
    }

    await generateGqlTypes()
  }
})

declare module '@nuxt/schema' {
  interface PublicRuntimeConfig {
    /**
     * URL pointing to a GraphQL endpoint
     *
     * @type string
     */
    // @ts-ignore
    GQL_HOST?: string

    /**
     * Specify a host to be used for client side requests.
     *
     * @type string
     */
    GQL_CLIENT_HOST?: string

    // @ts-ignore
    gql?: GqlConfig<any>

    // @ts-ignore
    'graphql-client'?: GqlConfig<any>
  }
}
