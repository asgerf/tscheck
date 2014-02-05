#!/usr/bin/env node
// Control-flow graph for JavaScript
var esprima = require('esprima')
var jsnorm = require('./jsnorm')
var util = require('util')
var Map = require('./map')
require('sugar')

//////////// AST INSTRUMENTATION /////////////////

// TODO: regular expressions, delete operator

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

function prepareAST(ast) {
	jsnorm(ast)
	injectParentPointers(ast)
	injectEnvs(ast)
	numberSourceFileFunctions(ast)
	markClosureVariables(ast)
}


////////// TRANSLATION TO CONTROL FLOW GRAPH //////////

function UnsupportedFeature() {}

function convertFunction(f) {
	var THIS = 0 // variable holding 'this'
	var THIS_FN = 1 // variable holding function instance
	var ARGUMENTS_ARRAY = 2
	var blocks = []; // Block[]
	var block = null; // number
	var block_idx = -1;
	var label2block = {} // string -> number
	var next_var = 3;
	var locals = new Map

	// decl_block contains parameter initialization and function declarations (added during AST walk)
	var decl_block = newBlock()
	var body_block = newBlock()
	
	function run() {
		setBlock(decl_block)
		// initialize self-reference
		if (f.type === 'FunctionExpression' && f.id) {
			if (f.$locals.has(f.id.name)) {
				locals.put(f.id.name, THIS_FN)
			} else {
				addStmt({
					type: 'write-var',
					var: f.id.name,
					src: THIS_FN
				})
			}
		}
		// initialize reference to arguments array
		locals.put("arguments", ARGUMENTS_ARRAY)
		// initialize parameters
		var params = f.params || []
		for (var i=0; i<params.length; i++) {
			var v = newVar()
			if (f.$locals.has(params[i].name)) {
				locals.put(params[i].name, v)
			} else {
				addStmt({
					type: 'write-var',
					var: f.params[i].name,
					src: v
				})
			}
		}
		f.$locals.forEach(function(name) {
			if (!locals.has(name)) {
				locals.put(name, newVar())
			}
		})
		block.jump = {type: 'goto', target: body_block}

		setBlock(body_block)

		if (f.type === 'Program') {
			f.body.forEach(visitStmt)
		} else {
			visitStmt(f.body)
		}

		block.jump = { type: 'return', value: null, implicit: true }

		return {
			num_parameters: params.length,
			variables: f.$env.keys().filter(function(v) {return !locals.has(v)}),
			blocks: blocks
		}
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
				visitExpr(node.expression, ANYWHERE);
				break;
			case 'IfStatement':
				var cnd = visitCondition(node.test, null)
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
				var r = node.argument ? visitExpr(node.argument, ANYWHERE) : null;
				block.jump = { type: 'return', value: r, implicit: false }
				setBlock(newBlock())
				break;
			case 'ThrowStatement':
				var r = visitExpr(node.argument, ANYWHERE)
				block.jump = { type: 'throw', value: r }
				setBlock(newBlock())
				break;
			case 'TryStatement':
				throw new UnsupportedFeature
			case 'WhileStatement':
				var entry = newBlock();
				block.jump = { type: 'goto', target: entry }
				setBlock(entry)
				var c = visitExpr(node.test, ANYWHERE)
				var jump = block.jump = {
					type: 'if',
					condition: c,
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
				var c = visitExpr(node.test, ANYWHERE)
				var jump = block.jump = {
					type: 'if',
					condition: c,
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
				if (locals.has(node.id.name)) {
					var v = locals.get(node.id.name)
					addStmt({
						type: 'create-function',
						function: node.$function_id,
						dst: v
					})
				} else {
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
				}
				block = old
				break;
			case 'VariableDeclaration':
				node.declarations.forEach(function(d) {
					if (d.init) {
						var lv = visitLvalue(d.id)
						visitExpr(d.init, lv)
					}
				})
				break;
			default:
				throw new Error("Unexpected statement type: " + node.type)
		}
	}
	var ANYWHERE = {
		write: function(f) {
			if (typeof f === 'function') {
				var r = newVar()
				f(r)
				return r
			} else {
				return f
			}
		}
	}
	function varDst(v) {
		return {
			write: function(f) {
				if (typeof f === 'function') {
					f(v)
				} else {
					addStmt({
						type: 'assign',
						src: f,
						dst: v
					})
				}
				return v
			}
		}
	}
	function visitExprAnywhere(node) {
		return visitExpr(node, ANYWHERE)
	}
	function visitExpr(node, dst) { // returns variable number
		if (node === null)
			return null
		switch (node.type) {
			case 'ThisExpression':
				return dst.write(THIS)
			case 'ArrayExpression':
				return dst.write(function(r) {
					addStmt({
						type: 'create-array',
						elements: node.elements.map(visitExprAnywhere),
						dst: r
					})
				})
			case 'ObjectExpression':
				return dst.write(function(r) {
					var name2prty = new Map
					var properties = []
					node.properties.forEach(function(prty) {
						var name = prty.key.type === 'Literal' ? String(prty.key.value) : prty.key.name
						var v = visitExpr(prty.value, ANYWHERE)
						if (prty.kind === 'init') {
							properties.push({
								type: 'value',
								name: name,
								value: v
							})
						} else {
							var cprop = name2prty.get(name)
							if (!cprop) {
								cprop = {
									type: 'accessor',
									name: name,
									get: null,
									set: null
								}
								name2prty.put(name, cprop)
								properties.push(cprop)
							}
							if (prty.kind === 'get') {
								cprop.get = v
							} else {
								cprop.set = v
							}
						}
					})
					addStmt({
						type: 'create-object',
						properties: properties,
						dst: r
					})
				})
			case 'FunctionExpression':
				return dst.write(function(r) {
					addStmt({
						type: 'create-function',
						function: node.$function_id,
						dst: r
					})
				})
			case 'SequenceExpression':
				for (var i=0; i<node.expressions.length-1; i++) {
					visitExpr(node.expressions[i], ANYWHERE)
				}
				return visitExpr(node.expressions[node.expressions.length-1], dst)
			case 'UnaryExpression':
				return dst.write(function(r) {
					addStmt({
						type: 'unary',
						operator: node.operator,
						argument: visitExpr(node.argument, ANYWHERE),
						dst: r
					})	
				})
			case 'BinaryExpression':
				return dst.write(function(r) {
					addStmt({
						type: 'binary',
						operator: node.operator,
						left: visitExpr(node.left, ANYWHERE),
						right: visitExpr(node.right, ANYWHERE),
						dst: r
					})
				})
			case 'AssignmentExpression':
				var lv = visitLvalue(node.left)
				if (node.operator === '=') {
					var r = visitExpr(node.right, lv)
					return dst.write(r)
				} else {
					var rv = visitExpr(node.right, ANYWHERE)
					var r = lv.readWrite(function(r) {
						addStmt({
							type: 'binary',
							operator: node.operator.substring(0, node.operator.length-1),
							left: r,
							right: rv,
							dst: r
						})
					})
					return dst.write(r)
				}
				throw new Error("AssignmentExpression")
			case 'UpdateExpression':
				var lv = visitLvalue(node.argument)
				if (node.prefix || node.$parent.type === 'ExpressionStatement') {
					var r = lv.readWrite(function(r) {
						addStmt({
							type: 'unary',
							operator: node.operator,
							argument: r,
							dst: r
						})
					})
					return dst.write(r)
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
					return dst.write(r)
				}
			case 'LogicalExpression':
				return dst.write(function(r) {
					var b = newBlock()
					var cnd = visitCondition(node.left, r)
					switch (node.operator) {
						case '&&':
							setBlock(cnd.whenTrue.block)
							visitExpr(node.right, varDst(r))
							block.jump = {type: 'goto', target: b}

							setBlock(cnd.whenFalse.block)
							block.jump = {type: 'goto', target: b}
							break;
						case '||':
							setBlock(cnd.whenFalse.block)
							visitExpr(node.right, varDst(r))
							block.jump = {type: 'goto', target: b}

							setBlock(cnd.whenTrue.block)
							block.jump = {type: 'goto', target: b}
							break;
					}
					setBlock(b)
				})
			case 'ConditionalExpression':
				var cnd = visitCondition(node.test, null)
				return dst.write(function(r) {
					var b = newBlock()
					
					setBlock(cnd.whenTrue.block)
					visitExpr(node.consequent, varDst(r))
					block.jump = {type: 'goto', target: b}

					setBlock(cnd.whenFalse.block)
					visitExpr(node.alternate, varDst(r))
					block.jump = {type: 'goto', target: b}

					setBlock(b)
				})
			case 'NewExpression':
				var c = visitExpr(node.callee, ANYWHERE)
				var args = node.arguments.map(visitExprAnywhere)
				return dst.write(function(r) {
					addStmt({
						type: 'call-constructor',
						function: c,
						arguments: args,
						dst: r
					})
				})
			case 'CallExpression':
				if (node.callee.type === 'MemberExpression') {
					return dst.write(function(r) {
						var object = visitExpr(node.callee.object, ANYWHERE)
						var prty = node.callee.computed ? visitExpr(node.callee.property, ANYWHERE) : node.callee.property.name
						var args = node.arguments.map(visitExprAnywhere)
						addStmt({
							type: 'call-method',
							object: object,
							prty: prty,
							arguments: args,
							dst: r
						})
					})
				} else {
					var c = visitExpr(node.callee, ANYWHERE)
					var args = node.arguments.map(visitExprAnywhere)
					return dst.write(function(r) {
						addStmt({
							type: 'call-function',
							function: c,
							arguments: args,
							dst: r
						})
					})
				}
			case 'MemberExpression':
				return dst.write(function(r) {
					addStmt({
						type: 'load',
						object: visitExpr(node.object, ANYWHERE),
						prty: node.computed ? visitExpr(node.property, ANYWHERE) : node.property.name,
						dst: r
					})
				})
			case 'Identifier':
				if (locals.has(node.name)) {
					return dst.write(locals.get(node.name))
				} else {
					return dst.write(function(r) {
						addStmt({
							type: 'read-var',
							var: node.name,
							dst: r
						})
					})
				}
			case 'Literal':
				return dst.write(function(r) {
					addStmt({
						type: 'const',
						value: node.value,
						dst: r
					})	
				})
			default:
				throw new Error("Unrecognized expression type: " + node.type)
		}
	}
	// x++
	// lv.read(function(in) { lv.write(function(out) { addStmt({type: 'unary', argument: in, dst: out }) }) })
	function visitLvalue(node) {
		switch (node.type) {
			case 'Identifier':
				if (!locals.has(node.name)) {
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
				} else {
					return {
						readCopy: function(f) {
							var r = locals.get(node.name)
							var t = newVar()
							addStmt({
								type: 'assign',
								src: r,
								dst: t
							})
							if (f) {
								f(t)
							}
							return t
						},
						read: function(f) {
							var r = locals.get(node.name)
							if (f) {
								f(r)
							}
							return r
						},
						write: function(f) {
							var r = locals.get(node.name)
							if (typeof f === 'function') {
								f(r)
							} else {
								addStmt({
									type: 'assign',
									src: f,
									dst: r
								})
							}
							return r
						},
						readWrite: function(f) {
							var r = locals.get(node.name)
							f(r)
							return r
						}
					}
				}
			case 'MemberExpression':
				var obj = visitExpr(node.object, ANYWHERE)
				var prty = node.computed ? visitExpr(node.property, ANYWHERE) : node.property.name
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
	// { whenTrue: {block:number}, whenFalse: ... }
	var DISCARD_VALUE = false
	var KEEP_VALUE = true
	function visitCondition(node, resultVar) {
		function fallbackCondition() {
			var r = visitExpr(node, resultVar === null ? ANYWHERE : varDst(resultVar))
			var jump = block.jump = { 
				type: 'if',
				condition: r,
				then: newBlock(),
				else: newBlock()
			}
			return {
				whenTrue: { block: jump.then },
				whenFalse: { block: jump.else }
			}
		}
		switch (node.type) {
			case 'Literal':
				var r = visitExpr(node, resultVar === null ? ANYWHERE : varDst(resultVar))
				var b = newBlock()
				return {
					whenTrue: { block: node.value ? block_idx : b },
					whenFalse: { block: node.value ? b : block_idx }
				}

			case 'LogicalExpression':
				var cnd = visitCondition(node.left, resultVar)
				var b = newBlock()
				switch (node.operator) {
					case '&&':
						setBlock(cnd.whenFalse.block)
						block.jump = { type: 'goto', target: b }

						setBlock(cnd.whenTrue.block)
						var cnd2 = visitCondition(node.right, resultVar)

						setBlock(cnd2.whenFalse.block)
						block.jump = { type: 'goto', target: b }

						return {
							whenTrue: cnd2.whenTrue,
							whenFalse: { block: b }
						}
					case '||':
						setBlock(cnd.whenTrue.block)
						block.jump = { type: 'goto', target: b }

						setBlock(cnd.whenFalse.block)
						var cnd2 = visitCondition(node.right, resultVar)

						setBlock(cnd2.whenTrue.block)
						block.jump = { type: 'goto', target: b }

						return {
							whenTrue: { block: b },
							whenFalse: cnd2.whenFalse
						}
				}
				throw new Error("LogicalExpression")

			case 'ConditionalExpression':
				var bT = newBlock(), bF = newBlock()
				var cnd = visitCondition(node.test, null)
				setBlock(cnd.whenTrue.block)
				var cndT = visitCondition(node.consequent, resultVar)
				setBlock(cnd.whenFalse.block)
				var cndF = visitCondition(node.alternate, resultVar)

				setBlock(cndT.whenTrue)
				block.jump = { type: 'goto', target: bT }

				setBlock(cndF.whenTrue)
				block.jump = { type: 'goto', target: bT }

				setBlock(cndT.whenFalse)
				block.jump = { type: 'goto', target: bF }

				setBlock(cndF.whenFalse)
				block.jump = { type: 'goto', target: bF }

				return {
					whenTrue: { block: bT },
					whenFalse: { block: bF }
				}
				
			case 'AssignmentExpression':
				if (node.operator !== '=') {
					return fallbackCondition()
				}
				var lv = visitLvalue(node.left)
				var cnd = visitCondition(node.right, resultVar)

				setBlock(cnd.whenTrue.block)
				lv.write(resultVar)
				var bT = block_idx

				setBlock(cnd.whenFalse.block)
				lv.write(resultVar)
				var bF = block_idx

				return {
					whenTrue: bT,
					whenFalse: bF
				}

			case 'UnaryExpression':
				switch (node.operator) {
					case '!':
						var cnd = visitCondition(node.argument, null)
						if (resultVar !== null) {
							setBlock(cnd.whenTrue.block)
							addStmt({
								type: 'const',
								value: false,
								dst: resultVar
							})
						}
						if (resultVar !== null) {
							setBlock(cnd.whenFalse.block)
							addStmt({
								type: 'const',
								value: true,
								dst: resultVar
							})
						}
						return {
							whenTrue: { block: cnd.whenFalse.block },
							whenFalse: { block: cnd.whenTrue.block },
						}
					default:
						return fallbackCondition()
				}

			case 'SequenceExpression':
				for (var i=0; i<node.expressions.length-1; i++) {
					visitExpr(node.expressions[i], ANYWHERE)
				}
				return visitCondition(node.expressions[node.expressions.length-1], resultVar)

			case 'NewExpression': // nothing to do
			case 'CallExpression':
			case 'BinaryExpression':
			case 'UpdateExpression': 
			case 'MemberExpression':
			case 'Identifier':
				return fallbackCondition()

			case 'ThisExpression': // always true
			case 'ArrayExpression':
			case 'ObjectExpression':
			case 'FunctionExpression':
				var r = visitExpr(node, ANYWHERE)
				var b = newBlock()
				block.jump = { type: 'goto', target: b }
				return {
					whenTrue: { block: b, result: r },
					whenFalse: { block: newBlock(), result: r }
				}
		}
		throw new Error("visitCondition " + util.inspect(node))
	}
	return run()
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
				f = {
					num_parameters: fun.params.length,
					variables: fun.$env.keys(),
					blocks: null
				}
			else
				throw e
		}
		functions.push(f)
	})
	return functions
}


