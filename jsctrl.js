// Control-flow graph for JavaScript
var esprima = require('esprima')
var jsnorm = require('jsnorm')




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
 | { type: 'return', value: var | null }
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
	var blocks = [{ statements: [], jump: null }]; // Block[]
	var block = blocks[0]; // number
	var block_idx = 0
	var label2block = {} // string -> number
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
				var jump = block.jump = {
					type: 'if',
					condition: condition: visitExpr(node.test),
					then: newBlock(),
					else: newBlock()
				}
				var exit = newBlock()
				setBlock(jump.then)
				visitStmt(node.consequent)
				block.jump = {type: 'goto', target: exit}
				setBlock(jump.else)
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
				block.jump = { type: 'return', value: node.argument ? visitExpr(node.argument) : null }
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
					condition: visitExpr(node.test)
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
							key: prty.key.type === 'Literal' ? prty.key.name : String(prty.key.value),
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
				switch (lv.type) {
					case 'var':
						if (node.operator === '=') {
							addStmt({
								type: 'write-var',
								var: lv.name,
								src: rv
							})
							return rv
						} else {
							var t = newVar()
							addStmt({
								type: 'read-var',
								var: lv.name,
								dst: t
							})
							addStmt({
								type: 'binary',
								operator: node.operator.substring(0, node.operator.length-1),
								left: t,
								right: rv,
								dst: t
							})
							addStmt({
								type: 'write-var',
								var: lv.name,
								src: t
							})
							return t
						}
					case 'member':
						if (node.operator === '=') {
							addStmt({
								type: 'store',
								object: lv.object,
								prty: lv.prty,
								src: rv
							})
							return rv
						} else {
							var t = newVar()
							addStmt({
								type: 'load',
								object: lv.object,
								prty: lv.prty,
								dst: t
							})
							addStmt({
								type: 'binary',
								operator: node.operator.substring(0, node.operator.length-1),
								left: t,
								right: rv,
								dst: t
							})
							addStmt({
								type: 'store',
								object: lv.object,
								prty: lv.prty,
								src: t
							})
							return t
						}
				}
				throw new Error("AssignmentExpression")
			case 'UpdateExpression':
				var lv = visitLvalue(node.argument)
				switch (lv.type + !!node.prefix) {
					case 'var-true': // ++x
						addStmt({
							type: 'unary',
							operator: node.operator,
							argument: lv.index,
							dst: lv.index
						})
						return lv.index
					case 'var-false': // x++
						var r = newVar();
						addStmt({
							type: 'unary',
							operator: node.operator,
							argument: lv.index,
							dst: r
						})
						return r
					case 'member-true': // ++x.f
						var r = newVar()
						addStmt({
							type: 'load',
							object: lv.object,
							prty: lv.prty,
							dst: r
						})
						addStmt({
							type: 'unary',
							argument: r,
							dst: r
						})
						addStmt({
							type: 'store',
							object: lv.object,
							prty: lv.prty,
							src: r
						})
						return r
					case 'member-false': // x.f++
						var r = newVar(), t = newVar()
						addStmt({
							type: 'load',
							object: lv.object,
							prty: lv.prty,
							dst: r
						})
						addStmt({
							type: 'unary',
							argument: r,
							dst: t
						})
						addStmt({
							type: 'store',
							object: lv.object,
							prty: lv.prty,
							src: t
						})
						return r
					default: throw new Error("UpdateExpression")
				}
			case 'LogicalExpression':
				var r = newVar()
				var cnd = visitCondition(node.left)
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
				var cnd = visitCondition(node.test)
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
					arguments: args
					dst: r
				})
				return r
			case 'CallExpression':
				var r = newVar()
				if (node.callee.type === 'MemberExpression') {
					var base = visitExpr(node.callee.object)
					var prty = node.callee.computed ? visitExpr(node.callee.property) : node.callee.property.name
					var args = node.arguments.map(visitExpr)
					addStmt({
						type: 'call-method',
						base: base,
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
			default:
				throw new Error("Unrecognized expression type: " + node.type)
		}
	}
	function visitLvalue(node) {
		switch (node.type) {
			case 'Identifier':
				return {
					type: 'var',
					name: node.name
				}
			case 'MemberExpression':
				var obj = visitExpr(node.object)
				var prty = node.computed ? visitExpr(node.property) : node.property.name
				return {
					type: 'member',
					object: obj,
					prty: prty
				}
			default: throw new Error("Unrecognized lvalue type: " + node.type)
		}
	}
	// { whenTrue: {block:number, result:number}, whenFalse: ... }
	function visitCondition(node) {
		switch (node.type) {
			case 'Literal':
				var r = visitExpr(node)
				var b = newBlock()
				return {
					whenTrue: { block: node.value ? block_idx : b, value: r },
					whenFalse: { block: node.value ? b : block_idx, value: r }
				}

			case 'LogicalExpression':
				var cnd = visitCondition(node.left)
				var b = newBlock()
				var t = newVar()
				switch (node.operator) {
					case '&&':
						setBlock(cnd.whenFalse.block)
						addStmt({
							type: 'assign',
							src: cnd.whenFalse.result,
							dst: t
						})
						block.jump = { type: 'goto', target: b }

						setBlock(cnd.whenTrue.block)
						var cnd2 = visitCondition(node.right)

						setBlock(cnd2.whenFalse.block)
						addStmt({
							type: 'assign',
							src: cnd.whenFalse.result,
							dst: t
						})
						block.jump = { type: 'goto', target: b }

						return {
							whenTrue: cnd2.whenTrue,
							whenFalse: { block: b, result: t }
						}
					case '||':
						setBlock(cnd.whenTrue.block)
						addStmt({
							type: 'assign',
							src: cnd.whenTrue.result,
							dst: t
						})
						block.jump = { type: 'goto', target: b }

						setBlock(cnd.whenFalse.block)
						var cnd2 = visitCondition(node.right)

						setBlock(cnd2.whenTrue.block)
						addStmt({
							type: 'assign',
							src: cnd.whenTrue.result,
							dst: t
						})
						block.jump = { type: 'goto', target: b }

						return {
							whenTrue: { block: b, result: t },
							whenFalse: cnd2.whenFalse
						}
				}
				throw new Error("LogicalExpression")

			case 'ConditionalExpression':
				var bT = newBlock(), bF = newBlock()
				var rT = newVar(), vF = newVar()
				var cnd = visitCondition(node.test)
				setBlock(cnd.whenTrue.block)
				var cndT = visitCondition(node.consequent)
				setBlock(cnd.whenFalse.block)
				var cndF = visitCondition(node.alternate)

				setBlock(cndT.whenTrue)
				addStmt({ type: 'assign', src: cndT.whenTrue.result, dst: rT })
				block.jump = { type: 'goto', target: bT }

				setBlock(cndF.whenTrue)
				addStmt({ type: 'assign', src: cndF.whenTrue.result, dst: rT })
				block.jump = { type: 'goto', target: bT }

				setBlock(cndT.whenFalse)
				addStmt({ type: 'assign', src: cndT.whenFalse.result, dst: rF })
				block.jump = { type: 'goto', target: bF }

				setBlock(cndF.whenFalse)
				addStmt({ type: 'assign', src: cndF.whenFalse.result, dst: rF })
				block.jump = { type: 'goto', target: bF }

				return {
					whenTrue: { block: bT, result: rT },
					whenFalse: { block: bF, result: rF }
				}
				
			case 'AssignmentExpression':
			case 'UnaryExpression':
			case 'SequenceExpression':

			case 'NewExpression': // nothing to do
			case 'CallExpression':
			case 'BinaryExpression':
			case 'UpdateExpression': 
				var jump = block.jump = { 
					type: 'if',
					condition: visitExpr(node)
					then: newVar(),
					else: newVar()
				}
				return {
					whenTrue: { block: jump.then, result: jump.condition },
					whenFalse: { block: jump.else, result: jump.condition }
				}

			case 'ThisExpression': // always true
			case 'ArrayExpression':
			case 'ObjectExpression':
			case 'FunctionExpression':
				var r = visitExpr(node)
				var b = newBlock()
				block.jump = { type: 'goto', target: b }
				return {
					whenTrue: { block: b, result: r }
					whenFalse: { block: newBlock(), result: r }
				}
		}
	}
}

function convert(ast) {

}




// -----------------------
// 		   MAIN
// -----------------------

function main() {

}

if (require.main === module) {
	main();
}