import { generate } from '@graphql-codegen/cli'

import type { Types } from '@graphql-codegen/plugin-helpers'
import type { Resolver } from '@nuxt/kit'
import type { GqlConfig } from './types'

interface GenerateOptions {
  clients?: GqlConfig['clients']
  file: string
  silent?: boolean
  plugins?: string[]
  documents?: string[]
  onlyOperationTypes?: boolean
  resolver? : Resolver
}

function prepareConfig (options: GenerateOptions): Types.Config {
  const schema: Types.Config['schema'] = Object.values(options.clients).map((v) => {
    if (v.schema) { return v.schema }

    if (!v?.token?.value && !v?.headers) { return v.host }

    const token = v?.token?.value && `${v?.token?.type} ${v?.token?.value}`.trim()

    const serverHeaders = typeof v?.headers?.serverOnly === 'object' && v?.headers?.serverOnly
    if (v?.headers?.serverOnly) { delete v.headers.serverOnly }

    const headers = v?.headers && { ...(v.headers as Record<string, string>), ...serverHeaders }

    return { [v.host]: { headers: { ...headers, ...(token && { [v.token.name]: token }) } } }
  })

  return {
    schema,
    silent: options.silent,
    documents: options.documents,
    generates: {
      [options.file]: {
        plugins: options.plugins,
        config: {
          skipTypename: true,
          useTypeImports: true,
          dedupeFragments: true,
          gqlImport: 'graphql-request#gql',
          onlyOperationTypes: options.onlyOperationTypes,
          namingConvention: {
            enumValues: 'change-case-all#upperCaseFirst'
          }
        }
      }
    }
  }
}

export default async function (options: GenerateOptions): Promise<string> {
  const config = prepareConfig(options)

  return await generate(config, false).then(([{ content }]) => content)
}
