const {transformSync} = require('@babel/core')
const declare = require('@babel/helper-plugin-utils').declare
const toStyleObject = require('to-style').object
const {paramCase} = require('change-case')
const {toTemplateLiteral} = require('./util')

class BabelPluginExtractJsxNames {
  constructor() {
    const names = []
    this.state = {names}

    this.plugin = declare(api => {
      api.assertVersion(7)

      return {
        visitor: {
          JSXOpeningElement(path) {
            names.push(path.node.name.name)
          }
        }
      }
    })
  }
}

class BabelPluginExtractImportNames {
  constructor() {
    const names = []
    this.state = {names}

    this.plugin = declare(api => {
      api.assertVersion(7)

      return {
        visitor: {
          ImportDeclaration(path) {
            path.traverse({
              Identifier(path) {
                if (path.key === 'local') {
                  names.push(path.node.name)
                }
              }
            })
          }
        }
      }
    })
  }
}

// eslint-disable-next-line complexity
function toJSX(node, parentNode = {}, options = {}) {
  const {
    // Default options
    skipExport = false,
    preserveNewlines = false,
    wrapExport
  } = options
  let children = ''

  if (node.properties != null) {
    if (typeof node.properties.style === 'string') {
      node.properties.style = toStyleObject(node.properties.style, {
        camelize: true
      })
    }

    // AriaProperty => aria-property
    // dataProperty => data-property
    const paramCaseRe = /^(aria[A-Z])|(data[A-Z])/
    node.properties = Object.entries(node.properties).reduce(
      (properties, [key, value]) =>
        Object.assign({}, properties, {
          [paramCaseRe.test(key) ? paramCase(key) : key]: value
        }),
      {}
    )
  }

  if (node.type === 'root') {
    const importNodes = []
    const exportNodes = []
    const jsxNodes = []
    let layout
    for (const childNode of node.children) {
      if (childNode.type === 'import') {
        importNodes.push(childNode)
        continue
      }

      if (childNode.type === 'export') {
        if (childNode.default) {
          layout = childNode.value
            .replace(/^export\s+default\s+/, '')
            .replace(/;\s*$/, '')
          continue
        }

        exportNodes.push(childNode)
        continue
      }

      jsxNodes.push(childNode)
    }

    const exportNames = exportNodes
      .map(node =>
        node.value.match(/export\s*(var|const|let|class|function)?\s*(\w+)/)
      )
      .map(match => (Array.isArray(match) ? match[2] : null))
      .filter(Boolean)

    const importStatements = importNodes
      .map(childNode => toJSX(childNode, node))
      .join('\n')
    const exportStatements = exportNodes
      .map(childNode => toJSX(childNode, node))
      .join('\n')
    const layoutProps = `const layoutProps = {
  ${exportNames.join(',\n')}
};`
    const mdxLayout = `const MDXLayout = ${layout ? layout : '"wrapper"'}`

    const fn = `function MDXContent({ components, ...props }) {
  return (
    <MDXLayout
      {...layoutProps}
      {...props}
      components={components}>
${jsxNodes.map(childNode => toJSX(childNode, node)).join('')}
    </MDXLayout>
  )
}
MDXContent.isMDXComponent = true`

    // Check JSX nodes against imports
    const babelPluginExptractImportNamesInstance = new BabelPluginExtractImportNames()
    transformSync(importStatements, {
      plugins: [
        '@babel/plugin-syntax-jsx',
        '@babel/plugin-proposal-object-rest-spread',
        babelPluginExptractImportNamesInstance.plugin
      ]
    })
    const importNames = babelPluginExptractImportNamesInstance.state.names

    const babelPluginExtractJsxNamesInstance = new BabelPluginExtractJsxNames()
    transformSync(fn, {
      plugins: [
        '@babel/plugin-syntax-jsx',
        '@babel/plugin-proposal-object-rest-spread',
        babelPluginExtractJsxNamesInstance.plugin
      ]
    })
    const startsWithCapitalLetter = /^[A-Z]/
    const jsxNames = babelPluginExtractJsxNamesInstance.state.names
      .filter(name => startsWithCapitalLetter.test(name))
      .filter(name => name != 'MDXLayout')
    // It doesn't look like exportNames includes the following named export
    //       export { Baz } from './foo'
    // should it?
    const importExportNames = importNames.concat(exportNames)
    const fakedModulesForGlobalScope = jsxNames
      .filter(name => !importExportNames.includes(name))
      .map(name => {
        return `const ${name} = props => {
console.warn("Component \`${name}\` was not imported, exported, or provided by MDXProvider as global scope")
}`
      })
      .join('\n')

    const moduleBase = `${importStatements}
${exportStatements}
${fakedModulesForGlobalScope}
${layoutProps}
${mdxLayout}`

    if (skipExport) {
      return `${moduleBase}
${fn}`
    }
    if (wrapExport) {
      return `${moduleBase}
${fn}
export default ${wrapExport}(MDXContent)`
    }
    return `${moduleBase}
export default ${fn}`
  }
  // Recursively walk through children
  if (node.children) {
    children = node.children
      .map(childNode => {
        const childOptions = Object.assign({}, options, {
          // Tell all children inside <pre> tags to preserve newlines as text nodes
          preserveNewlines: preserveNewlines || node.tagName === 'pre'
        })
        return toJSX(childNode, node, childOptions)
      })
      .join('')
  }

  if (node.type === 'element') {
    let props = ''

    if (Array.isArray(node.properties.className)) {
      node.properties.className = node.properties.className.join(' ')
    }

    if (Object.keys(node.properties).length > 0) {
      props = JSON.stringify(node.properties)
    }

    return `<${node.tagName}${
      parentNode.tagName ? ` parentName="${parentNode.tagName}"` : ''
    }${props ? ` {...${props}}` : ''}>${children}</${node.tagName}>`
  }

  // Wraps text nodes inside template string, so that we don't run into escaping issues.
  if (node.type === 'text') {
    // Don't wrap newlines unless specifically instructed to by the flag,
    // to avoid issues like React warnings caused by text nodes in tables.
    const shouldPreserveNewlines =
      preserveNewlines || parentNode.tagName === 'p'

    if (node.value === '\n' && !shouldPreserveNewlines) {
      return node.value
    }

    return toTemplateLiteral(node.value)
  }

  if (node.type === 'comment') {
    return `{/*${node.value}*/}`
  }

  if (node.type === 'import' || node.type === 'export' || node.type === 'jsx') {
    return node.value
  }
}

function compile(options = {}) {
  this.Compiler = tree => {
    return toJSX(tree, {}, options)
  }
}

module.exports = compile
exports = compile
exports.toJSX = toJSX
exports.default = compile
