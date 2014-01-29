#!/usr/bin/env node
// Control-flow graph for JavaScript
var esprima = require('esprima')
var jsnorm = require('./jsnorm')
var util = require('util')
var Map = require('./map')

//////////// AST INSTRUMENTATION /////////////////


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
            break;
        case 'FunctionDeclaration':
            var parent = getEnclosingFunction(node.$parent); // note: use getEnclosingFunction, because fun decls are lifted outside catch clauses
            node.$env = new Map;
            node.$depth = 1 + parent.$depth;
            parent.$env.put(node.id.name, node.id)
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
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
				if (classifyId(node).type === 'variable') {
					var fun = getEnclosingFunction(node)
					if (fun.type === 'Program' || !fun.$env.has(node.name)) {
						// find function whose variable is being referenced
						do {
							fun = getEnclosingFunction(fun.$parent)
						} while (fun && !fun.$env.has(node.name));
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

function prepareAST(ast) {
	jsnorm(ast)
	injectParentPointers(ast)
	injectEnvs(ast)
	numberSourceFileFunctions(ast)	
}


////////// TRANSLATION TO CONTROL FLOW GRAPH //////////

/*

type var = number
type fun = number

type Stmt = 
 | { type: 'read-var', var: string, dst: var }
 | { type: 'write-var', var: string, src: var }
 | { type: 'assign', src: var, dst: var }
 | { type: 'load', object: var, prty: var | string, dst: var }
 | { type: 'store', object: var, prty: var | string, src: var }
 | { type: 'const', dst: var, value: string | number | boolean | null | undefined }
 | { type: 'create-object', properties: Property[] }
 | { type: 'create-array', elements: Element[] }
 | { type: 'create-function', function: fun, dst: var }
 | { type: 'call-method', object: var, prty: var | string, arguments: var[] }
 | { type: 'call-function', function: var, arguments: var[] }
 | { type: 'call-constructor', function: var, arguments: var[] }
 | { type: 'unary', operator: string, argument: var }
 | { type: 'binary', operator: string, left: var, right: var }

type Jump = 
 | { type: 'goto'; target: number }
 | { type: 'if'; condition: var; then: number; else: number }
 | { type: 'return', value: var | null, implicit: boolean }
 | { type: 'throw', value: var }

type Block = { statements: Stmt[]; jump: Jump }

type Function = {
	parameters: string[]
	blocks: Block[]
}

type Element = number | null

type Property = {
	key: string
	value: number
	kind: 'init' | 'get' | 'set'
}

*/

function UnsupportedFeature() {}

function convertFunction(f) {
	var THIS = 0 // variable holding 'this'
	var THIS_FN = 1 // variable holding function instance
	var blocks = []; // Block[]
	var block = null; // number
	var block_idx = -1;
	var label2block = {} // string -> number
	var next_var = 2;

	var decl_block = newBlock()
	var body_block = newBlock()
	blocks[decl_block].jump = {type: 'goto', target: body_block}
	setBlock(body_block)

	if (f.type === 'Program') {
		f.body.forEach(visitStmt)
	} else {
		visitStmt(f.body)
	}

	block.jump = { type: 'return', value: null, implicit: true }

	return {
		parameters: f.params ? f.params.map(function(p) { return p.name }) : [],
		blocks: blocks
	}

	function newBlock() {
		blocks.push({ statements: [], jump: null })
		return blocks.length - 1
	}
	function newVar() {
		return next_var++;
	}
	function addStmt(stmt) {
		block.statements.push(stmt)
	}
	function setBlock(b) {
		block_idx = b
		block = blocks[b]
	}
	function visitStmt(node) {
		if (node === null)
			return;
		if (!('type' in node))
			throw new Error("Unexpected stmt " + util.inspect(node))
		switch (node.type) {
			case 'EmptyStatement': 
				break;
			case 'BlockStatement':
				node.body.forEach(visitStmt);
				break;
			case 'ExpressionStatement':
				visitExpr(node.expression);
				break;
			case 'IfStatement':
				var cnd = visitCondition(node.test, DISCARD_VALUE)
				var exit = newBlock()
				setBlock(cnd.whenTrue.block)
				visitStmt(node.consequent)
				block.jump = {type: 'goto', target: exit}
				setBlock(cnd.whenFalse.block)
				visitStmt(node.alternate)
				block.jump = {type: 'goto', target: exit}
				setBlock(exit)
				break;
			case 'LabeledStatement':
				var successor = newBlock()
				label2block[node.label.name] = successor
				visitStmt(node.body)
				block.jump = { type: 'goto', target: successor }
				setBlock(successor)
				delete label2block[node.label.name]
				break;
			case 'BreakStatement':
				if (!node.label)
					throw new Error("Program not normalized")
				block.jump = { type: 'goto', target: label2block[node.label.name] }
				setBlock(newBlock())
				break;
			case 'ContinueStatement':
				throw new Error("Program not normalized");
			case 'WithStatement':
				throw new UnsupportedFeature("with statement");
			case 'SwitchStatement':
				throw new Error("Program not normalized");
			case 'ReturnStatement':
				block.jump = { type: 'return', value: node.argument ? visitExpr(node.argument) : null, implicit: false }
				setBlock(newBlock())
				break;
			case 'ThrowStatement':
				block.jump = { type: 'throw', value: visitExpr(node.argument) }
				setBlock(newBlock())
				break;
			case 'TryStatement':
				throw new UnsupportedFeature
			case 'WhileStatement':
				var entry = newBlock();
				block.jump = { type: 'goto', target: entry }
				setBlock(entry)
				var jump = block.jump = {
					type: 'if',
					condition: visitExpr(node.test),
					then: newBlock(),
					else: newBlock()
				};
				setBlock(jump.then)
				visitStmt(node.body)
				block.jump = { type: 'goto', target: entry }
				setBlock(jump.else)
				break;
			case 'DoWhileStatement':
				var entry = newBlock();
				block.jump = { type: 'goto', target: entry }
				setBlock(entry)
				visitStmt(node.body)
				var jump = block.jump = {
					type: 'if',
					condition: visitExpr(node.test),
					then: entry,
					else: newBlock()
				};
				setBlock(jump.else)
				break;
			case 'ForStatement':
				throw new Error("Program not normalized")
			case 'ForInStatement':
				throw new UnsupportedFeature
			case 'FunctionDeclaration':
				var old = block
				setBlock(decl_block)
				var v = newVar()
				addStmt({
					type: 'create-function',
					function: node.$function_id,
					dst: v
				})
				addStmt({
					type: 'write-var',
					var: node.id.name,
					src: v
				})
				block = old
				break;
			case 'VariableDeclaration':
				node.declarations.forEach(function(d) {
					if (d.init) {
						var v = visitExpr(d.init)
						addStmt({
							type: 'write-var',
							var: d.id.name,
							src: v
						})
					}
				})
				break;
			default:
				throw new Error("Unexpected statement type: " + node.type)
		}
	}
	function visitExpr(node) { // returns variable number
		if (node === null)
			return null
		switch (node.type) {
			case 'ThisExpression':
				return THIS
			case 'ArrayExpression':
				var r = newVar()
				addStmt({
					type: 'create-array',
					elements: node.elements.map(visitExpr),
					dst: r
				})
				return r
			case 'ObjectExpression':
				var r = newVar()
				addStmt({
					type: 'create-object',
					properties: node.properties.map(function(prty) {
						return {
							key: prty.key.type === 'Literal' ? String(prty.key.value) : prty.key.name,
							kind: prty.kind,
							value: visitExpr(prty.value)
						}
					}),
					dst: r
				})
				return r
			case 'FunctionExpression':
				var r = newVar()
				addStmt({
					type: 'create-function',
					function: node.$function_id,
					dst: r
				})
				return r
			case 'SequenceExpression':
				var rs = node.expressions.map(visitExpr)
				return rs[rs.length-1]
			case 'UnaryExpression':
				var r = newVar()
				addStmt({
					type: 'unary',
					operator: node.operator,
					argument: visitExpr(node.argument),
					dst: r
				})
				return r
			case 'BinaryExpression':
				var r = newVar()
				addStmt({
					type: 'binary',
					operator: node.operator,
					left: visitExpr(node.left),
					right: visitExpr(node.right),
					dst: r
				})
				return r
			case 'AssignmentExpression':
				var lv = visitLvalue(node.left)
				var rv = visitExpr(node.right)
				if (node.operator === '=') {
					return lv.write(rv)
				} else {
					return lv.readWrite(function(r) {
						addStmt({
							type: 'binary',
							operator: node.operator.substring(0, node.operator.length-1),
							left: r,
							right: rv,
							dst: r
						})
					})
				}
				throw new Error("AssignmentExpression")
			case 'UpdateExpression':
				var lv = visitLvalue(node.argument)
				if (node.prefix) {
					return lv.readWrite(function(r) {
						addStmt({
							type: 'unary',
							operator: node.operator,
							argument: r,
							dst: r
						})
					})
				} else {
					var r = lv.readCopy()
					lv.write(function(t) {
						addStmt({
							type: 'unary',
							operator: node.operator,
							argument: r,
							dst: t
						})
					})
					return r
				}
			case 'LogicalExpression':
				var r = newVar()
				var cnd = visitCondition(node.left, KEEP_VALUE)
				switch (node.operator) {
					case '&&':
						setBlock(cnd.whenTrue.block)
						addStmt({
							type: 'assign',
							src: visitExpr(node.right),
							dst: r
						})
						setBlock(cnd.whenFalse.block)
						addStmt({
							type: 'assign',
							src: cnd.whenFalse.result,
							dst: r
						})
						break;
					case '||':
						setBlock(cnd.whenFalse.block)
						addStmt({
							type: 'assign',
							src: visitExpr(node.right),
							dst: r
						})
						setBlock(cnd.whenTrue.block)
						addStmt({
							type: 'assign',
							src: cnd.whenTrue.result,
							dst: r
						})
						break;
				}
				var b = newBlock()
				setBlock(b)
				blocks[cnd.whenTrue.block].jump = {type: 'goto', target: b}
				blocks[cnd.whenFalse.block].jump = {type: 'goto', target: b}
				return r
			case 'ConditionalExpression':
				var cnd = visitCondition(node.test, DISCARD_VALUE)
				var r = newVar()
				setBlock(cnd.whenTrue.block)
				addStmt({
					type: 'assign',
					src: visitExpr(node.consequent),
					dst: r
				})
				setBlock(cnd.whenFalse.block)
				addStmt({
					type: 'assign',
					src: visitExpr(node.alternate),
					dst: r
				})
				var b = newBlock()
				setBlock(b)
				blocks[cnd.whenTrue.block].jump = {type: 'goto', target: b}
				blocks[cnd.whenFalse.block].jump = {type: 'goto', target: b}
				return r
			case 'NewExpression':
				var c = visitExpr(node.callee)
				var args = node.arguments.map(visitExpr)
				var r = newVar()
				addStmt({
					type: 'call-constructor',
					function: c,
					arguments: args,
					dst: r
				})
				return r
			case 'CallExpression':
				var r = newVar()
				if (node.callee.type === 'MemberExpression') {
					var object = visitExpr(node.callee.object)
					var prty = node.callee.computed ? visitExpr(node.callee.property) : node.callee.property.name
					var args = node.arguments.map(visitExpr)
					addStmt({
						type: 'call-method',
						object: object,
						prty: prty,
						arguments: args,
						dst: r
					})
					return r
				} else {
					var c = visitExpr(node.callee)
					var args = node.arguments.map(visitExpr)
					addStmt({
						type: 'call-function',
						function: c,
						arguments: args,
						dst: r
					})
					return r
				}
			case 'MemberExpression':
				var r = newVar()
				addStmt({
					type: 'load',
					object: visitExpr(node.object),
					prty: node.computed ? visitExpr(node.property) : node.property.name,
					dst: r
				})
				return r
			case 'Identifier':
				var r = newVar()
				addStmt({
					type: 'read-var',
					var: node.name,
					dst: r
				})
				return r
			case 'Literal':
				var r = newVar()
				addStmt({
					type: 'const',
					value: node.value,
					dst: r
				})
				return r
			default:
				throw new Error("Unrecognized expression type: " + node.type)
		}
	}
	// x++
	// lv.read(function(in) { lv.write(function(out) { addStmt({type: 'unary', argument: in, dst: out }) }) })
	function visitLvalue(node) {
		switch (node.type) {
			case 'Identifier':
				return {
					readCopy: function() {
						return this.read.apply(arguments)
					},
					read: function(f) {
						var r = newVar()
						addStmt({
							type: 'read-var',
							var: node.name,
							dst: r
						})
						if (f) { 
							f(r) 
						}
						return r
					},
					write: function(f) {
						if (typeof f === 'function') {
							var r = newVar()
							f(r)
							addStmt({
								type: 'write-var',
								var: node.name,
								src: r
							})
							return r
						} else {
							addStmt({
								type: 'write-var',
								var: node.name,
								src: f
							})
							return f
						}
					},
					readWrite: function(f) {
						var r = newVar()
						addStmt({
							type: 'read-var',
							var: node.name,
							dst: r
						})
						f(r)
						addStmt({
							type: 'write-var',
							var: node.name,
							src: r
						})
						return r
					}
				}
			case 'MemberExpression':
				var obj = visitExpr(node.object)
				var prty = node.computed ? visitExpr(node.property) : node.property.name
				return {
					readCopy: function() {
						return this.read.apply(arguments)
					},
					read: function(f) {
						var r = newVar()
						addStmt({
							type: 'load',
							object: obj,
							prty: prty,
							dst: r
						})
						if (f) {
							f(r)
						}
						return r
					},
					write: function(f) {
						if (typeof f === 'function') {
							var r = newVar()
							f(r)
							addStmt({
								type: 'store',
								object: obj,
								prty: prty,
								src: r
							})
							return r
						} else {
							addStmt({
								type: 'store',
								object: obj,
								prty: prty,
								src: f
							})
							return f
						}
					},
					readWrite: function(f) {
						var r = newVar()
						addStmt({
							type: 'load',
							object: obj,
							prty: prty,
							dst: r
						})
						f(r)
						addStmt({
							type: 'store',
							object: obj,
							prty: prty,
							src: r
						})
						return r
					}
				}
			default: throw new Error("Unrecognized lvalue type: " + node.type)
		}
	}
	// { whenTrue: {block:number, result:number}, whenFalse: ... }
	var DISCARD_VALUE = false
	var KEEP_VALUE = true
	function visitCondition(node, needValue) {
		function fallbackCondition() {
			var jump = block.jump = { 
				type: 'if',
				condition: visitExpr(node),
				then: newBlock(),
				else: newBlock()
			}
			return {
				whenTrue: { block: jump.then, result: jump.condition },
				whenFalse: { block: jump.else, result: jump.condition }
			}
		}
		switch (node.type) {
			case 'Literal':
				var r = visitExpr(node)
				var b = newBlock()
				return {
					whenTrue: { block: node.value ? block_idx : b, value: r },
					whenFalse: { block: node.value ? b : block_idx, value: r }
				}

			case 'LogicalExpression':
				var cnd = visitCondition(node.left, needValue)
				var b = newBlock()
				var t = needValue ? newVar() : null
				switch (node.operator) {
					case '&&':
						setBlock(cnd.whenFalse.block)
						if (needValue) {
							addStmt({
								type: 'assign',
								src: cnd.whenFalse.result,
								dst: t
							})
						}
						block.jump = { type: 'goto', target: b }

						setBlock(cnd.whenTrue.block)
						var cnd2 = visitCondition(node.right, needValue)

						setBlock(cnd2.whenFalse.block)
						if (needValue) {
							addStmt({
								type: 'assign',
								src: cnd.whenFalse.result,
								dst: t
							})
						}
						block.jump = { type: 'goto', target: b }

						return {
							whenTrue: cnd2.whenTrue,
							whenFalse: { block: b, result: t }
						}
					case '||':
						setBlock(cnd.whenTrue.block)
						if (needValue) {
							addStmt({
								type: 'assign',
								src: cnd.whenTrue.result,
								dst: t
							})
						}
						block.jump = { type: 'goto', target: b }

						setBlock(cnd.whenFalse.block)
						var cnd2 = visitCondition(node.right, needValue)

						setBlock(cnd2.whenTrue.block)
						if (needValue) {
							addStmt({
								type: 'assign',
								src: cnd.whenTrue.result,
								dst: t
							})
						}
						block.jump = { type: 'goto', target: b }

						return {
							whenTrue: { block: b, result: t },
							whenFalse: cnd2.whenFalse
						}
				}
				throw new Error("LogicalExpression")

			case 'ConditionalExpression':
				var bT = newBlock(), bF = newBlock()
				var rT = needValue ? newVar() : null;
				var rF = needValue ? newVar() : null;
				var cnd = visitCondition(node.test, DISCARD_VALUE)
				setBlock(cnd.whenTrue.block)
				var cndT = visitCondition(node.consequent, needValue)
				setBlock(cnd.whenFalse.block)
				var cndF = visitCondition(node.alternate, needValue)

				setBlock(cndT.whenTrue)
				if (needValue) {
					addStmt({ type: 'assign', src: cndT.whenTrue.result, dst: rT })
				}
				block.jump = { type: 'goto', target: bT }

				setBlock(cndF.whenTrue)
				if (needValue) {
					addStmt({ type: 'assign', src: cndF.whenTrue.result, dst: rT })
				}
				block.jump = { type: 'goto', target: bT }

				setBlock(cndT.whenFalse)
				if (needValue) {
					addStmt({ type: 'assign', src: cndT.whenFalse.result, dst: rF })
				}
				block.jump = { type: 'goto', target: bF }

				setBlock(cndF.whenFalse)
				if (needValue) {
					addStmt({ type: 'assign', src: cndF.whenFalse.result, dst: rF })
				}
				block.jump = { type: 'goto', target: bF }

				return {
					whenTrue: { block: bT, result: rT },
					whenFalse: { block: bF, result: rF }
				}
				
			case 'AssignmentExpression':
				if (node.operator !== '=') {
					return fallbackCondition()
				}
				var lv = visitLvalue(node.left)
				var cnd = visitCondition(node.right, KEEP_VALUE)
				setBlock(cnd.whenTrue.block)
				lv.write(cnd.whenTrue.result)
				setBlock(cnd.whenFalse.block)
				lv.write(cnd.whenFalse.result)
				return cnd

			case 'UnaryExpression':
				switch (node.operator) {
					case '!':
						var r = needValue ? newVar() : null
						var cnd = visitCondition(node.argument, DISCARD_VALUE)
						setBlock(cnd.whenTrue.block)
						if (needValue) {
							addStmt({
								type: 'const',
								value: false,
								dst: r
							})
						}
						setBlock(cnd.whenFalse.block)
						if (needValue) {
							addStmt({
								type: 'const',
								value: true,
								dst: r
							})
						}
						return {
							whenTrue: { block: cnd.whenFalse.block, result: r },
							whenFalse: { block: cnd.whenTrue.block, result: r },
						}
					default:
						return fallbackCondition()
				}

			case 'SequenceExpression':
				for (var i=0; i<node.expressions.length-1; i++) {
					visitExpr(node.expressions[i])
				}
				return visitCondition(node.expressions[node.expressions.length-1], needValue)

			case 'NewExpression': // nothing to do
			case 'CallExpression':
			case 'BinaryExpression':
			case 'UpdateExpression': 
			case 'MemberExpression':
				return fallbackCondition()

			case 'ThisExpression': // always true
			case 'ArrayExpression':
			case 'ObjectExpression':
			case 'FunctionExpression':
				var r = visitExpr(node)
				var b = newBlock()
				block.jump = { type: 'goto', target: b }
				return {
					whenTrue: { block: b, result: r },
					whenFalse: { block: newBlock(), result: r }
				}
		}
		throw new Error("visitCondition " + util.inspect(node))
	}
}

function convert(ast) {
	prepareAST(ast)
	var functions = []
	ast.$id2function.forEach(function (fun) {
		var f;
		try {
			f = convertFunction(fun)
		} catch (e) {
			// TODO: also reject functions that are lexically nested inside a `with` statement
			if (e instanceof UnsupportedFeature)
				f = null
			else
				throw e
		}
		functions.push(f)
	})
	return functions
}

function escapeLabel(lbl) {
	return lbl.replace(/[{}"<>]/g, '\\$&').replace(/\t/g,'\\t').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\f/g,'\\f')
}

function toDot(cfg) {
	var next_node = 0
	var chunks = []
	function node() {
		return next_node++
	}
	function println() {
		for (var i=0; i<arguments.length; i++) {
			chunks.push(String(arguments[i]))
		}
		chunks.push('\n')
	}
 	function prtyInitializerToString(prty) {
 		var prefix = prty.kind === 'init' ? '' : (prty.kind + ' ')
 		return prefix + prty.key + ': v' + prty.value
 	}
 	function prtyRef(prty) {
 		return typeof prty === 'string' ? ('.' + prty) : ('[v' + prty + ']')
 	}
 	function varToString(elm) {
 		if (elm === null) 
 			return 'null'
 		else
 			return 'v' + elm
 	}
	function stmtToString(stmt) {
		switch (stmt.type) {
			case 'read-var':
				return 'v' + stmt.dst + ' = (' + stmt.var + ')'
			case 'write-var':
				return '(' + stmt.var + ') = v' + stmt.src
			case 'assign':
				return 'v' + stmt.dst + ' = v' + stmt.src
			case 'load':
				return 'v' + stmt.dst + ' = v' + stmt.object + prtyRef(stmt.prty)
			case 'store':
				return 'v' + stmt.object + prtyRef(stmt.prty) + ' = v' + stmt.src
			case 'const':
				return 'v' + stmt.dst + ' = value(' + util.inspect(stmt.value) + ')'
			case 'create-object':
				return 'v' + stmt.dst + ' = {' + stmt.properties.map(prtyInitializerToString).join('\n') + '}'
			case 'create-array':
				return 'v' + stmt.dst + ' = [' + stmt.elements.map(varToString).join(', ') + ']'
			case 'create-function':
				return 'v' + stmt.dst + ' = function(' + stmt.function + ')'
			case 'call-method':
				return 'v' + stmt.dst + ' = v' + stmt.object + prtyRef(stmt.prty) + '(' + stmt.arguments.map(varToString).join(', ') + ')'
			case 'call-function':
				return 'v' + stmt.dst + ' = v' + stmt.function + '(' + stmt.arguments.map(varToString).join(', ') + ')'
			case 'call-constructor':
				return 'v' + stmt.dst + ' = new v' + stmt.function + '(' + stmt.arguments.map(varToString).join(', ') + ')'
			case 'unary':
				return 'v' + stmt.dst + ' = ' + stmt.operator + 'v' + stmt.argument
			case 'binary':
				return 'v' + stmt.dst + ' = v' + stmt.left + ' ' + stmt.operator + ' v' + stmt.right
			default:
				return util.inspect(stmt)
		}
	}
	function convertFunction(f) {
		if (f === null)
			return
		var block2id = new Map
		function blockId(b) {
			if (block2id.has(b))
				return block2id.get(b)
			var id = node()
			block2id.put(b,id)
			return id
		}
		f.blocks.forEach(function(b, bn) {
			var labels = b.statements.map(function (stmt) {
				return "{" + escapeLabel(stmtToString(stmt)) + "}"
			})
			var successors = []
			switch (b.jump.type) {
				case 'goto':
					successors.push({target:b.jump.target,  port:"s"})
					labels.push("{goto}")
					break;
				case 'if':
					successors.push({target:b.jump.then, port:"then:s"})
					successors.push({target:b.jump.else, port:"else:s"})
					labels.push("{if v" + b.jump.condition + "}|{<then>then|<else>else}")
					break;
				default:
					if (b.jump.value !== null)
						labels.push("{" + b.jump.type + " " + b.jump.value + "}")
					else
						labels.push("{" + b.jump.type + "}")
			}
			println("  ", blockId(bn), ' [shape=record,label="{', labels.join('|'), '}"]')
			successors.forEach(function(sc) {
				println("  ", blockId(bn), " -> ", blockId(sc.target), ' [headport=n,tailport="', sc.port, '"]')
			})
		})
	}
	println("digraph {")
	cfg.forEach(convertFunction)
	println("}")
	return chunks.join('')
}

// -----------------------
// 		   MAIN
// -----------------------

function main() {
	var fs = require('fs')
	var program = require('commander')

	program.usage("FILE.js [options]")
	program.option('--dot', 'Output as Graphviz dot')
	program.option('--pretty', 'Output as pretty JSON (not real JSON)')
	program.parse(process.argv)

	if (program.args.length < 1)
		program.help()

	var file = program.args[0]
	var text = fs.readFileSync(file, 'utf8')
	var ast = esprima.parse(text)
	var cfg = convert(ast)

	if (program.dot) {
		console.log(toDot(cfg))
	} else if (program.pretty) {
		console.log(util.inspect(cfg, {depth:null}))
	} else {
		console.log(JSON.stringify(cfg))
	}
}

if (require.main === module) {
	main();
}