// This module monkey patches the TypeScript module with some convenient functions
// and re-exports the same module

var TypeScript = require('./lib/typescript')

module.exports = TypeScript

TypeScript.parse = function(text) {
    var fancyText = TypeScript.SimpleText.fromString(text)
    
    var allowSemicolonInsertion = true
    var allowModuleKeyword = true
    var options = new TypeScript.ParseOptions(
        TypeScript.LanguageVersion.EcmaScript5, 
        allowSemicolonInsertion, 
        allowModuleKeyword)
    
    var isDecl = true
    var syntaxTree = TypeScript.Parser.parse('', fancyText, isDecl, options)
    
    var lineMap = TypeScript.LineMap.fromString(text)
    var compilationSettings = new TypeScript.CompilationSettings()
    var visitor = new TypeScript.SyntaxTreeToAstVisitor('', lineMap, compilationSettings)
    var ast = syntaxTree.sourceUnit().accept(visitor)
    
    ast.lineMap = lineMap
    
    return ast
}