// -----------------------------------
// 		   SHORT-CUTTING GOTOS 
// -----------------------------------

function shortcutGotos(f) {
	if (!f.blocks)
		return
	function getDst(bi) {
		var b = f.blocks[bi]
		if (b.$visiting) {
			return bi
		}
		var result = bi;
		if (b.jump.type === 'goto' && b.statements.length === 0) {
			result = b.jump.target = getDst(b.jump.target)
		}
		delete b.$visiting
		return result
	}
	function shortcut(bi) {
		var b = f.blocks[bi]
		switch (b.jump.type) {
			case 'goto':
				b.jump.target = getDst(b.jump.target)
				break;
			case 'if':
				b.jump.then = getDst(b.jump.then)
				b.jump.else = getDst(b.jump.else)
				break;
		}
	}
	for (var i=0; i<f.blocks.length; i++) {
		shortcut(i)
	}

	var bi2index = [] // old index -> new index
	var newBlocks = [] // new index -> block
	function reach(bi) {
		if (typeof bi2index[bi] === 'number') {
			return bi2index[bi]
		}
		var b = f.blocks[bi]
		var index = bi2index[bi] = newBlocks.length
		newBlocks.push(b)
		switch (b.jump.type) {
			case 'goto':
				b.jump.target = reach(b.jump.target)
				break;
			case 'if':
				b.jump.then = reach(b.jump.then)
				b.jump.else = reach(b.jump.else)
				break;
		}
		return index
	}
	reach(0)
	f.blocks = newBlocks
}

