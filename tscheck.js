var TypeScript = require('./lib/typescript')
var fs = require('fs')
var program = require('commander')

program
    .parse(process.argv)

var file = program.args[0]
var text = fs.readFileSync(file, 'utf8')
var fancyText = TypeScript.SimpleText.fromString(text)

var allowSemicolonInsertion = true
var allowModuleKeyword = true
var options = new TypeScript.ParseOptions(TypeScript.LanguageVersion.EcmaScript5, allowSemicolonInsertion, allowModuleKeyword)

var isDecl = true
var syntaxTree = TypeScript.Parser.parse(file, fancyText, isDecl, options)

var lineMap = TypeScript.LineMap.fromString(text)
var compilationSettings = new TypeScript.CompilationSettings()
var visitor = new TypeScript.SyntaxTreeToAstVisitor(file, lineMap, compilationSettings)
var ast = syntaxTree.sourceUnit().accept(visitor)

