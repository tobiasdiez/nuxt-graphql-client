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

    if (!v?.token?.value) { return v.host }

    const token = `${v?.token?.type} ${v?.token?.value}`.trim()

    return { [v.host]: { headers: { ...(v?.headers && { ...v.headers }), [v?.token?.name]: token } } }
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