// ----------------------------
// 		   PREDECESSORS 
// ----------------------------

function computePredecessors(f) {
	if (!f.blocks)
		return
	f.blocks.forEach(function(b) {
		b.$pred = []
	})
	f.blocks.forEach(function(b, i) {
		b.$succ = []
		switch (b.jump && b.jump.type) {
			case 'if':
				b.$succ.push(b.jump.then)
				b.$succ.push(b.jump.else)
				break;
			case 'goto':
				b.$succ.push(b.jump.target)
				break;
		}
		b.$succ.forEach(function(succ) {
			f.blocks[succ].$pred.push(i)
		})
	})
}

// -----------------------
// 		   LIVENESS 
// -----------------------

function getPrtyVars(prty) {
	return typeof prty === 'number' ? [prty] : []
}

function getReadVariables(stmt) {
	switch (stmt.type) {
		case 'read-var':
			return []
		case 'write-var':
			return [stmt.src]
		case 'assign':
			return [stmt.src]
		case 'load':
			return [stmt.object].concat(getPrtyVars(stmt.prty))
		case 'store':
			return [stmt.object, stmt.src].concat(getPrtyVars(stmt.prty))
		case 'const':
			return []
		case 'create-object':
			return stmt.properties.map(function(p) {return p.value})
		case 'create-array':
			return stmt.elements.filter(function(e) {return e !== null})
		case 'create-function':
			return []
		case 'call-method':
			return [stmt.object].concat(getPrtyVars(stmt.prty)).concat(stmt.arguments)
		case 'call-function':
			return [stmt.function].concat(stmt.arguments)
		case 'call-constructor':
			return [stmt.function].concat(stmt.arguments)
		case 'unary':
			return [stmt.argument]
		case 'binary':
			return [stmt.left, stmt.right]
		default:
			throw new Error("Unrecognized statement: " + util.inspect(stmt))
	}
}

