#!/usr/bin/env node

var jsnorm = require('./jsnorm')
var Map = require('./map')

// Returns the given AST node's immediate children as an array.
// Property names that start with $ are considered annotations, and will be ignored.
function children(node) {
    var result = [];
    for (var k in node) {
        if (!node.hasOwnProperty(k))
            continue;
        if (k[0] === '$')
            continue;
        var val = node[k];
        if (!val)
            continue;
        if (typeof val === "object" && typeof val.type === "string") {
            result.push(val);
        }
        else if (val instanceof Array) {
            for (var i=0; i<val.length; i++) {
                var elm = val[i];
                if (typeof elm === "object" && typeof elm.type === "string") {
                    result.push(elm);
                }
            }
        } 
    }
    return result;
}

// Assigns parent pointers to each node. The parent pointer is called $parent.
function injectParentPointers(node, parent) {
    node.$parent = parent;
    var list = children(node);
    for (var i=0; i<list.length; i++) {
        injectParentPointers(list[i], node);
    }
}

// Returns the function or program immediately enclosing the given node, possibly the node itself.
function getEnclosingFunction(node) {
    while  (node.type !== 'FunctionDeclaration' && 
            node.type !== 'FunctionExpression' && 
            node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// Returns the function, program or catch clause immediately enclosing the given node, possibly the node itself.
function getEnclosingScope(node) {
    while  (node.type !== 'FunctionDeclaration' && 
            node.type !== 'FunctionExpression' && 
            node.type !== 'CatchClause' &&
            node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// Injects an the following into functions, programs, and catch clauses
// - $env: Map from variable names in scope to Identifier at declaration
// - $depth: nesting depth from top-level
function injectEnvs(node) {
    switch (node.type) {
        case 'Program':
            node.$env = new Map;
            node.$depth = 0;
            break;
        case 'FunctionExpression':
            node.$env = new Map;
            node.$depth = 1 + getEnclosingScope(node.$parent).$depth;
            if (node.id) {
                node.$env.put(node.id.name, node.id)
            }
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
            node.$env.put('arguments', node)
            break;
        case 'FunctionDeclaration':
            var parent = getEnclosingFunction(node.$parent); // note: use getEnclosingFunction, because fun decls are lifted outside catch clauses
            node.$env = new Map;
            node.$depth = 1 + parent.$depth;
            parent.$env.put(node.id.name, node.id)
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
            node.$env.put('arguments', node)
            break;
        case 'CatchClause':
            node.$env = new Map;
            node.$env.put(node.param.name, node.param)
            node.$depth = 1 + getEnclosingScope(node.$parent).$depth;
            break;
        case 'VariableDeclarator':
            var parent = getEnclosingFunction(node) // note: use getEnclosingFunction, because vars ignore catch clauses
            parent.$env.put(node.id.name, node.id)
            break;
    }
    children(node).forEach(injectEnvs)
}


function numberSourceFileFunctions(ast) {
	if (ast === null)
		return
	var array = []
	function add(x) {
		x.$function_id = array.length;
		array.push(x)
	}
	function visit(node) {
		if (node.type === 'Program' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
			add(node)
		}
		children(node).forEach(visit)
	}
	visit(ast)
	ast.$id2function = array;
}

function markClosureVariables(ast) {
	ast.$locals = new Map // top-level scope has no local variables
	function visit(node) {
		switch (node.type) {
			case 'FunctionExpression':
			case 'FunctionDeclaration':
				// set of variables that are not referenced by inner functions
				// initially assume all variables are local; then discard them as we discover a non-local reference
				node.$locals = node.$env.clone()
				break;
			case 'Identifier':
				if (classifyId(node).type === 'variable' && node.name !== 'arguments') {
					var fun = getIdentifierScope(node)
					if (fun.type !== 'Program' && !fun.$env.has(node.name)) {
						// find function whose variable is being referenced
						do {
							fun = getEnclosingFunction(fun.$parent)
						} while (fun.type !== 'Program' && !fun.$env.has(node.name));
						// remove local
						if (fun) {
							fun.$locals.remove(node.name)
						}
					}
				}
				break;
		}
		children(node).forEach(visit)
	}
	visit(ast)
}
function classifyId(node) {
    if (node.type != 'Identifier' && (node.type !== 'Literal' || typeof node.value !== 'string'))
        return null; // only identifiers and string literals can be IDs
    var parent = node.$parent;
    switch (parent.type) {
        case 'MemberExpression':
            if (!parent.computed && parent.property === node && node.type === 'Identifier') {
                return {type:"property", base:parent.object, name:node.name};
            } else if (parent.computed && parent.property === node && node.type === 'Literal') {
                return {type:"property", base:parent.object, name:node.value};
            }
            break;
        case 'Property':
            if (parent.key === node) {
                if (node.type === 'Identifier') {
                    return {type:"property", base:parent.$parent, name:node.name};
                } else if (node.type === 'Literal') {
                    return {type:"property", base:parent.$parent, name:node.value};
                }
            }
            break;
        case 'BreakStatement':
        case 'ContinueStatement':
            if (parent.label === node) {
                return {type:"label", name:node.name};
            }
            break;
        case 'LabeledStatement':
            if (parent.label === node) {
                return {type:"label", name:node.name};
            }
            break;
    }
    if (node.type === 'Identifier')
        return {type:"variable", name:node.name};
    else
        return null;
}

function getIdentifierScope(node) {
	if (node.$parent.type === 'FunctionDeclaration' && node.$parent.id === node) {
		return getEnclosingFunction(node.$parent.$parent)
	} else {
		return getEnclosingFunction(node)
	}
}


function prepareAST(ast) {
	jsnorm(ast)
	injectParentPointers(ast)
	injectEnvs(ast)
	numberSourceFileFunctions(ast)
	markClosureVariables(ast)
}


// --------------------
//     ENTRY POINT
// --------------------

function main() {
	var esprima = require('esprima')
	var fs = require('fs')
	var program = require('commander')

	program.option('--index <N>', 'Locate function with id N', Number, -1)
	program.parse(process.argv)

	var texts = []
	program.args.forEach(function(arg) {
		texts.push(fs.readFileSync(arg, 'utf8'))
	})
	var ast = esprima.parse(texts.join('\n'), {loc: true})

	prepareAST(ast)

	if (program.index > -1) {
		console.log(ast.$id2function[program.index].loc.start.line)
	}
	
}

if (require.main === module) {
	main()
}