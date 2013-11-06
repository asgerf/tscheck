var TypeScript = require('./ts')
var fs = require('fs')

var text = fs.readFileSync(process.argv[2], 'utf8')
var ast = TypeScript.parse(text)

var indentStr = ''
function onEnter(node, parent) {
    var info = ''
    if (node instanceof TypeScript.Identifier)
        info = node.text()
    if (node instanceof TypeScript.FunctionDeclaration) {
        info = 'isConstructor = ' + node.isConstructor + '; isConstructMember() = ' + node.isConstructMember();
    }
    console.log(indentStr + node.constructor.name + ' ' + info)
    indentStr += '  '
}
function onExit(node, parent) {
    indentStr = indentStr.substring(2)
}

TypeScript.getAstWalkerFactory().walk(ast, onEnter, onExit)