function getWrittenVariables(stmt) {
	switch (stmt.type) {
		case 'read-var':
		case 'assign':
		case 'load':
		case 'const':
		case 'create-object':
		case 'create-array':
		case 'create-function':
		case 'call-method':
		case 'call-function':
		case 'call-constructor':
		case 'unary':
		case 'binary':
			return [stmt.dst]
		case 'write-var':
		case 'store':
			return []
		default:
			throw new Error("Unrecognized statement: " + util.inspect(stmt))
	}
}

function computeLiveVariables(f) {
	if (!f.blocks)
		return
	var worklist = []
	function iterateWorklist() {
		while (worklist.length > 0) {
			var bi = worklist.pop()
			var b = f.blocks[bi]
			var live = b.$liveAfter.clone()
			switch (b.jump.type) {
				case 'return':
				case 'throw':
					if (b.jump.value !== null)
						live[b.jump.value] = true;
					break;
				case 'if':
					live[b.jump.condition] = true
					break;
			}
			for (var i=b.statements.length-1; i>=0; i--) {
				var stmt = b.statements[i]
				var kill = getWrittenVariables(stmt)
				var gen = getReadVariables(stmt)
				kill.forEach(function(v) {
					delete live[v]
				})
				gen.forEach(function(v) {
					live[v] = true
				})
			}
			if (!b.$liveBefore || live.length > b.$liveBefore.length) {
				b.$liveBefore = live
				b.$pred.forEach(function(p) {
					var pred = f.blocks[p]
					if (pred.jump.type === 'goto') {
						// handled by aliasing
						pred.$liveAfter = live
						worklist.push(p)
					} else {
						var changed = false
						live.forEach(function(x,v) {
							if (!pred.$liveAfter[v]) {
								pred.$liveAfter[v] = true
								changed = true
							}
						})
						if (changed) {
							worklist.push(p)
						}
					}
				})
			}
		}
	}
	// queue returns and throws
	f.blocks.forEach(function(b,i) {
		b.$liveAfter = []
		if (b.jump.type === 'return' || b.jump.type === 'throw')
			worklist.push(i)
	})
	iterateWorklist()
	// queue statements that cannot reach return or throw
	f.blocks.forEach(function(b,i) {
		if (!b.$liveBefore) {
			worklist.push(i)
		}
	})
	iterateWorklist()
}

// -----------------------------
//  	   SANITY CHECK
// -----------------------------

function sanityCheck(cfg) {
	cfg.forEach(checkFunction)

	function checkFunction(f, fi) {
		if (!f.blocks)
			return
		f.blocks.forEach(function(b, bi) {
			if (!b)
				console.warn("Null block at function " + fi + ", block " + bi)
			if (!b.jump)
				console.warn("Null jump at function " + fi + ", block " + bi)
		})
	}

}

// -----------------------------
//  	   GRAPHVIZ DOT
// -----------------------------

function escapeLabel(lbl) {
	return lbl.replace(/[{}"<>]/g, '\\$&').replace(/\t/g,'\\t').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\f/g,'\\f')
}

function toDot(cfg, options) {
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
	function functionToDot(f, idx) {
		if (f.blocks === null)
			return
		if (options.index !== -1 && idx !== options.index)
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
			if (options.live) {
				labels.unshift("{live: " + b.$liveBefore.map(function(x,i) {return x && "v" + i}).compact().join(", ") + "}")
			}
			var successors = []
			switch (b.jump && b.jump.type) {
				case null:
					labels.push("{null}")
					break;
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
						labels.push("{" + b.jump.type + " v" + b.jump.value + "}")
					else
						labels.push("{" + b.jump.type + "}")
			}
			// if (options.live) {
			// 	labels.push("{live: " + b.$liveAfter.map(function(x,i) {return x && "v" + i}).compact().join(", ") + "}")
			// }
			println("  ", blockId(bn), ' [shape=record,label="{', labels.join('|'), '}"]')
			successors.forEach(function(sc) {
				println("  ", blockId(bn), " -> ", blockId(sc.target), ' [headport=n,tailport="', sc.port, '"]')
			})
		})
	}
	println("digraph {")
	cfg.forEach(functionToDot)
	println("}")
	return chunks.join('')
}


// -----------------------
// 		   MAIN
// -----------------------

function jsctrl(ast) {
	var cfg = convert(ast)
	cfg.forEach(shortcutGotos)
	return cfg
}
module.exports = jsctrl

// --------------------------
// 		   ENTRY POINT
// --------------------------

function table2list(x) {
	return x.map(function(y,i) {return y && i}).compact()
}

function main() {
	var fs = require('fs')
	var program = require('commander')

	program.usage("FILE.js [options]")
	program.option('--dot', 'Output as Graphviz dot')
	program.option('--pretty', 'Output as pretty JSON (not real JSON)')
	program.option('--live', 'Include live variable information')
	program.option('--index <N>', 'Print only the Nth function (N=0 for top-level scope)', Number, -1)
	program.parse(process.argv)

	if (program.args.length < 1)
		program.help()

	var file = program.args[0]
	var text = fs.readFileSync(file, 'utf8')
	var ast = esprima.parse(text)
	var cfg = jsctrl(ast)

	sanityCheck(cfg)

	if (program.live) {
		cfg.forEach(function(f) {
			computePredecessors(f)
			computeLiveVariables(f)
		})
	}
	
	if (program.dot) {
		console.log(toDot(cfg, program))
	} else if (program.pretty) {
		if (program.live) {
			cfg.forEach(function(f) {
				f.blocks.forEach(function(b) {
					b.$liveAfter = table2list(b.$liveAfter)
					b.$liveBefore = table2list(b.$liveBefore)
				})
			})
		}
		console.log(util.inspect(cfg, {depth:null}))
	} else {
		console.log(JSON.stringify(cfg))
	}
}

if (require.main === module) {
	main();
}